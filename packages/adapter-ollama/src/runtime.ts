import type {
  AgentEffort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentToolRunOptions,
  AgentToolServer,
  AgentTurnEvent,
  WholeMediaType,
} from "@matters/core";
import { AGENT_EFFORTS, AgentRunError, wholeFilesProblem } from "@matters/core";

// A model on this machine, through the Ollama server on the loopback address (ADR 0119). The
// server is asked over HTTP with Node's own fetch; nothing else is started and no other host is
// ever named. What the server writes is read only to tell answers apart: no text of it ever goes
// into an error, which may reach logs.

export interface OllamaOptions {
  /**
   * The server, for tests: `http://127.0.0.1:<port>` and nothing else. Production passes none and
   * gets the server's own address (ADR 0119, rule 1: the address is not a setting).
   */
  readonly baseUrl?: string;
  /** For one `run`. Default 300 s: a model on this machine can be slow. */
  readonly timeoutMs?: number;
  /** For each request of `inspect` and for the look at a model before a turn. Default 5 s. */
  readonly inspectTimeoutMs?: number;
}

export const OLLAMA_ID = "ollama";
export const OLLAMA_URL = "http://127.0.0.1:11434";

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
/** Ollama's names: `qwen3:8b`, `library/x:tag`, `hf.co/user/repo:Q4_K_M`. Never a flag or a URL. */
const MODEL_NAME = /^(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 5_000;
/** What is read of an answer of the server, at most. A turn's answer is JSON for our schema. */
const MAX_CHAT_BYTES = 8 * 1024 * 1024;
/** The list of models, the version, and what the server says of one model. */
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_SHOW_BYTES = 4 * 1024 * 1024;
/** The models looked at, at most: more than anyone installs. */
const MAX_MODELS = 64;

/**
 * The context a turn asks for (ADR 0119, rule 8). The server's own default is small and it cuts a
 * longer request without saying so, so each turn names what it needs: its text at a cautious
 * three characters a token, and room for the answer, and for thinking on a model that thinks.
 */
export const CHARS_PER_TOKEN = 3;
export const MESSAGE_TOKENS = 64;
export const ANSWER_TOKENS = 4096;
export const THINKING_TOKENS = 8192;
const CONTEXT_STEP = 1024;
/** What one image is taken to cost in the context, in tokens. */
export const IMAGE_TOKENS = 1024;
/** What a model that sees images takes whole (ADR 0119, rule 10): images, never a PDF. */
export const IMAGE_TYPES: readonly WholeMediaType[] = ["image/jpeg", "image/png"];

// The loop of ADR 0083 on this runtime: our tool server's shapes, as the Claude adapter checks them.
const SERVER_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
const SERVER_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_TOOLS = 8;
/** Rounds of tool calls in one turn at most; the tool server keeps the budgets of calls itself. */
export const MAX_TOOL_ROUNDS = 32;
/** What is read of one answer of our tool server, and what of it goes back to the model. */
const MAX_TOOL_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 200_000;
const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
const MAX_TOOL_TIMEOUT_MS = 900_000;

/** A model that does not say what it takes is held to this. */
const UNKNOWN_CONTEXT = 8192;
/**
 * What our instructions, the person's standing instructions and the schema take at most, in
 * characters: held back from what a model takes when it says how much mail a turn may carry.
 */
export const RESERVED_CHARS = 12_000;

/**
 * How many characters of mail one turn on a model may carry (ADR 0119, rule 8): the same estimate
 * `contextFor` makes, backwards, less what the instructions and the schema may take.
 */
export function inputCharsOf(thinks: boolean, contextLength: number | undefined): number {
  const tokens =
    (contextLength ?? UNKNOWN_CONTEXT) -
    MESSAGE_TOKENS -
    ANSWER_TOKENS -
    (thinks ? THINKING_TOKENS : 0);
  return Math.max(0, tokens * CHARS_PER_TOKEN - RESERVED_CHARS);
}

const NOT_RUNNING = "Ollama is not running. Start it, then look again.";
const NO_MODEL = "No model is installed. Run `ollama pull <model>` in Terminal, then look again.";
const NOT_UNDERSTOOD = "Ollama gave an answer that was not understood.";

/** What the server says of one model that runs here. */
interface LocalModel {
  readonly name: string;
  readonly size: number;
  readonly levels: readonly AgentEffort[];
  readonly thinks: boolean;
  readonly contextLength: number | undefined;
  /** It can call tools (capability `tools`). */
  readonly tools: boolean;
  /** It sees images (capability `vision`). */
  readonly vision: boolean;
}

type Reply = { readonly status: number; readonly value: unknown };

class TooMuch extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An entry of the list that the server forwards to a host elsewhere (ADR 0119, rule 5). */
function isRemote(entry: Record<string, unknown>): boolean {
  const set = (v: unknown) => v !== undefined && v !== null && v !== "";
  return set(entry.remote_host) || set(entry.remote_model);
}

/**
 * The levels of a model, from the `thinking` the server lists for it (ADR 0119, rule 9): its
 * named levels that are ours by exact name. Only on and off (booleans), or other names: none.
 */
export function levelsOf(show: Record<string, unknown>): readonly AgentEffort[] {
  const thinking = show.thinking;
  if (!isRecord(thinking) || !Array.isArray(thinking.values)) return [];
  const named = new Set(thinking.values.filter((v): v is string => typeof v === "string"));
  return AGENT_EFFORTS.filter((level) => named.has(level));
}

/** Whether the model thinks when the turn says nothing about it. */
function thinksByDefault(show: Record<string, unknown>): boolean {
  const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
  if (!caps.includes("thinking")) return false;
  const thinking = show.thinking;
  // A model that lists thinking and does not say its default may think: room is kept for it.
  if (!isRecord(thinking) || !("default" in thinking)) return true;
  return thinking.default !== false;
}

function contextLengthOf(show: Record<string, unknown>): number | undefined {
  const info = show.model_info;
  if (!isRecord(info)) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

/**
 * The context to ask for, or null when the turn does not fit in what the model takes (ADR 0119,
 * rule 8). Rounded up, so that turns of about the same size ask for the same.
 */
export function contextFor(
  chars: number,
  thinks: boolean,
  contextLength: number | undefined,
): number | null {
  const need =
    Math.ceil(chars / CHARS_PER_TOKEN) +
    MESSAGE_TOKENS +
    ANSWER_TOKENS +
    (thinks ? THINKING_TOKENS : 0);
  const most = contextLength ?? UNKNOWN_CONTEXT;
  if (need > most) return null;
  return Math.min(most, Math.ceil(need / CONTEXT_STEP) * CONTEXT_STEP);
}

export class OllamaRuntime implements AgentRuntimePort {
  readonly id = OLLAMA_ID;
  readonly name = "Ollama";
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly inspectTimeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    const base = options.baseUrl ?? OLLAMA_URL;
    // Mail goes to this server: only the loopback address can be named, even in a test.
    if (!LOOPBACK_URL.test(base)) throw new Error("Ollama is only reached on 127.0.0.1");
    this.base = base;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
  }

  /**
   * What the server has (ADR 0119, rule 6): not running, no model that runs here, or models that
   * have not passed the test yet. Only models installed on this machine that complete text are
   * listed; one the server forwards elsewhere, or one that only makes embeddings, is not. Sends
   * no mail and starts no model.
   */
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = {
      id: this.id,
      name: this.name,
      noPlan: true,
      onThisMachine: true,
      turnsAtOnce: 1,
    } as const;
    try {
      const version = await this.ask("GET", "/api/version", undefined, MAX_LIST_BYTES);
      if (version.status !== 200 || !isRecord(version.value)) {
        return { ...base, models: [], status: "failed", problem: NOT_UNDERSTOOD };
      }
    } catch {
      return { ...base, models: [], status: "notRunning", problem: NOT_RUNNING };
    }
    let models: LocalModel[];
    try {
      const listed = await this.localModels();
      if (listed === null)
        return { ...base, models: [], status: "failed", problem: NOT_UNDERSTOOD };
      models = listed;
    } catch {
      return { ...base, models: [], status: "notRunning", problem: NOT_RUNNING };
    }
    if (models.length === 0) {
      return { ...base, models: [], status: "noModel", problem: NO_MODEL };
    }
    // Every kind of work starts on the largest model (rule 4); the same size goes by name.
    const largest = [...models].sort(
      (a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )[0] as LocalModel;
    return {
      ...base,
      status: "found",
      models: models.map((m) => m.name),
      modelEfforts: Object.fromEntries(models.map((m) => [m.name, [...m.levels]])),
      modelInputChars: Object.fromEntries(
        models.map((m) => [m.name, inputCharsOf(m.thinks, m.contextLength)]),
      ),
      // What each model can do with attachments (ADR 0119, rule 10).
      toolModels: models.filter((m) => m.tools).map((m) => m.name),
      modelFiles: Object.fromEntries(models.map((m) => [m.name, m.vision ? [...IMAGE_TYPES] : []])),
      defaultModel: largest.name,
    };
  }

  /**
   * Images whole, to a model that sees them (ADR 0090; ADR 0119, rule 10). A PDF, or any file to
   * another model, is refused: pages are never turned into images here (rule 11).
   */
  readonly takesFiles = true;

  async run(
    request: AgentRunRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    const { signal } = options;
    const turn = await this.prepare(request, signal);
    const messages: Message[] = [
      // Our words as the system message; the mail as the person's message, as data (ADR 0051).
      { role: "system", content: request.instructions },
      {
        role: "user",
        content: request.untrusted,
        ...(turn.images.length === 0 ? {} : { images: turn.images }),
      },
    ];
    const numCtx = this.contextOf(turn, messages, turn.schemaText.length);
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), this.timeoutMs);
    try {
      const reply = await this.chat(
        {
          model: turn.model.name,
          messages,
          format: request.schema,
          stream: false,
          ...turn.think,
          options: { num_ctx: numCtx },
        },
        signal,
        timer.signal,
      );
      return answerOf(reply, turn.model.name, numCtx);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * One turn that may call the tools of `options.server` and no others (ADR 0083; ADR 0119, rule
   * 10), on a model that takes tools. The model calls tools in rounds without the schema, since a
   * model held to the schema calls none; the results go back as tool messages, as data. When it
   * stops calling, one last turn of the same conversation answers in the schema, with no tools.
   */
  async runWithTools(
    request: AgentRunRequest,
    options: AgentToolRunOptions,
  ): Promise<AgentRunResult> {
    const { server, signal } = options;
    if (
      !SERVER_URL.test(server.url) ||
      !SERVER_TOKEN.test(server.token) ||
      server.tools.length < 1 ||
      server.tools.length > MAX_TOOLS ||
      !server.tools.every((t) => TOOL_NAME.test(t))
    ) {
      throw new AgentRunError("failed", "The tool server is not one this app made.");
    }
    if ((request.files ?? []).length > 0) {
      throw new AgentRunError("failed", "Files do not go to a turn with tools.");
    }
    const turn = await this.prepare(request, signal);
    if (!turn.model.tools) {
      throw new AgentRunError("failed", `${turn.model.name} cannot use tools.`);
    }
    const asked = options.timeoutMs;
    const limit =
      asked !== undefined && Number.isFinite(asked) && asked > 0
        ? Math.min(asked, MAX_TOOL_TIMEOUT_MS)
        : DEFAULT_TOOL_TIMEOUT_MS;
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), limit);
    const both = signal === undefined ? timer.signal : AbortSignal.any([signal, timer.signal]);
    const emit = (event: AgentTurnEvent) => {
      try {
        options.onEvent?.(event);
      } catch {
        // What the caller does with a step must not break the turn.
      }
    };
    let inputTokens = 0;
    let outputTokens = 0;
    const count = (reply: Reply) => {
      if (!isRecord(reply.value)) return;
      if (typeof reply.value.prompt_eval_count === "number")
        inputTokens += reply.value.prompt_eval_count;
      if (typeof reply.value.eval_count === "number") outputTokens += reply.value.eval_count;
    };
    try {
      const listed = await this.toolsOf(server, both).catch(() => {
        if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
        if (timer.signal.aborted) throw new AgentRunError("failed", "Ollama took too long.");
        throw new AgentRunError("failed", "The tool server did not answer.");
      });
      const toolsText = JSON.stringify(listed);
      const messages: Message[] = [
        { role: "system", content: request.instructions },
        { role: "user", content: request.untrusted },
      ];
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const numCtx = contextFor(
          charsOf(messages) + toolsText.length,
          turn.model.thinks,
          turn.model.contextLength,
        );
        // Out of room for another round: what was read so far goes to the answer.
        if (numCtx === null) break;
        const reply = await this.chat(
          {
            model: turn.model.name,
            messages,
            tools: listed,
            stream: false,
            ...turn.think,
            options: { num_ctx: numCtx },
          },
          signal,
          timer.signal,
        );
        count(reply);
        if (reply.status !== 200 || !isRecord(reply.value) || !isRecord(reply.value.message)) {
          throw new AgentRunError("failed", "Ollama reported an error.");
        }
        if (reply.value.done_reason === "length") break;
        const message = reply.value.message;
        const content = typeof message.content === "string" ? message.content : "";
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        // The round with no call is the model's own answer, which the schema turn replaces: only a
        // line written between steps is shown, as its note.
        if (calls.length === 0) break;
        if (content.trim() !== "") emit({ kind: "text", text: content });
        const asked: { name: string; input: Record<string, unknown> }[] = [];
        for (const call of calls) {
          const fn = isRecord(call) && isRecord(call.function) ? call.function : null;
          const name = fn !== null && typeof fn.name === "string" ? fn.name : "";
          if (!server.tools.includes(name)) {
            throw new AgentRunError("failed", "Ollama called a tool that was turned off.");
          }
          asked.push({ name, input: argumentsOf(fn?.arguments) });
        }
        messages.push({
          role: "assistant",
          content,
          tool_calls: asked.map((a) => ({ function: { name: a.name, arguments: a.input } })),
        });
        for (const a of asked) {
          emit({ kind: "tool", name: a.name, input: a.input });
          const result = await this.callTool(server, a.name, a.input, both).catch(() => {
            if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
            if (timer.signal.aborted) throw new AgentRunError("failed", "Ollama took too long.");
            return "The tool could not be used.";
          });
          // Mail and file text are data: a tool message, never the system message.
          messages.push({ role: "tool", tool_name: a.name, content: result });
        }
      }
      // The answer, held to the schema, from all that was read (no tools: a model held to the
      // schema calls none).
      const numCtx = contextFor(
        charsOf(messages) + turn.schemaText.length,
        turn.model.thinks,
        turn.model.contextLength,
      );
      if (numCtx === null) {
        throw new AgentRunError(
          "tooLong",
          `What was read is too long for ${turn.model.name} to answer from. Ask about less.`,
        );
      }
      const reply = await this.chat(
        {
          model: turn.model.name,
          messages,
          format: request.schema,
          stream: false,
          ...turn.think,
          options: { num_ctx: numCtx },
        },
        signal,
        timer.signal,
      );
      const answer = answerOf(reply, turn.model.name, numCtx);
      return {
        value: answer.value,
        inputTokens: inputTokens + (answer.inputTokens ?? 0),
        outputTokens: outputTokens + (answer.outputTokens ?? 0),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** What every turn checks before mail goes: the model, the effort, the files, the schema. */
  private async prepare(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
  ): Promise<{
    model: LocalModel;
    schemaText: string;
    images: string[];
    think: { think?: AgentEffort };
  }> {
    if (!MODEL_NAME.test(request.model)) throw new AgentRunError("failed", "Unknown model name.");
    if (
      request.effort !== undefined &&
      !(AGENT_EFFORTS as readonly string[]).includes(request.effort)
    ) {
      throw new AgentRunError("failed", "Unknown effort.");
    }
    let schemaText: string;
    try {
      schemaText = JSON.stringify(request.schema);
    } catch {
      throw new AgentRunError("failed", "The schema cannot be serialized.");
    }
    if (typeof schemaText !== "string") {
      throw new AgentRunError("failed", "The schema cannot be serialized.");
    }
    const files = request.files ?? [];
    if (files.some((f) => !IMAGE_TYPES.includes(f.mediaType))) {
      throw new AgentRunError("failed", "Ollama takes images whole, and no other file.");
    }
    if (files.length > 0) {
      const problem = wholeFilesProblem(files);
      if (problem !== null) throw new AgentRunError("failed", problem);
    }
    if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
    // The model is looked at again before mail goes: it must still be installed and run here.
    let model: LocalModel | null;
    try {
      model = await this.localModel(request.model, signal);
    } catch {
      if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
      throw new AgentRunError("failed", "Ollama is not running.");
    }
    if (model === null) {
      throw new AgentRunError("failed", "That model is not installed on this Mac.");
    }
    if (files.length > 0 && !model.vision) {
      throw new AgentRunError("failed", `${model.name} does not see images.`);
    }
    // Only a level the model lists is sent: the server would quietly use its own default for
    // another (ADR 0118, rule 5; ADR 0119, rule 9).
    if (request.effort !== undefined && !model.levels.includes(request.effort)) {
      throw new AgentRunError(
        "effortRefused",
        `${model.name} does not take the effort ${request.effort}. Choose another in Settings.`,
      );
    }
    return {
      model,
      schemaText,
      images: files.map((f) => Buffer.from(f.bytes).toString("base64")),
      think: request.effort === undefined ? {} : { think: request.effort },
    };
  }

  /** The context a turn asks for, or the refusal of one that cannot fit (ADR 0119, rule 8). */
  private contextOf(
    turn: { model: LocalModel; images: readonly string[] },
    messages: readonly Message[],
    extra: number,
  ): number {
    const numCtx = contextFor(
      charsOf(messages) + extra + turn.images.length * IMAGE_TOKENS * CHARS_PER_TOKEN,
      turn.model.thinks,
      turn.model.contextLength,
    );
    if (numCtx === null) {
      throw new AgentRunError(
        "tooLong",
        `This is too long for ${turn.model.name}. Choose a model that takes more, or ask about less.`,
      );
    }
    return numCtx;
  }

  /** One chat request, its failures in our words. */
  private async chat(
    body: unknown,
    signal: AbortSignal | undefined,
    timer: AbortSignal,
  ): Promise<Reply> {
    const both = signal === undefined ? timer : AbortSignal.any([signal, timer]);
    try {
      return await this.ask("POST", "/api/chat", body, MAX_CHAT_BYTES, both);
    } catch (error) {
      if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
      if (timer.aborted) throw new AgentRunError("failed", "Ollama took too long.");
      if (error instanceof TooMuch) throw new AgentRunError("failed", "Ollama wrote too much.");
      throw new AgentRunError("failed", "Ollama is not running.");
    }
  }

  /** The tools our server offers this turn, as the model is given them: only those named. */
  private async toolsOf(server: AgentToolServer, signal: AbortSignal): Promise<ToolDef[]> {
    const result = await rpc(server, 1, "tools/list", {}, signal);
    const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    const out: ToolDef[] = [];
    for (const t of list) {
      if (!isRecord(t) || typeof t.name !== "string" || !server.tools.includes(t.name)) continue;
      out.push({
        type: "function",
        function: {
          name: t.name,
          description: typeof t.description === "string" ? t.description.slice(0, 2000) : "",
          parameters: isRecord(t.inputSchema) ? t.inputSchema : { type: "object" },
        },
      });
    }
    if (out.length === 0) throw new Error("no tools");
    return out;
  }

  private nextId = 2;

  /** Calls one tool of our server; its text, bounded. An error of the tool is its own text. */
  private async callTool(
    server: AgentToolServer,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await rpc(
      server,
      this.nextId++,
      "tools/call",
      { name, arguments: input },
      signal,
    );
    if (!isRecord(result) || !Array.isArray(result.content)) return "The tool could not be used.";
    const text = result.content
      .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "text")
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n");
    return text.slice(0, MAX_TOOL_RESULT_CHARS);
  }

  /** The models that run here and complete text; null when the list is not understood. */
  private async localModels(): Promise<LocalModel[] | null> {
    const tags = await this.ask("GET", "/api/tags", undefined, MAX_LIST_BYTES);
    if (tags.status !== 200 || !isRecord(tags.value) || !Array.isArray(tags.value.models)) {
      return null;
    }
    const names: { name: string; size: number }[] = [];
    for (const entry of tags.value.models.slice(0, MAX_MODELS)) {
      if (!isRecord(entry) || isRemote(entry)) continue;
      const name = typeof entry.name === "string" ? entry.name : entry.model;
      if (typeof name !== "string" || !MODEL_NAME.test(name)) continue;
      if (names.some((n) => n.name === name)) continue;
      names.push({ name, size: typeof entry.size === "number" ? entry.size : 0 });
    }
    const shown = await Promise.all(
      names.map((n) => this.describe(n.name, n.size).catch(() => null)),
    );
    return shown.filter((m): m is LocalModel => m !== null);
  }

  /** One model that runs here, as the list and the server's look at it say, or null. */
  private async localModel(
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<LocalModel | null> {
    const tags = await this.ask("GET", "/api/tags", undefined, MAX_LIST_BYTES, signal);
    if (tags.status !== 200 || !isRecord(tags.value) || !Array.isArray(tags.value.models)) {
      return null;
    }
    const entry = tags.value.models
      .slice(0, MAX_MODELS)
      .find((e) => isRecord(e) && (e.name === name || e.model === name));
    if (!isRecord(entry) || isRemote(entry)) return null;
    return this.describe(name, typeof entry.size === "number" ? entry.size : 0, signal);
  }

  /** What the server says of a model: null when it only embeds, or is forwarded elsewhere. */
  private async describe(
    name: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<LocalModel | null> {
    const show = await this.ask("POST", "/api/show", { model: name }, MAX_SHOW_BYTES, signal);
    if (show.status !== 200 || !isRecord(show.value) || isRemote(show.value)) return null;
    const caps = Array.isArray(show.value.capabilities) ? show.value.capabilities : [];
    if (!caps.includes("completion")) return null;
    return {
      name,
      size,
      levels: levelsOf(show.value),
      thinks: thinksByDefault(show.value),
      contextLength: contextLengthOf(show.value),
      tools: caps.includes("tools"),
      vision: caps.includes("vision"),
    };
  }

  /**
   * One request to the server, its answer read up to `maxBytes`. Rejects when the server cannot
   * be reached, writes more, or the signal (default: the time for a look) ends it.
   */
  private async ask(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Reply> {
    const ownSignal = signal ?? AbortSignal.timeout(this.inspectTimeoutMs);
    const look =
      signal === undefined || path === "/api/chat"
        ? ownSignal
        : AbortSignal.any([signal, AbortSignal.timeout(this.inspectTimeoutMs)]);
    const response = await fetch(`${this.base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: look,
      // Never follow the server elsewhere.
      redirect: "error",
    });
    const text = await readCapped(response, maxBytes);
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    return { status: response.status, value };
  }
}

/** The body as text, up to `maxBytes`; more rejects, and the rest is not read. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new TooMuch();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooMuch();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The turn's answer from the server's reply, checked for what it says about itself. */
function answerOf(reply: Reply, model: string, numCtx: number): AgentRunResult {
  if (reply.status === 404) {
    throw new AgentRunError("failed", "That model is not installed on this Mac.");
  }
  if (reply.status !== 200 || !isRecord(reply.value)) {
    throw new AgentRunError("failed", "Ollama reported an error.");
  }
  const r = reply.value;
  const inputTokens = typeof r.prompt_eval_count === "number" ? r.prompt_eval_count : undefined;
  const outputTokens = typeof r.eval_count === "number" ? r.eval_count : undefined;
  // The answer ran out of room, or the request filled the whole context and may have been cut:
  // either way it is not used, and the turn says so (ADR 0119, rule 8).
  if (r.done_reason === "length") {
    throw new AgentRunError("tooLong", `The answer did not fit in what ${model} takes.`);
  }
  if (inputTokens !== undefined && inputTokens >= numCtx) {
    throw new AgentRunError(
      "tooLong",
      `This was too long for ${model}, so its answer is not used.`,
    );
  }
  const message = r.message;
  const content = isRecord(message) && typeof message.content === "string" ? message.content : null;
  if (content === null || content.trim() === "") {
    throw new AgentRunError("badAnswer", "The answer had no structured output.");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new AgentRunError("badAnswer", "The answer was not in the form asked for.");
  }
  if (value === null || typeof value !== "object") {
    throw new AgentRunError("badAnswer", "The answer was not in the form asked for.");
  }
  return {
    value,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] }
  | {
      role: "assistant";
      content: string;
      tool_calls: { function: { name: string; arguments: Record<string, unknown> } }[];
    }
  | { role: "tool"; tool_name: string; content: string };

interface ToolDef {
  readonly type: "function";
  readonly function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** The characters of a conversation, for the context it asks for. */
function charsOf(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
}

/** A tool call's arguments as the model wrote them: an object, or JSON text of one. */
function argumentsOf(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: no arguments.
    }
  }
  return {};
}

/**
 * One request to our tool server (JSON-RPC over HTTP POST, ADR 0083), its result or a rejection.
 * Only the loopback address the server gave, with its token; the answer is read up to a bound.
 */
async function rpc(
  server: AgentToolServer,
  id: number,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (!SERVER_URL.test(server.url)) throw new Error("not our server");
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${server.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal,
    redirect: "error",
  });
  const text = await readCapped(response, MAX_TOOL_REPLY_BYTES);
  if (response.status !== 200) throw new Error("the tool server refused");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.id !== id) throw new Error("not an answer");
  if ("error" in value && value.error !== undefined) throw new Error("tool error");
  return value.result;
}
