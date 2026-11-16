import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  AgentEffort,
  AgentFile,
  AgentKey,
  AgentRunErrorCode,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentToolRunOptions,
  AgentToolServer,
  AgentTurnEvent,
  WholeMediaType,
} from "@matters/core";
import { AGENT_EFFORTS, AgentRunError, apiKeyProblem, wholeFilesProblem } from "@matters/core";

// The Messages API of Anthropic, on the person's own API key (ADR 0141). Node's own `https`, no
// SDK. Not `fetch`: it gives up when no headers come within 300 s, and an answer that is written
// before any byte is sent can take longer than that; the turn's own time is the only bound here.
// The host is fixed in code; the key is read from the vault for each request, never from the
// environment. Nothing the provider writes ever goes into an error, which may reach logs, and
// neither does the key: errors are our own sentences.

export interface AnthropicApiOptions {
  /** The key the person saved, or null when none is kept (ADR 0141, rule 4). */
  readonly key: () => Promise<AgentKey | null>;
  /**
   * A stand-in for tests: `http://127.0.0.1:<port>` and nothing else. Production passes none and
   * gets the provider's own host (rule 3: the host is not a setting).
   */
  readonly baseUrl?: string;
  /** For one turn, its retries included. Default 600 s: an answer can take minutes. */
  readonly timeoutMs?: number;
  /** For each request of `inspect`. Default 15 s. */
  readonly inspectTimeoutMs?: number;
  /** Tries after the first, for what is safe to try again (rule 9). Default 2. */
  readonly retries?: number;
  /** The first wait before trying again; it doubles each time. Default 1 s. */
  readonly backoffMs?: number;
}

export const ANTHROPIC_API_ID = "anthropic-api";
export const ANTHROPIC_API_URL = "https://api.anthropic.com";
/** The version of the API the requests are written for (`anthropic-version`). */
const API_VERSION = "2026-10-21";

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
/** The provider's model ids: `claude-opus-5-5`. Never a path or a URL. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 4;
const DEFAULT_BACKOFF_MS = 1_000;
/** The longest wait between tries, whatever the provider asks for. */
const MAX_WAIT_MS = 30_000;
/** What is read of an answer, at most. A turn's answer is JSON for our schema. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** One page of the list of models. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;
/** What is read of an error, only to tell its type. */
const MAX_ERROR_BYTES = 64 * 1024;
const LIST_PAGE = 1000;
const MAX_LIST_PAGES = 4;
const MAX_MODELS = 200;
/** How long the list read before a turn holds for the next turn. */
const LIST_FRESH_MS = 60_000;
/** The answer may be at most this long, in tokens, or what the model takes when that is less. */
const ANSWER_TOKENS = 16_000;
/** Statuses after which the same request is sent again: nothing was done with it (rule 9). */
const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);

// The loop of ADR 0083 on this runtime: our tool server's shapes, as the other adapters check them.
const SERVER_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
const SERVER_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_TOOLS = 8;
/** Rounds of tool calls in one turn at most; the tool server keeps the budgets of calls itself. */
export const MAX_TOOL_ROUNDS = 32;
const MAX_TOOL_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 200_000;
const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
const MAX_TOOL_TIMEOUT_MS = 900_000;

/** What a model that sees images takes whole (ADR 0090), when the list says it takes images. */
const IMAGE_TYPES: readonly WholeMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

// The sentences of rule 5. Each says what to do, and none repeats what the provider wrote.
const NO_KEY = "Paste an API key from the Anthropic Console to use it.";
const WRONG_KEY = "Anthropic refused the key. Paste the key again, or another one.";
const NO_CREDIT =
  "Anthropic says the key's account has no credit. Add credit in the Anthropic Console, then check again.";
const NO_ACCESS = "The key may not do this. Check its permissions in the Anthropic Console.";
const RATE_LIMITED = "Anthropic is limiting the key's requests now. Try again in a minute.";
const NO_MODEL =
  "The key has no model that answers in the form Matters needs. Check it in the Anthropic Console.";
