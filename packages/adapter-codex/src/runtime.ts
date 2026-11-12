import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  AgentEffort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentToolRunOptions,
  AgentToolServer,
  AgentTurnEvent,
  AgentWorkKind,
  PlanLimits,
  WholeMediaType,
} from "@matters/core";
import { AGENT_EFFORTS, AgentRunError, wholeFilesProblem } from "@matters/core";
import { parseRateLimits, readRateLimits } from "./limits.ts";
import {
  classifyFailure,
  dropNulls,
  type FailureKind,
  isObject,
  itemVerdict,
  parseLine,
  retryAt,
  strictSchema,
  tokens,
} from "./stream.ts";
import { closedArgs, closedCatalogEntry } from "./switches.ts";

// The person's own Codex, on the ChatGPT plan they are signed in with (ADR 0120). Each turn is a
// fresh `codex exec` in an empty directory made for it, with every tool of Codex's own off and
// nothing of the person's setup loaded (rule 3; the switches are in `switches.ts`). Our
// instructions go where Codex keeps instructions, the mail by stdin (rule 4).

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CodexOptions {
  /** A path, or a name looked up on PATH. Default `codex`. */
  readonly binary?: string;
  readonly spawn?: SpawnFn;
  /** Where the directories of turns are made. Default the system temp directory. */
  readonly tmpRoot?: string;
  /** The environment the child's few variables are taken from. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** For one `run`. Default 180 s: a fresh Codex starts on every turn. */
  readonly timeoutMs?: number;
  /** For `login status` and the list of models. Default 20 s. */
  readonly inspectTimeoutMs?: number;
  /** For the read of the plan's windows (ADR 0120, rule 9). Default 5 s. */
  readonly limitsTimeoutMs?: number;
  /** The clock: the age of the windows, the spacing of their reads, stale turn directories. */
  readonly now?: () => number;
}

export const CODEX_ID = "codex";

/**
 * The models named here, used only when Codex lists none (ADR 0120, rule 8). They can lag behind
 * what the plan offers: whenever Codex's own list can be read, it is used instead.
 */
export const NAMED_MODELS: readonly {
  readonly slug: string;
  readonly levels: readonly AgentEffort[];
}[] = [
  { slug: "gpt-6.1-sol", levels: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-6-astra", levels: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-6.1-terra", levels: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-6-luna", levels: ["low", "medium", "high", "xhigh", "max"] },
];

/**
 * The model each kind of work starts on, the first of each list that Codex lists (ADR 0120): a
 * fast one for reading mail and naming talks, the workhorse for writing and answering. Like the
 * names above, they can lag; a kind whose models are all gone starts on Codex's first model.
 */
export const STARTING_MODELS: Readonly<Record<AgentWorkKind, readonly string[]>> = {
  understand: ["gpt-6-luna", "gpt-5.6-luna"],
  titles: ["gpt-6-luna", "gpt-5.6-luna"],
  write: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
  answer: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
};

/** What `-i` takes whole (rule 7): images. Codex takes no PDF. */
export const IMAGE_TYPES: readonly WholeMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];
const IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The variable of the child that holds the token of our tool server; never argv, never a file. */
export const TOOL_TOKEN_ENV = "MATTERS_TOOL_TOKEN";

/**
 * What of this app's environment the child gets: what Codex needs to find itself and its sign-in,
 * and nothing else. No key of any API reaches it (an `OPENAI_API_KEY` would move the turn off the
 * plan), no proxy, no setting of ours.
 */
export const ENV_PASSED: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CODEX_HOME",
];

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_LIMITS_TIMEOUT_MS = 5000;
/** The windows are read at most this often (ADR 0120, rule 9). */
const LIMITS_EVERY_MS = 30_000;
/** The plan's name until Codex has named it. */
const PLAN_FALLBACK = "ChatGPT";
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const MAX_TOOL_TIMEOUT_MS = 600_000;
const MAX_STDERR_CHARS = 4096;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** A turn with tools gets the tool results back as events, so it may write more (ADR 0083). */
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** The list of models, at most. */
const MAX_LIST_CHARS = 4 * 1024 * 1024;
const MAX_MODELS = 64;
const KILL_GRACE_MS = 2000;
/** Directories of turns older than this are left over from a crash of the app: removed. */
const STALE_TURN_MS = 2 * MAX_TOOL_TIMEOUT_MS;
const TURN_PREFIX = "matters-codex-";

