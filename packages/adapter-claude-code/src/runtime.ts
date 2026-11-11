import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  AgentFile,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentToolRunOptions,
  AgentToolServer,
  PlanLimits,
} from "@matters/core";
import { AgentRunError, wholeFilesProblem } from "@matters/core";
import {
  checkInit,
  checkToolInit,
  classifyFailure,
  mergeLimits,
  parseLine,
  resultText,
  tokens,
  toolEventsOf,
} from "./stream.ts";

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeCodeOptions {
  /** A path, or a name looked up on PATH. Default `claude`. */
  readonly binary?: string;
  readonly spawn?: SpawnFn;
  /** Where the empty working directories are made. Default the system temp directory. */
  readonly tmpRoot?: string;
  /** The environment the child starts from. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** For one `run`. Default 120 s. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export const CLAUDE_CODE_ID = "claude-code";
export const MODELS = ["haiku", "sonnet", "opus"] as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const INSPECT_TIMEOUT_MS = 15_000;
/** What is kept of the child's stderr; it is only read to tell failures apart. */
const MAX_STDERR_CHARS = 4096;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2000;
/** A turn with tools gets the tool results back through stdout, so it may write more (ADR 0083). */
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
const MAX_TOOL_TIMEOUT_MS = 300_000;

/**
 * The environment of a turn. An API key, an auth token or a cloud provider switch would move the
 * turn off the person's plan, and a base URL would send their mail to another server (ADR 0051,
 * rule 3 and 4), so nothing that configures the API reaches the child.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("ANTHROPIC_")) continue;
    if (key.startsWith("CLAUDE_CODE_USE_")) continue;
    out[key] = value;
  }
  return out;
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

/** Models are plain aliases or ids; anything that could pass for a flag is refused. */
const EFFORTS: readonly string[] = ["low", "medium", "high"];

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

// The server's words end up in argv, so only these shapes pass (ADR 0083, rule 3).
const SERVER_NAME = /^[a-z][a-z0-9_]{0,30}$/;
const SERVER_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
const SERVER_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_TOOLS = 8;

/**
 * The one user message of a turn with files (ADR 0090, rule 9): each file as a block, a PDF as a
 * `document` and an image as an `image`, then the same text a turn without files gets on stdin.
 */
export function userMessageLine(files: readonly AgentFile[], text: string): string {
  const blocks = files.map((f) => {
    const source = {
      type: "base64",
      media_type: f.mediaType,
      data: Buffer.from(f.bytes).toString("base64"),
    };
    return f.mediaType === "application/pdf"
      ? { type: "document", source }
      : { type: "image", source };
  });
  const message = {
    type: "user",
    message: { role: "user", content: [...blocks, { type: "text", text }] },
  };
  return `${JSON.stringify(message)}\n`;
}

/** What differs between a plain turn and a turn with tools. */
interface TurnHooks {
  readonly checkInit: (event: Record<string, unknown>) => ReturnType<typeof checkInit>;
  /** Looks at each `assistant` event; a string stops the turn with that message. */
  readonly onAssistant?: (event: Record<string, unknown>) => string | undefined;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export class ClaudeCodeRuntime implements AgentRuntimePort {
  readonly id = CLAUDE_CODE_ID;
  readonly name = "Claude Code";
  /** Files go as content blocks of a `stream-json` user message (ADR 0090, rule 9). */
  readonly takesFiles = true;
  private readonly binary: string;
  private readonly spawn: SpawnFn;
  private readonly tmpRoot: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ClaudeCodeOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.spawn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.baseEnv = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Asks the program who is signed in, with `claude auth status`. Reads no file of the program's
   * and no keychain: sign-in is the program's own business (ADR 0051, rule 2). Spends nothing.
   */
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = { id: this.id, name: this.name, models: [...MODELS] };
    const file = findBinary(this.binary, this.baseEnv);
    if (file === null) {
      return {
        ...base,
        status: "missing",
        problem: "Claude Code is not installed, or is not on this app's PATH.",
      };
    }
    let out: { stdout: string; code: number | null } | null;
    try {
      out = await this.capture(file, ["auth", "status"]);
    } catch {
      return { ...base, status: "failed", problem: "Claude Code could not be started." };
    }
    if (out === null) return { ...base, status: "failed", problem: "Claude Code did not answer." };
    const status = parseAuthStatus(out.stdout);
    if (status === null) {
      return {
        ...base,
        status: "failed",
        problem: "Claude Code gave an answer that was not understood.",
      };
    }
    if (status.loggedIn !== true) {
      return {
        ...base,
        status: "signedOut",
        problem: "Not signed in. Run `claude auth login` in a terminal.",
      };
    }
    if (status.authMethod !== "claude.ai") {
      return {
        ...base,
        status: "signedOut",
        problem: "Claude Code is not signed in with a Claude plan. Run `claude auth login`.",
      };
    }
    return {
      ...base,
      status: "found",
      ...(status.subscriptionType === undefined ? {} : { plan: status.subscriptionType }),
    };
  }

  async run(
    request: AgentRunRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    return this.start(request, options.signal, undefined);
  }

  /**
   * A turn that may call the tools of one MCP server of ours, on this machine (ADR 0083, rule 3).
   * The runtime's own tools stay off; the init event must show only ours, or the turn is stopped.
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
    return this.start(request, options.signal, { server, options });
  }

  private async start(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    tools: { server: AgentToolServer; options: AgentToolRunOptions } | undefined,
  ): Promise<AgentRunResult> {
    if (!MODEL_NAME.test(request.model)) throw new AgentRunError("failed", "Unknown model name.");
    // Refused before anything starts: the value ends up in argv, so only the known words pass.
    if (request.effort !== undefined && !EFFORTS.includes(request.effort)) {
      throw new AgentRunError("failed", "Unknown effort.");
    }
    const files = request.files ?? [];
    if (files.length > 0) {
      // Only the answer turn, which has no tools, gets files whole (ADR 0090, rule 3).
      if (tools !== undefined)
        throw new AgentRunError("failed", "Files do not go to a turn with tools.");
      const problem = wholeFilesProblem(files);
      if (problem !== null) throw new AgentRunError("failed", problem);
    }
    if (signal?.aborted) throw new AgentRunError("failed", "Cancelled.");
    const file = findBinary(this.binary, this.baseEnv);
    if (file === null) throw new AgentRunError("failed", "Claude Code was not found.");
    let schema: string;
    try {
      schema = JSON.stringify(request.schema);
    } catch {
      throw new AgentRunError("failed", "The schema cannot be serialized.");
    }
    const cwd = await mkdtemp(join(this.tmpRoot, "matters-agent-"));
    try {
      let configPath: string | undefined;
      if (tools !== undefined) {
        configPath = join(cwd, "mcp.json");
        const config = {
          mcpServers: {
            [tools.server.name]: {
              type: "http",
              url: tools.server.url,
              headers: { Authorization: `Bearer ${tools.server.token}` },
            },
          },
        };
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      }
      const args = [
        "-p",
        "--model",
        request.model,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        // Each of these is followed by another flag, so neither can take a later argument. The
        // bearer token is in a file only this user can read, not in argv, which every process on the
        // machine can see.
        ...(configPath === undefined
          ? []
          : [
              "--mcp-config",
              configPath,
              "--allowedTools",
              tools?.server.tools.map((t) => `mcp__${tools.server.name}__${t}`).join(",") ?? "",
            ]),
        "--no-session-persistence",
        "--system-prompt",
        request.instructions,
        ...(files.length === 0 ? [] : ["--input-format", "stream-json"]),
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        schema,
        // Only when asked for: without it the program uses its own default for the model.
        ...(request.effort === undefined ? [] : ["--effort", request.effort]),
      ];
      const stdin =
        files.length === 0 ? request.untrusted : userMessageLine(files, request.untrusted);
      return await this.turn(file, args, cwd, stdin, signal, this.hooksFor(tools));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private hooksFor(
    tools: { server: AgentToolServer; options: AgentToolRunOptions } | undefined,
  ): TurnHooks {
    if (tools === undefined) {
      return { checkInit, timeoutMs: this.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES };
    }
    const { server, options } = tools;
    const asked = options.timeoutMs;
    const timeoutMs =
      asked !== undefined && Number.isFinite(asked) && asked > 0
        ? Math.min(asked, MAX_TOOL_TIMEOUT_MS)
        : DEFAULT_TOOL_TIMEOUT_MS;
    return {
      checkInit: (event) => checkToolInit(event, server),
      onAssistant: (event) => {
        const found = toolEventsOf(event, server);
        for (const item of found.events) {
          try {
            options.onEvent?.(item);
          } catch {
            // What the caller does with a step must not break the turn.
          }
        }
        return found.stop;
      },
      timeoutMs,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    };
  }

  /** Runs a short command to the end and returns its stdout. `null`: it took too long. */
  private async capture(
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; code: number | null } | null> {
    const cwd = await mkdtemp(join(this.tmpRoot, "matters-agent-"));
    try {
      return await new Promise((resolve, reject) => {
        const child = this.spawn(file, args, {
          cwd,
          env: scrubEnv(this.baseEnv),
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
        let stdout = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, INSPECT_TIMEOUT_MS);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (stdout.length < MAX_LINE_CHARS) stdout += chunk;
        });
        child.stderr?.resume();
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(timedOut ? null : { stdout, code });
        });
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private turn(
    file: string,
    args: readonly string[],
    cwd: string,
    stdin: string,
    signal: AbortSignal | undefined,
    hooks: TurnHooks,
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(file, args, {
          cwd,
          env: scrubEnv(this.baseEnv),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
      } catch {
        reject(new AgentRunError("failed", "Claude Code could not be started."));
        return;
      }

      let outcome:
        | { ok: true; value: AgentRunResult }
        | { ok: false; error: AgentRunError }
        | undefined;
      let exited = false;
      let finished = false;
      let limits: PlanLimits | undefined;
      let sawInit = false;
      let stderr = "";
      let received = 0;
      let buffer = "";
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        if (outcome?.ok) resolve(outcome.value);
        else
          reject(
            outcome?.error ?? new AgentRunError("failed", "Claude Code stopped without an answer."),
          );
      };
      const kill = (hard: boolean) => {
        if (exited) return;
        child.kill(hard ? "SIGKILL" : "SIGTERM");
        if (!hard) {
          killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          killTimer.unref?.();
        }
      };
      // The first verdict stands. Whoever decides also stops the child; the promise settles once
      // the child is gone, so the working directory is never removed from under a live process.
      const decide = (o: NonNullable<typeof outcome>, hard = true) => {
        if (outcome !== undefined) return;
        outcome = o;
        kill(hard);
        if (exited) finish();
        else {
          // A grandchild holding the pipes open must not hold us.
          const give = setTimeout(finish, KILL_GRACE_MS + 1000);
          give.unref?.();
        }
      };
      const fail = (code: AgentRunError["code"], message: string, hard = true) =>
        decide({ ok: false, error: new AgentRunError(code, message) }, hard);

      const timer = setTimeout(() => fail("failed", "Claude Code took too long."), hooks.timeoutMs);
      const onAbort = () => fail("failed", "Cancelled.", false);
      signal?.addEventListener("abort", onAbort, { once: true });

      const handle = (line: string) => {
        const event = parseLine(line);
        if (event === null || outcome !== undefined) return;
        if (event.type === "system" && event.subtype === "init") {
          sawInit = true;
          const verdict = hooks.checkInit(event);
          if (!verdict.ok) {
            if (verdict.why === "notPlan") {
              fail("notPlan", "The turn would not run on a Claude plan.");
            } else fail("failed", "Claude Code offered tools that were turned off.");
          }
        } else if (event.type === "assistant") {
          const stop = hooks.onAssistant?.(event);
          if (stop !== undefined) fail("failed", stop);
        } else if (event.type === "rate_limit_event") {
          limits = mergeLimits(limits, event, this.now());
        } else if (event.type === "result") {
          if (!sawInit) return fail("failed", "The answer came without the start of the turn.");
          if (
            event.is_error === true ||
            (event.subtype !== undefined && event.subtype !== "success")
          ) {
            const kind = classifyFailure(resultText(event));
            return fail(
              kind,
              kind === "notSignedIn"
                ? "Claude Code is not signed in."
                : kind === "limit"
                  ? "The plan's limit is reached."
                  : kind === "refused"
                    ? "The model declined to answer."
                    : "Claude Code reported an error.",
            );
          }
          const value = event.structured_output;
          if (value === undefined || value === null) {
            return fail("badAnswer", "The answer had no structured output.");
          }
          decide({
            ok: true,
            value: { value, ...(limits === undefined ? {} : { limits }), ...tokens(event.usage) },
          });
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        received += chunk.length;
        if (received > hooks.maxOutputBytes) return fail("failed", "Claude Code wrote too much.");
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
        // The child may close its input early (it was killed, or it needs none).
      });
      child.on("error", () => {
        exited = true;
        fail("failed", "Claude Code could not be started.");
        finish();
      });
      child.on("close", (code) => {
        exited = true;
        if (buffer.length > 0) handle(buffer);
        buffer = "";
        if (outcome === undefined) {
          const kind = classifyFailure(stderr);
          fail(
            kind === "notSignedIn" ? "notSignedIn" : "failed",
            kind === "notSignedIn"
              ? "Claude Code is not signed in."
              : `Claude Code ended without an answer (exit ${code ?? "signal"}).`,
          );
        }
        finish();
      });

      // The mail goes in here and nowhere else: argv is visible to every process on the machine.
      child.stdin?.end(stdin);
    });
  }
}

function parseAuthStatus(
  text: string,
): { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    return {
      ...(typeof o.loggedIn === "boolean" ? { loggedIn: o.loggedIn } : {}),
      ...(typeof o.authMethod === "string" ? { authMethod: o.authMethod } : {}),
      ...(typeof o.subscriptionType === "string" ? { subscriptionType: o.subscriptionType } : {}),
    };
  } catch {
    return null;
  }
}