const UNREACHABLE = "Anthropic could not be reached. Check the connection, then look again.";
const BUSY = "Anthropic is busy now. Try again later.";
const NOT_UNDERSTOOD = "Anthropic gave an answer that was not understood.";

/** What the list says of one model the app may use. */
interface ApiModel {
  readonly id: string;
  readonly line: string | null;
  readonly createdMs: number;
  readonly levels: readonly AgentEffort[];
  readonly images: boolean;
  readonly pdf: boolean;
  /** What `max_tokens` may be at most; null when the list does not say. */
  readonly maxTokens: number | null;
}

type Reply = { readonly status: number; readonly value: unknown; readonly retryAfterMs?: number };

/** Why a request did not give an answer, in our words: a refusal of the key, or trouble. */
class Refusal extends Error {
  readonly status: AgentRuntimeInfo["status"];
  /** The turn's error, when it is not the one its status gives. */
  readonly code: AgentRunErrorCode | undefined;
  constructor(status: AgentRuntimeInfo["status"], message: string, code?: AgentRunErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class TooMuch extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `supported: true` at a leaf of the list's capabilities. */
function supported(node: unknown): boolean {
  return isRecord(node) && node.supported === true;
}

/**
 * One model of the list, or null when the app may not use it: not active, or it cannot answer
 * against a JSON Schema, which every turn of ours does (rule 7). Every model of the Messages API
 * takes tools of the request's own; the list has no capability for that.
 */
export function modelOf(entry: unknown): ApiModel | null {
  if (!isRecord(entry) || typeof entry.id !== "string" || !MODEL_ID.test(entry.id)) return null;
  if (entry.lifecycle !== undefined && entry.lifecycle !== "active") return null;
  const caps = entry.capabilities;
  if (!isRecord(caps) || !supported(caps.structured_outputs)) return null;
  const effort = caps.effort;
  const levels = supported(effort)
    ? AGENT_EFFORTS.filter((level) => supported((effort as Record<string, unknown>)[level]))
    : [];
  const created = typeof entry.created_at === "string" ? Date.parse(entry.created_at) : Number.NaN;
  return {
    id: entry.id,
    line: typeof entry.line === "string" ? entry.line : null,
    createdMs: Number.isFinite(created) ? created : 0,
    levels,
    images: supported(caps.image_input),
    pdf: supported(caps.pdf_input),
    maxTokens:
      typeof entry.max_tokens === "number" && entry.max_tokens > 0 ? entry.max_tokens : null,
  };
}

/** The newest model of the first line that has one, else the newest of all (rule 7). */
function newestOf(models: readonly ApiModel[], lines: readonly string[]): ApiModel {
  const byNew = [...models].sort(
    (a, b) => b.createdMs - a.createdMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const line of lines) {
    const found = byNew.find((m) => m.line === line);
    if (found !== undefined) return found;
  }
  return byNew[0] as ApiModel;
}

/**
 * Keywords of JSON Schema that structured outputs do not take: numbers' and strings' bounds, array
 * sizes, patterns. They are left out of what is sent; the app checks the answer against the whole
 * schema and the rules of the turn afterwards, as for any runtime (rule 8).
 */
const UNSENT_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "$schema",
]);
/** The string formats structured outputs take. */
const SENT_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/**
 * The schema as structured outputs take it: the keywords above left out, a format they do not
 * know left out, and every object closed to properties it does not name. Pure; the input is not
 * changed.
 */
export function sendableSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sendableSchema);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSENT_KEYWORDS.has(key)) continue;
    if (key === "format" && (typeof value !== "string" || !SENT_FORMATS.has(value))) continue;
    if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, sendableSchema(sub)]),
      );
      continue;
    }
    if (key === "enum" || key === "const" || key === "required") {
      out[key] = value;
      continue;
    }
    out[key] = sendableSchema(value);
  }
  const isObject =
    out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"));
  if (isObject || "properties" in out) out.additionalProperties = false;
  return out;
}