/** Models are plain ids; anything that could pass for a flag or reach TOML is refused. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The server's words end up in argv (as TOML), so only these shapes pass (ADR 0083, rule 3).
const SERVER_NAME = /^[a-z][a-z0-9_]{0,30}$/;
const SERVER_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
const SERVER_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_TOOLS = 8;
/** A path that goes into a TOML string: no quote, no backslash, nothing to escape. */
const SAFE_PATH = /^\/[A-Za-z0-9._/+-]+$/;

const NOT_FOUND = "Codex is not installed, or is not on this app's PATH.";
const SIGNED_OUT = "Not signed in. Run `codex login` in Terminal, then look again.";
const NOT_PLAN =
  "Codex is not signed in with a ChatGPT plan, and a key bills by use. Run `codex login` in Terminal and sign in with ChatGPT, then look again.";
const NOT_SIGNED_IN = "Codex is not signed in. Run `codex login` in Terminal, then look again.";
const NOT_UNDERSTOOD = "Codex gave an answer that was not understood.";
const OWN_TOOL = "Codex used a tool of its own, which is turned off.";

/** One model as Codex lists it: its levels, whether it sees images, its entry for the catalog. */
interface ListedModel {
  readonly slug: string;
  readonly levels: readonly AgentEffort[];
  readonly images: boolean;
  readonly entry: Readonly<Record<string, unknown>>;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The program at `binary`, or the first executable of that name on `PATH`. No shell. */
export function findBinary(binary: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(binary) || binary.includes("/")) return isExecutable(binary) ? binary : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The child's environment: the few variables of `ENV_PASSED`, and `extra`. */
export function childEnv(
  env: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSED) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return { ...out, ...extra };
}

export type SignIn = "plan" | "other" | "signedOut" | null;

/** What `codex login status` says, in its own words: only a ChatGPT sign-in is a plan (rule 2). */
export function parseLoginStatus(text: string): SignIn {
  if (/^\s*Logged in using ChatGPT\s*$/m.test(text)) return "plan";
  if (/^\s*Logged in using\b/m.test(text)) return "other";
  if (/^\s*Not logged in\s*$/m.test(text)) return "signedOut";
  return null;
}

/** The models Codex lists for the plan, from `codex debug models`; null when not understood. */
export function parseModels(text: string): ListedModel[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || !Array.isArray(value.models)) return null;
  const out: ListedModel[] = [];
  for (const raw of value.models.slice(0, MAX_MODELS)) {
    if (!isObject(raw) || typeof raw.slug !== "string" || !MODEL_NAME.test(raw.slug)) continue;
    // Only the models Codex offers to choose from; hidden ones are its own helpers.
    if (raw.visibility !== "list") continue;
    if (out.some((m) => m.slug === raw.slug)) continue;
    const named = Array.isArray(raw.supported_reasoning_levels)
      ? raw.supported_reasoning_levels.map((l) => (isObject(l) ? l.effort : undefined))
      : [];
    const levels = AGENT_EFFORTS.filter((e) => named.includes(e));
    const images = Array.isArray(raw.input_modalities) && raw.input_modalities.includes("image");
    out.push({ slug: raw.slug, levels, images, entry: raw });
  }
  return out;
}

/** An entry for a model named here, for when Codex lists none (rule 8). */
function namedEntry(slug: string, levels: readonly AgentEffort[]): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: effort })),
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    context_window: 272_000,
    effective_context_window_percent: 95,
    input_modalities: ["text", "image"],
  };
}

/** A TOML basic string of a path made by the adapter. */
function tomlPath(path: string): string {
  if (!SAFE_PATH.test(path))
    throw new AgentRunError("failed", "The turn's folder has an odd name.");
  return `"${path}"`;
}

/** Our tool server, for this turn only, as a TOML inline table (ADR 0120, rule 6). */
export function toolServerConfig(server: AgentToolServer, timeoutSec: number): string {
  const tools = server.tools.map((t) => `"${t}"`).join(",");
  return (
    `mcp_servers.${server.name}={url="${server.url}",bearer_token_env_var="${TOOL_TOKEN_ENV}",` +
    `enabled_tools=[${tools}],required=true,startup_timeout_sec=15,` +
    `tool_timeout_sec=${timeoutSec},default_tools_approval_mode="approve"}`
  );
}