export class AnthropicApiRuntime implements AgentRuntimePort {
  readonly id = ANTHROPIC_API_ID;
  readonly name = "Anthropic API";
  /** Images and PDFs whole, to a model the list says takes them (ADR 0090; ADR 0141, rule 8). */
  readonly takesFiles = true;
  private readonly key: () => Promise<AgentKey | null>;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly inspectTimeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(options: AnthropicApiOptions) {
    const base = options.baseUrl ?? ANTHROPIC_API_URL;
    // Mail and the key go to this host: in a test, only the loopback address can be named.
    if (base !== ANTHROPIC_API_URL && !LOOPBACK_URL.test(base)) {
      throw new Error("The Anthropic API is only reached at its own host");
    }
    this.key = options.key;
    this.base = base;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.retries = Math.max(0, Math.min(MAX_RETRIES, options.retries ?? DEFAULT_RETRIES));
    this.backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_BACKOFF_MS);
  }

  /**
   * What the key gives (rule 5): no key, a key the provider refuses, or the models it lists, not
   * yet tested. Lists the models with the key; sends no mail and runs no model, so it costs
   * nothing.
   */
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = { id: this.id, name: this.name, noPlan: true, billed: true } as const;
    let kept: AgentKey | null;
    try {
      kept = await this.key();
    } catch {
      return { ...base, models: [], status: "failed", problem: "The key could not be read." };
    }
    if (kept === null) return { ...base, models: [], status: "noKey", problem: NO_KEY };
    const keyed = {
      ...base,
      keySavedAtMs: kept.savedAtMs,
      ...(kept.id === undefined ? {} : { keyId: kept.id }),
    };
    let models: ApiModel[];
    try {
      models = await this.listModels(kept.key);
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal("failed", UNREACHABLE);
      return { ...keyed, models: [], status: refusal.status, problem: refusal.message };
    }
    if (models.length === 0) {
      return { ...keyed, models: [], status: "keyRefused", problem: NO_MODEL };
    }
    // Writing, questions and themes start on the newest Opus; understanding mail and titles,
    // many small turns, on the newest Haiku (rule 7). A line the key lacks gives way to the next.
    const strong = newestOf(models, ["opus", "sonnet"]);
    const light = newestOf(models, ["haiku", "sonnet", "opus"]);
    return {
      ...keyed,
      status: "found",
      models: models.map((m) => m.id),
      modelEfforts: Object.fromEntries(models.map((m) => [m.id, [...m.levels]])),
      toolModels: models.map((m) => m.id),
      modelFiles: Object.fromEntries(
        models.map((m) => [
          m.id,
          [...(m.images ? IMAGE_TYPES : []), ...(m.pdf ? (["application/pdf"] as const) : [])],
        ]),
      ),
      defaultModel: strong.id,
      defaultModels: { understand: light.id, titles: light.id },
    };
  }

  async run(
    request: AgentRunRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    const { signal } = options;
    const turn = await this.prepare(request, signal);
    const timer = AbortSignal.timeout(this.timeoutMs);
    const both = signal === undefined ? timer : AbortSignal.any([signal, timer]);
    // Our words as the system prompt; the mail as the person's message, as data (ADR 0051).
    const reply = await this.messages(
      turn.key,
      {
        model: turn.model.id,
        max_tokens: turn.maxTokens,
        system: request.instructions,
        messages: [
          { role: "user", content: [...turn.files, { type: "text", text: request.untrusted }] },
        ],
        output_config: {
          format: { type: "json_schema", schema: turn.schema },
          ...(request.effort === undefined ? {} : { effort: request.effort }),
        },
      },
      signal,
      both,
    );
    return answerOf(reply, turn.model.id);
  }

  /**
   * One turn that may call the tools of `options.server` and no others (ADR 0083; ADR 0141, rule
   * 8). The model calls tools in rounds; what it gives back goes in unchanged, thinking included,
   * and the tools' results go back as data in the person's turn. When it stops calling, one last
   * request of the same conversation answers in the schema and may call no tool.
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
    const asked = options.timeoutMs;
    const limit =
      asked !== undefined && Number.isFinite(asked) && asked > 0
        ? Math.min(asked, MAX_TOOL_TIMEOUT_MS)
        : DEFAULT_TOOL_TIMEOUT_MS;
    const timer = AbortSignal.timeout(limit);
    const both = signal === undefined ? timer : AbortSignal.any([signal, timer]);
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
      const usage = isRecord(reply.value) ? reply.value.usage : undefined;
      if (!isRecord(usage)) return;
      if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
    };
    const listed = await toolsOf(server, both).catch(() => {
      throw (
        stopped(signal, timer) ?? new AgentRunError("failed", "The tool server did not answer.")
      );
    });
    const effort =
      request.effort === undefined ? {} : { output_config: { effort: request.effort } };
    const messages: unknown[] = [
      { role: "user", content: [{ type: "text", text: request.untrusted }] },
    ];
    let nextId = 2;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await this.messages(
        turn.key,
        {
          model: turn.model.id,
          max_tokens: turn.maxTokens,
          system: request.instructions,
          tools: listed,
          tool_choice: { type: "auto" },
          messages,
          ...effort,
        },
        signal,
        both,
      );
      count(reply);
      if (!isRecord(reply.value) || !Array.isArray(reply.value.content)) {
        throw new AgentRunError("failed", NOT_UNDERSTOOD);
      }
      const stop = reply.value.stop_reason;
      if (stop === "refusal")
        throw new AgentRunError("badAnswer", "Anthropic declined to answer this.");
      // Out of room for the answer, or done calling: what was read so far goes to the answer.
      if (stop !== "tool_use") break;
      const content = reply.value.content.filter(isRecord);
      const calls = content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) break;
      const note = content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      if (note.trim() !== "") emit({ kind: "text", text: note });
      for (const call of calls) {
        if (typeof call.name !== "string" || !server.tools.includes(call.name)) {
          throw new AgentRunError("failed", "Anthropic called a tool that was turned off.");
        }
        if (typeof call.id !== "string" || call.id.length === 0 || call.id.length > 128) {
          throw new AgentRunError("failed", NOT_UNDERSTOOD);
        }
      }
      // The assistant's turn goes back as it came: its thinking is kept with it.
      messages.push({ role: "assistant", content: reply.value.content });
      const results: unknown[] = [];
      for (const call of calls) {
        const input = isRecord(call.input) ? call.input : {};
        emit({ kind: "tool", name: call.name as string, input });
        const text = await callTool(server, nextId++, call.name as string, input, both).catch(
          () => {
            const end = stopped(signal, timer);
            if (end !== null) throw end;
            return "The tool could not be used.";
          },
        );
        // Mail and file text are data: a tool's result in the person's turn, never the system.
        results.push({ type: "tool_result", tool_use_id: call.id, content: text });
      }
      // Every result of one round in one message (the API's rule for calls made together).
      messages.push({ role: "user", content: results });
    }
    // The answer, held to the schema, from all that was read. The tools stay defined, since the
    // conversation names them, but none may be called.
    const reply = await this.messages(
      turn.key,
      {
        model: turn.model.id,
        max_tokens: turn.maxTokens,
        system: request.instructions,
        tools: listed,
        tool_choice: { type: "none" },
        messages,
        output_config: {
          format: { type: "json_schema", schema: turn.schema },
          ...(request.effort === undefined ? {} : { effort: request.effort }),
        },
      },
      signal,
      both,
    );
    const answer = answerOf(reply, turn.model.id);
    return {
      value: answer.value,
      inputTokens: inputTokens + (answer.inputTokens ?? 0),
      outputTokens: outputTokens + (answer.outputTokens ?? 0),
    };
  }

  /** What every turn checks before mail goes: the key, the model, the effort, the files. */
  private async prepare(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
  ): Promise<{
    key: string;
    model: ApiModel;
    schema: unknown;
    files: unknown[];
    maxTokens: number;
  }> {
    if (!MODEL_ID.test(request.model)) throw new AgentRunError("failed", "Unknown model name.");
    if (
      request.effort !== undefined &&
      !(AGENT_EFFORTS as readonly string[]).includes(request.effort)
    ) {
      throw new AgentRunError("failed", "Unknown effort.");
    }
    let schema: unknown;
    try {
      // A round trip through JSON: what is sent is plain data, and a schema that cannot be is refused.
      schema = sendableSchema(JSON.parse(JSON.stringify(request.schema)));
    } catch {
      throw new AgentRunError("failed", "The schema cannot be serialized.");
    }
    const files = request.files ?? [];
    if (files.length > 0) {
      const problem = wholeFilesProblem(files);
      if (problem !== null) throw new AgentRunError("failed", problem);
    }
    if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
    let kept: AgentKey | null;
    try {
      kept = await this.key();
    } catch {
      throw new AgentRunError("failed", "The key could not be read.");
    }
    if (kept === null) throw new AgentRunError("refused", NO_KEY);
    // The model is looked at again before mail goes: the key must still list it.
    let model: ApiModel | null;
    try {
      model = await this.oneModel(kept.key, request.model, signal);
    } catch (error) {
      if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
      throw runError(error);
    }
    if (model === null) {
      throw new AgentRunError(
        "refused",
        `The key has no access to ${request.model}. Choose another model.`,
      );
    }
    for (const f of files) {
      const takes = f.mediaType === "application/pdf" ? model.pdf : model.images;
      if (!takes) throw new AgentRunError("failed", `${model.id} does not take this kind of file.`);
    }
    // Only a level the model lists is sent (ADR 0118, rule 5; ADR 0119, rule 9).
    if (request.effort !== undefined && !model.levels.includes(request.effort)) {
      throw new AgentRunError(
        "effortRefused",
        `${model.id} does not take the effort ${request.effort}. Choose another in Settings.`,
      );
    }
    return {
      key: kept.key,
      model,
      schema,
      files: files.map(fileBlock),
      maxTokens: Math.min(ANSWER_TOKENS, model.maxTokens ?? ANSWER_TOKENS),
    };
  }

  /** Every model the key may use, from the provider's list, a few pages at most. */
  private async listModels(key: string, signal?: AbortSignal): Promise<ApiModel[]> {
    const out: ApiModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES && out.length < MAX_MODELS; page++) {
      const query: string =
        after === null
          ? `?limit=${LIST_PAGE}`
          : `?limit=${LIST_PAGE}&after_id=${encodeURIComponent(after)}`;
      const look = AbortSignal.timeout(this.inspectTimeoutMs);
      const reply = await this.send(
        key,
        "GET",
        `/v1/models${query}`,
        undefined,
        MAX_LIST_BYTES,
        signal,
        signal === undefined ? look : AbortSignal.any([signal, look]),
      );
      if (!isRecord(reply.value) || !Array.isArray(reply.value.data)) {
        throw new Refusal("failed", NOT_UNDERSTOOD);
      }
      for (const entry of reply.value.data) {
        const model = modelOf(entry);
        if (model !== null && !out.some((m) => m.id === model.id)) out.push(model);
      }
      const last = reply.value.last_id;
      if (reply.value.has_more !== true || typeof last !== "string" || !MODEL_ID.test(last)) break;
      after = last;
    }
    return out.slice(0, MAX_MODELS);
  }

  /**
   * One model as the list said it within the last minute, or null when the key may not use it. A
   * reading of many turns asks for the list once, not before every turn; a new key asks again.
   */
  private async oneModel(
    key: string,
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<ApiModel | null> {
    const seen = this.seen;
    if (seen !== null && seen.key === key && Date.now() - seen.atMs < LIST_FRESH_MS) {
      return seen.models.find((m) => m.id === id) ?? null;
    }
    const models = await this.listModels(key, signal);
    this.seen = { key, atMs: Date.now(), models };
    return models.find((m) => m.id === id) ?? null;
  }

  /** The list as last read, with the key it was read with; held in memory only. */
  private seen: { key: string; atMs: number; models: readonly ApiModel[] } | null = null;

  /** One request of the Messages API, its failures in our words. */
  private async messages(
    key: string,
    body: unknown,
    signal: AbortSignal | undefined,
    both: AbortSignal,
  ): Promise<Reply> {
    try {
      return await this.send(key, "POST", "/v1/messages", body, MAX_ANSWER_BYTES, signal, both);
    } catch (error) {
      if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
      if (both.aborted) throw new AgentRunError("failed", "Anthropic took too long.");
      throw runError(error);
    }
  }

  /**
   * One request, tried again for what is safe to try again (rule 9): no answer at all, a status
   * that says the request was not taken, or a limit for now. With a bounded number of tries and
   * waits; Stop ends a wait at once. Rejects with a `Refusal` in our words.
   */
  private async send(
    key: string,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    maxBytes: number,
    stop: AbortSignal | undefined,
    signal: AbortSignal,
  ): Promise<Reply> {
    if (apiKeyProblem(key) !== null) throw new Refusal("keyRefused", WRONG_KEY);
    const text = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let reply: Reply | null = null;
      try {
        reply = await this.once(key, method, path, text, maxBytes, signal);
      } catch (error) {
        if (signal.aborted || stop?.aborted) throw error;
        if (error instanceof TooMuch) throw new Refusal("failed", "Anthropic wrote too much.");
        // No answer came. A look at the list is tried again; a turn is not, since it may have
        // been taken and billed before the connection broke.
        if (method !== "GET") throw new Refusal("failed", UNREACHABLE);
      }
      if (reply !== null && reply.status >= 200 && reply.status < 300) return reply;
      const again = reply === null || RETRY_STATUSES.has(reply.status);
      if (!again || attempt >= this.retries) throw refusalOf(reply);
      const wait = Math.min(MAX_WAIT_MS, reply?.retryAfterMs ?? this.backoffMs * 2 ** attempt);
      await sleep(wait, signal);
    }
  }

  /**
   * One request, its answer read up to `maxBytes`; rejects when nothing came back. A redirect is
   * never followed, so the key never goes to another host: it is a status like any other.
   */
  private async once(
    key: string,
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Reply> {
    const url = new URL(`${this.base}${path}`);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = send(
        url,
        {
          method,
          headers: {
            "x-api-key": key,
            "anthropic-version": API_VERSION,
            accept: "application/json",
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(body)),
                }),
          },
          signal,
        },
        resolve,
      );
      request.on("error", reject);
      request.end(body);
    });
    const status = response.statusCode ?? 0;
    const ok = status >= 200 && status < 300;
    const read = await readMessage(response, ok ? maxBytes : MAX_ERROR_BYTES).catch((error) => {
      if (ok || !(error instanceof TooMuch)) throw error;
      return "";
    });
    let value: unknown = null;
    try {
      value = JSON.parse(read);
    } catch {
      value = null;
    }
    const after = response.headers["retry-after"];
    const retryAfterMs = retryAfterOf(typeof after === "string" ? after : null);
    return { status, value, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
}

/** `retry-after` in seconds, as a wait; nothing for a value that is not a number of seconds. */
function retryAfterOf(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,6}(\.\d+)?$/.test(raw.trim())) return undefined;
  return Math.round(Number(raw.trim()) * 1000);
}

/**
 * What a failed request means for the person (rule 5), from its status and the type the provider
 * gave the error, never its words.
 */
function refusalOf(reply: Reply | null): Refusal {
  if (reply === null) return new Refusal("failed", UNREACHABLE);
  const error = isRecord(reply.value) && isRecord(reply.value.error) ? reply.value.error : {};
  const type = typeof error.type === "string" ? error.type : "";
  if (reply.status === 401 || type === "authentication_error") {
    return new Refusal("keyRefused", WRONG_KEY);
  }
  if (reply.status === 402 || type === "billing_error") return new Refusal("keyRefused", NO_CREDIT);
  if (reply.status === 403 || type === "permission_error") {
    return new Refusal("keyRefused", NO_ACCESS);
  }
  if (reply.status === 429 || type === "rate_limit_error") {
    return new Refusal("keyRefused", RATE_LIMITED);
  }
  if (reply.status === 404 || type === "not_found_error") {
    return new Refusal("keyRefused", "The key has no access to that model. Choose another model.");
  }
  if (reply.status === 413 || type === "request_too_large") {
    // Too long to take: `tooLong`, whose sentence reaches the person (ADR 0119, rule 8).
    return new Refusal(
      "failed",
      "This is too long for Anthropic to take. Ask about less.",
      "tooLong",
    );
  }
  if (reply.status >= 500) return new Refusal("failed", BUSY);
  return new Refusal("failed", "Anthropic did not take the request.");
}