/** What differs between a plain turn and a turn with tools. */
interface ToolTurn {
  readonly server: AgentToolServer;
  readonly options: AgentToolRunOptions;
}

export class CodexRuntime implements AgentRuntimePort {
  readonly id = CODEX_ID;
  readonly name = "Codex";
  /** Images go whole, as files of the turn given with `-i` (ADR 0120, rule 7). */
  readonly takesFiles = true;
  private readonly binary: string;
  private readonly spawn: SpawnFn;
  private readonly tmpRoot: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly inspectTimeoutMs: number;
  private readonly now: () => number;
  private readonly limitsTimeoutMs: number;
  /** What Codex last listed, by model; a turn's catalog entry comes from here. */
  private listed = new Map<string, ListedModel>();
  /** The windows and the plan's name of the last read that gave them; kept when a read fails. */
  private limits: PlanLimits | undefined;
  private planName: string | undefined;
  /** When the last read started, and the one in flight (ADR 0120, rule 9). */
  private limitsReadAtMs: number | undefined;
  private reading: Promise<void> | null = null;
  /** Turns whose Codex was started, so that one refused before it starts reads nothing. */
  private turnsStarted = 0;

  constructor(options: CodexOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.spawn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.baseEnv = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.limitsTimeoutMs = options.limitsTimeoutMs ?? DEFAULT_LIMITS_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Found, signed in with a plan, the models of the plan and its windows (ADR 0120, rules 1, 2, 8
   * and 9). Asks `codex login status`, `codex debug models` and, once signed in, the server for the
   * account's limits: none of them runs a model or sends mail. Reads no file of Codex's and no
   * keychain: sign-in is the program's own business.
   */
  async inspect(): Promise<AgentRuntimeInfo> {
    this.sweep();
    const base = {
      id: this.id,
      name: this.name,
      // The windows are read apart from turns and can be stale: a refusal for the limit in the
      // background pauses the reading until the person continues it (rule 9).
      pausesOnLimit: true,
    } as const;
    const file = findBinary(this.binary, this.baseEnv);
    if (file === null) return { ...base, models: [], status: "missing", problem: NOT_FOUND };
    let signIn: SignIn;
    try {
      signIn = await this.signIn(file);
    } catch {
      return { ...base, models: [], status: "failed", problem: "Codex could not be started." };
    }
    if (signIn === null) return { ...base, models: [], status: "failed", problem: NOT_UNDERSTOOD };
    if (signIn === "signedOut") {
      return { ...base, models: [], status: "signedOut", problem: SIGNED_OUT };
    }
    if (signIn === "other") return { ...base, models: [], status: "signedOut", problem: NOT_PLAN };
    const [models] = await Promise.all([this.listModels(file), this.readLimits(file)]);
    const names = models.map((m) => m.slug);
    const first = (kind: AgentWorkKind) => STARTING_MODELS[kind].find((n) => names.includes(n));
    const defaultModels: Partial<Record<AgentWorkKind, string>> = {};
    for (const kind of ["understand", "write", "answer", "titles"] as const) {
      const pick = first(kind);
      if (pick !== undefined) defaultModels[kind] = pick;
    }
    return {
      ...base,
      status: "found",
      plan: this.planName ?? PLAN_FALLBACK,
      models: names,
      modelEfforts: Object.fromEntries(models.map((m) => [m.slug, [...m.levels]])),
      modelFiles: Object.fromEntries(models.map((m) => [m.slug, m.images ? [...IMAGE_TYPES] : []])),
      ...(names[0] === undefined ? {} : { defaultModel: names[0] }),
      defaultModels,
      ...(this.limits === undefined ? {} : { limits: this.limits }),
    };
  }

  async run(
    request: AgentRunRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    return this.withLimits(() => this.start(request, options.signal, undefined));
  }

  /**
   * A turn that may call the tools of one server of ours on this machine, and no other (ADR 0120,
   * rule 6). The server is named to Codex for this turn only; its token is in the child's
   * environment. The answer comes in the schema in the same turn.
   */
  async runWithTools(
    request: AgentRunRequest,
    options: AgentToolRunOptions,
  ): Promise<AgentRunResult> {
    const { server } = options;
    if (
      !SERVER_NAME.test(server.name) ||
      !SERVER_URL.test(server.url) ||
      !SERVER_TOKEN.test(server.token) ||
      server.tools.length < 1 ||
      server.tools.length > MAX_TOOLS ||
      !server.tools.every((t) => TOOL_NAME.test(t))
    ) {
      throw new AgentRunError("failed", "The tool server is not one this app made.");
    }
    return this.withLimits(() => this.start(request, options.signal, { server, options }));
  }

  /**
   * A turn's result with the plan's windows (ADR 0120, rule 9): after the turn they are read again,
   * unless they were read in the last 30 seconds, and the result carries the last that are known.
   * The answer waits for a read at most its 5 seconds, and never fails because of it. A turn that
   * failed once Codex was started starts the read too, without waiting for it: what it finds comes
   * with what is asked next.
   */
  private async withLimits(turn: () => Promise<AgentRunResult>): Promise<AgentRunResult> {
    const before = this.turnsStarted;
    let result: AgentRunResult;
    try {
      result = await turn();
    } catch (error) {
      const file = this.turnsStarted > before ? findBinary(this.binary, this.baseEnv) : null;
      if (file !== null) void this.readLimits(file);
      throw error;
    }
    const file = findBinary(this.binary, this.baseEnv);
    if (file !== null) await this.readLimits(file);
    return this.limits === undefined ? result : { ...result, limits: this.limits };
  }

  /**
   * Reads the windows, at most once in 30 seconds; a read in flight is shared. Never throws: a read
   * that fails or is late leaves what was known.
   */
  private readLimits(file: string): Promise<void> {
    if (this.reading !== null) return this.reading;
    const now = this.now();
    if (this.limitsReadAtMs !== undefined && now - this.limitsReadAtMs < LIMITS_EVERY_MS) {
      return Promise.resolve();
    }
    this.limitsReadAtMs = now;
    this.reading = (async () => {
      try {
        const result = await readRateLimits({
          file,
          spawn: this.spawn,
          env: childEnv(this.baseEnv),
          tmpRoot: this.tmpRoot,
          prefix: TURN_PREFIX,
          timeoutMs: this.limitsTimeoutMs,
        });
        if (result === null) return;
        const read = parseRateLimits(result, this.now());
        if (read.limits !== undefined) this.limits = read.limits;
        if (read.plan !== undefined) this.planName = read.plan;
      } catch {
        // What was known stays.
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  private async start(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    tools: ToolTurn | undefined,
  ): Promise<AgentRunResult> {
    if (!MODEL_NAME.test(request.model)) throw new AgentRunError("failed", "Unknown model name.");
    if (
      request.effort !== undefined &&
      !(AGENT_EFFORTS as readonly string[]).includes(request.effort)
    ) {
      throw new AgentRunError("failed", "Unknown effort.");
    }
    const files = request.files ?? [];
    if (files.length > 0) {
      // Only the answer turn, which has no tools, gets files whole (ADR 0090, rule 3).
      if (tools !== undefined) {
        throw new AgentRunError("failed", "Files do not go to a turn with tools.");
      }
      if (files.some((f) => !IMAGE_TYPES.includes(f.mediaType))) {
        throw new AgentRunError("failed", "Codex takes images whole, and no other file.");
      }
      const problem = wholeFilesProblem(files);
      if (problem !== null) throw new AgentRunError("failed", problem);
    }
    let schemaText: string;
    try {
      schemaText = JSON.stringify(strictSchema(request.schema));
    } catch {
      throw new AgentRunError("failed", "The schema cannot be serialized.");
    }
    if (typeof schemaText !== "string") {
      throw new AgentRunError("failed", "The schema cannot be serialized.");
    }
    if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
    const file = findBinary(this.binary, this.baseEnv);
    if (file === null) throw new AgentRunError("failed", "Codex was not found.");
    // Asked again before mail goes: the sign-in may have changed since the last look (rule 2).
    let signIn: SignIn;
    try {
      signIn = await this.signIn(file);
    } catch {
      throw new AgentRunError("failed", "Codex could not be started.");
    }
    if (signIn === "other") {
      throw new AgentRunError("notPlan", "The turn would not run on a ChatGPT plan.");
    }
    if (signIn !== "plan") throw new AgentRunError("notSignedIn", NOT_SIGNED_IN);
    if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
    const model =
      this.listed.get(request.model) ??
      (await this.listModels(file)).find((m) => m.slug === request.model);
    if (model === undefined) {
      throw new AgentRunError(
        "failed",
        `Codex does not offer ${request.model} now. Choose another in Settings.`,
      );
    }
    // Only a level the model lists is sent (ADR 0118, rule 5; ADR 0120, rule 8).
    if (request.effort !== undefined && !model.levels.includes(request.effort)) {
      throw new AgentRunError(
        "effortRefused",
        `${model.slug} does not take the effort ${request.effort}. Choose another in Settings.`,
      );
    }
    if (files.length > 0 && !model.images) {
      throw new AgentRunError("failed", `${model.slug} does not see images.`);
    }

    // The turn's own directory, only this user's: the empty working directory, and beside it
    // what Codex is given (instructions, schema, catalog, images) and keeps (its state and logs).
    const root = await mkdtemp(join(this.tmpRoot, TURN_PREFIX));
    try {
      const work = join(root, "work");
      const given = join(root, "given");
      const state = join(root, "state");
      await Promise.all([
        mkdir(work, { mode: 0o700 }),
        mkdir(given, { mode: 0o700 }),
        mkdir(state, { mode: 0o700 }),
      ]);
      const instructions = join(given, "instructions.md");
      const schema = join(given, "schema.json");
      const catalog = join(given, "models.json");
      await Promise.all([
        writeFile(instructions, request.instructions, { mode: 0o600 }),
        writeFile(schema, schemaText, { mode: 0o600 }),
        writeFile(catalog, JSON.stringify({ models: [closedCatalogEntry(model.entry)] }), {
          mode: 0o600,
        }),
      ]);
      const images: string[] = [];
      for (const [i, f] of files.entries()) {
        const path = join(given, `image-${i + 1}.${IMAGE_EXT[f.mediaType] ?? "png"}`);
        await writeFile(path, f.bytes, { mode: 0o600 });
        images.push(path);
      }
      const toolTimeoutMs = tools === undefined ? undefined : toolTimeout(tools.options.timeoutMs);
      const args = [
        "exec",
        // Each image as `--image=<file>`: the flag takes several values, so a bare one would
        // swallow what follows.
        ...images.map((p) => `--image=${p}`),
        ...closedArgs(),
        "-c",
        'model_provider="openai"',
        "-c",
        `model_catalog_json=${tomlPath(catalog)}`,
        "-c",
        `model_instructions_file=${tomlPath(instructions)}`,
        "-c",
        `sqlite_home=${tomlPath(state)}`,
        "-c",
        `log_dir=${tomlPath(state)}`,
        "-c",
        tools === undefined
          ? "mcp_servers={}"
          : toolServerConfig(tools.server, Math.ceil((toolTimeoutMs ?? 60_000) / 1000)),
        // Only when asked for: without it Codex uses the model's own default.
        ...(request.effort === undefined
          ? []
          : ["-c", `model_reasoning_effort="${request.effort}"`]),
        "-s",
        "read-only",
        "-C",
        work,
        "-m",
        model.slug,
        "--output-schema",
        schema,
        // The prompt is read from stdin: the mail never goes on the command line.
        "-",
      ];
      return await this.turn(file, args, work, request, signal, tools, toolTimeoutMs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /** Who is signed in, from `codex login status`. Throws when it cannot be asked. */
  private async signIn(file: string): Promise<SignIn> {
    const out = await this.capture(file, ["login", "status"]);
    if (out === null) return null;
    return parseLoginStatus(`${out.stdout}\n${out.stderr}`);
  }

  /** The models Codex lists for the plan, or the ones named here when it lists none (rule 8). */
  private async listModels(file: string): Promise<ListedModel[]> {
    let models: ListedModel[] | null = null;
    try {
      // The built-in provider, which is the plan's; the person's own config may name another.
      const out = await this.capture(file, ["debug", "models", "-c", 'model_provider="openai"']);
      if (out !== null && out.code === 0) models = parseModels(out.stdout);
    } catch {
      models = null;
    }
    if (models === null || models.length === 0) {
      models = NAMED_MODELS.map((m) => ({
        slug: m.slug,
        levels: m.levels,
        images: true,
        entry: namedEntry(m.slug, m.levels),
      }));
    }
    this.listed = new Map(models.map((m) => [m.slug, m]));
    return models;
  }

  /** Runs a short command to the end. `null`: it took too long. Throws when it cannot start. */
  private async capture(
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; code: number | null } | null> {
    const cwd = await mkdtemp(join(this.tmpRoot, TURN_PREFIX));
    try {
      return await new Promise((resolve, reject) => {
        const child = this.spawn(file, args, {
          cwd,
          env: childEnv(this.baseEnv),
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, this.inspectTimeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (stdout.length < MAX_LIST_CHARS) stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(timedOut ? null : { stdout, stderr, code });
        });
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /** Removes the directories of turns that a crash of the app left behind. Never throws. */
  private sweep(): void {
    try {
      const cutoff = this.now() - STALE_TURN_MS;
      for (const name of readdirSync(this.tmpRoot)) {
        if (!name.startsWith(TURN_PREFIX)) continue;
        const path = join(this.tmpRoot, name);
        try {
          if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
        } catch {
          // Someone else's, or gone already.
        }
      }
    } catch {
      // The temp directory cannot be read: nothing to sweep.
    }
  }

  private turn(
    file: string,
    args: readonly string[],
    cwd: string,
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    tools: ToolTurn | undefined,
    toolTimeoutMs: number | undefined,
  ): Promise<AgentRunResult> {
    const model = request.model;
    const timeoutMs = toolTimeoutMs ?? this.timeoutMs;
    const maxOutput = tools === undefined ? MAX_OUTPUT_BYTES : MAX_TOOL_OUTPUT_BYTES;
    return new Promise<AgentRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(file, args, {
          cwd,
          // The token of our server, for a turn with tools, and nothing else of ours.
          env: childEnv(
            this.baseEnv,
            tools === undefined ? {} : { [TOOL_TOKEN_ENV]: tools.server.token },
          ),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          // Its own process group, so that a kill reaches whatever it started.
          detached: true,
        });
      } catch {
        reject(new AgentRunError("failed", "Codex could not be started."));
        return;
      }
      this.turnsStarted++;

      let outcome:
        | { ok: true; value: AgentRunResult }
        | { ok: false; error: AgentRunError }
        | undefined;
      let exited = false;
      let finished = false;
      let started = false;
      let stderr = "";
      /** What Codex said went wrong, kept only to sort the failure. */
      let errorText = "";
      let received = 0;
      let buffer = "";
      let answer: string | undefined;
      const toolsSeen = new Set<string>();
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const emit = (event: AgentTurnEvent) => {
        try {
          tools?.options.onEvent?.(event);
        } catch {
          // What the caller does with a step must not break the turn.
        }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        if (outcome?.ok) resolve(outcome.value);
        else
          reject(outcome?.error ?? new AgentRunError("failed", "Codex stopped without an answer."));
      };
      const signalTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            // Gone already.
          }
        }
      };
      const kill = (hard: boolean) => {
        if (exited) return;
        signalTree(hard ? "SIGKILL" : "SIGTERM");
        if (!hard) {
          killTimer = setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
          killTimer.unref?.();
        }
      };
      // The first verdict stands. Whoever decides also stops the child; the promise settles once
      // the child is gone, so the directory of the turn is never removed from under it.
      // An answer lets Codex end by itself, so it never stops halfway through writing its own
      // files (a renewed sign-in); only one that lingers is stopped.
      const decide = (o: NonNullable<typeof outcome>, hard = true) => {
        if (outcome !== undefined) return;
        outcome = o;
        if (o.ok) {
          const linger = setTimeout(() => kill(false), KILL_GRACE_MS);
          linger.unref?.();
        } else kill(hard);
        if (exited) finish();
        else {
          const give = setTimeout(finish, KILL_GRACE_MS + 1000);
          give.unref?.();
        }
      };
      const fail = (code: AgentRunError["code"], message: string, untilMs?: number) =>
        decide({ ok: false, error: new AgentRunError(code, message, untilMs) });
      const failFrom = (text: string) => {
        const kind: FailureKind = classifyFailure(text);
        switch (kind) {
          case "notSignedIn":
            return fail("notSignedIn", NOT_SIGNED_IN);
          case "limit":
            return fail("limit", "The plan's limit is reached.", retryAt(text, this.now()));
          case "tooLong":
            return fail("tooLong", `This is too long for ${model}. Ask about less.`);
          case "effort":
            return request.effort === undefined
              ? fail("failed", "Codex reported an error.")
              : fail(
                  "effortRefused",
                  `${model} does not take the effort ${request.effort}. Choose another in Settings.`,
                );
          case "modelGone":
            return fail("failed", `Codex does not offer ${model} now. Choose another in Settings.`);
          case "refused":
            return fail("refused", "The model declined to answer.");
          default:
            return fail("failed", "Codex reported an error.");
        }
      };

      const timer = setTimeout(() => fail("failed", "Codex took too long."), timeoutMs);
      const onAbort = () =>
        decide({ ok: false, error: new AgentRunError("failed", "Cancelled.") }, false);
      signal?.addEventListener("abort", onAbort, { once: true });

      const onItem = (event: Record<string, unknown>) => {
        const verdict = itemVerdict(event.item);
        const id = isObject(event.item) && typeof event.item.id === "string" ? event.item.id : "";
        if (verdict.kind === "forbidden") return fail("failed", OWN_TOOL);
        if (verdict.kind === "tool") {
          if (tools === undefined) return fail("failed", OWN_TOOL);
          if (verdict.server !== tools.server.name || !tools.server.tools.includes(verdict.tool)) {
            return fail("failed", "Codex called a tool that was turned off.");
          }
          if (!toolsSeen.has(id)) {
            toolsSeen.add(id);
            // A line it wrote before this step is its note, not the answer.
            if (answer !== undefined && answer.trim() !== "") emit({ kind: "text", text: answer });
            answer = undefined;
            emit({ kind: "tool", name: verdict.tool, input: verdict.input });
          }
          return;
        }
        if (verdict.kind === "message" && event.type === "item.completed") answer = verdict.text;
      };

      const handle = (line: string) => {
        const event = parseLine(line);
        if (event === null || outcome !== undefined) return;
        switch (event.type) {
          case "thread.started":
            started = true;
            return;
          case "turn.started":
            return;
          case "item.started":
          case "item.updated":
          case "item.completed":
            return onItem(event);
          case "error":
            if (isObject(event) && typeof event.message === "string") {
              errorText = `${errorText}\n${event.message}`.slice(-MAX_STDERR_CHARS);
            }
            return;
          case "turn.failed": {
            const e = event.error;
            const text = isObject(e) && typeof e.message === "string" ? e.message : "";
            return failFrom(`${text}\n${errorText}`);
          }
          case "turn.completed": {
            if (!started) return fail("failed", "The answer came without the start of the turn.");
            if (answer === undefined || answer.trim() === "") {
              return fail("badAnswer", "The answer had no structured output.");
            }
            let value: unknown;
            try {
              value = JSON.parse(answer);
            } catch {
              return fail("badAnswer", "The answer was not in the form asked for.");
            }
            if (value === null || typeof value !== "object") {
              return fail("badAnswer", "The answer was not in the form asked for.");
            }
            return decide({
              ok: true,
              value: { value: dropNulls(value, request.schema), ...tokens(event.usage) },
            });
          }
          default:
            // A kind of event this adapter does not know: it may be an action. Not run unchecked.
            return fail("failed", OWN_TOOL);
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        received += chunk.length;
        if (received > maxOutput) return fail("failed", "Codex wrote too much.");
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
        // A line this long is not an event; drop it rather than grow.
        if (buffer.length > MAX_LINE_CHARS) buffer = "";
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
      });
      child.stdin?.on("error", () => {
        // The child may close its input early (it was killed, or failed to start).
      });
      child.on("error", () => {
        exited = true;
        fail("failed", "Codex could not be started.");
        finish();
      });
      child.on("close", (code) => {
        exited = true;
        if (buffer.length > 0) handle(buffer);
        buffer = "";
        if (outcome === undefined) {
          const text = `${errorText}\n${stderr}`;
          if (classifyFailure(text) === "failed") {
            fail("failed", `Codex ended without an answer (exit ${code ?? "signal"}).`);
          } else failFrom(text);
        }
        finish();
      });

      // The mail goes in here and nowhere else: argv is visible to every process on the machine.
      child.stdin?.end(request.untrusted);
    });
  }
}

function toolTimeout(asked: number | undefined): number {
  return asked !== undefined && Number.isFinite(asked) && asked > 0
    ? Math.min(asked, MAX_TOOL_TIMEOUT_MS)
    : DEFAULT_TOOL_TIMEOUT_MS;
}