/**
 * A refusal as a turn's error: the key's refusals are `refused`, a request too long `tooLong`, the
 * rest `failed`.
 */
function runError(error: unknown): AgentRunError {
  if (error instanceof AgentRunError) return error;
  if (error instanceof Refusal) {
    const code = error.code ?? (error.status === "keyRefused" ? "refused" : "failed");
    return new AgentRunError(code, error.message);
  }
  return new AgentRunError("failed", UNREACHABLE);
}

/** The error that ends a turn the person stopped or that took too long; null otherwise. */
function stopped(signal: AbortSignal | undefined, timer: AbortSignal): AgentRunError | null {
  if (signal?.aborted) return new AgentRunError("failed", "Cancelled.");
  if (timer.aborted) return new AgentRunError("failed", "Anthropic took too long.");
  return null;
}

/** Waits `ms`, or rejects at once when the signal ends. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The body of an answer as text, up to `maxBytes`; more rejects, and the rest is not read. A
 * connection that ends before the body does rejects too.
 */
function readMessage(response: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      reject(new TooMuch());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        response.destroy();
        reject(new TooMuch());
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
    response.on("close", () => {
      if (!response.complete) reject(new Error("The answer ended early."));
    });
  });
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

/** A file with no text as the Messages API takes it whole (ADR 0090). */
function fileBlock(file: AgentFile): unknown {
  const data = Buffer.from(file.bytes).toString("base64");
  return file.mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: file.mediaType, data } }
    : { type: "image", source: { type: "base64", media_type: file.mediaType, data } };
}

/** The turn's answer from the provider's reply, checked for what it says about itself. */
function answerOf(reply: Reply, model: string): AgentRunResult {
  if (!isRecord(reply.value) || !Array.isArray(reply.value.content)) {
    throw new AgentRunError("badAnswer", NOT_UNDERSTOOD);
  }
  const r = reply.value;
  const usage = isRecord(r.usage) ? r.usage : {};
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (r.stop_reason === "refusal") {
    throw new AgentRunError("badAnswer", "Anthropic declined to answer this.");
  }
  // The answer ran out of room: it is not used, and the turn says so.
  if (r.stop_reason === "max_tokens") {
    throw new AgentRunError(
      "tooLong",
      `The answer did not fit in what ${model} may write at once.`,
    );
  }
  const blocks: readonly unknown[] = Array.isArray(r.content) ? r.content : [];
  const text = blocks
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("");
  if (text.trim() === "")
    throw new AgentRunError("badAnswer", "The answer had no structured output.");
  let value: unknown;
  try {
    value = JSON.parse(text);
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

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** The tools our server offers this turn, as the model is given them: only those named. */
async function toolsOf(server: AgentToolServer, signal: AbortSignal): Promise<ToolDef[]> {
  const result = await rpc(server, 1, "tools/list", {}, signal);
  const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
  const out: ToolDef[] = [];
  for (const t of list) {
    if (!isRecord(t) || typeof t.name !== "string" || !server.tools.includes(t.name)) continue;
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description.slice(0, 2000) : "",
      input_schema: isRecord(t.inputSchema) ? t.inputSchema : { type: "object" },
    });
  }
  if (out.length === 0) throw new Error("no tools");
  return out;
}

/** Calls one tool of our server; its text, bounded. An error of the tool is its own text. */
async function callTool(
  server: AgentToolServer,
  id: number,
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const result = await rpc(server, id, "tools/call", { name, arguments: input }, signal);
  if (!isRecord(result) || !Array.isArray(result.content)) return "The tool could not be used.";
  const text = result.content
    .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "text")
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n");
  return text.slice(0, MAX_TOOL_RESULT_CHARS);
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
