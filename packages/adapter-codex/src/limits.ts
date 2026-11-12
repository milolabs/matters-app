// The plan's windows, read apart from a turn (ADR 0120, rule 9). `codex exec` reports none, but
// Codex's own server for client apps, `codex app-server`, answers `account/rateLimits/read`: JSON-RPC,
// one message per line on stdio. The adapter starts it as closed as a turn, sends the handshake and
// that one request and nothing else, refuses anything the server asks of it, and stops it once the
// answer is in. No thread is started and no model runs.

import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanLimits, PlanWindow } from "@matters/core";
import type { SpawnFn } from "./runtime.ts";
import { isObject } from "./stream.ts";
import { closedServerArgs } from "./switches.ts";

/** What one read says: the windows, when it reports any, and the plan's name. */
export interface ReadLimits {
  readonly limits?: PlanLimits;
  readonly plan?: string;
}

/** A window of one day or less, when it is the only one, is the session; a longer one the week. */
const SESSION_MAX_MINS = 24 * 60;
/** The plan's name goes to the person as it is: only a plain word passes. */
const PLAN_NAME = /^[a-z][a-z0-9_]{0,39}$/;

interface Read {
  readonly window: PlanWindow;
  readonly mins?: number;
}

function readWindow(raw: unknown): Read | undefined {
  if (!isObject(raw)) return undefined;
  const { usedPercent, resetsAt, windowDurationMins } = raw;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  // A window with no reset time cannot age or be waited for: it is left out.
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  const window = {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    // Codex says seconds.
    resetsAtMs: Math.round(resetsAt * 1000),
  };
  return typeof windowDurationMins === "number" &&
    Number.isFinite(windowDurationMins) &&
    windowDurationMins > 0
    ? { window, mins: windowDurationMins }
    : { window };
}

/**
 * The answer of `account/rateLimits/read`, in our terms. Pure; never throws.
 *
 * - The snapshot of the `codex` limit when the answer has one by name, else the single one.
 * - Of two windows the shorter is the session and the longer the week, whichever of `primary` and
 *   `secondary` they are; with no lengths, or equal ones, `primary` is the session. A lone window of
 *   at most a day is the session, a longer one the week; with no length, its slot decides.
 * - The plan bills on top of its allowance (`usingOverage`) only when a window is full, or Codex says
 *   a limit is reached, and the account has credits to spend.
 * - No window understood: no limits, so what was known stays.
 */
export function parseRateLimits(result: unknown, nowMs: number): ReadLimits {
  if (!isObject(result)) return {};
  const byId = isObject(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId.codex : undefined;
  const snapshot = isObject(byId) ? byId : result.rateLimits;
  if (!isObject(snapshot)) return {};
  const planType =
    typeof snapshot.planType === "string"
      ? snapshot.planType
      : isObject(result.rateLimits) && typeof result.rateLimits.planType === "string"
        ? result.rateLimits.planType
        : undefined;
  const plan =
    planType !== undefined && planType !== "unknown" && PLAN_NAME.test(planType)
      ? { plan: planType }
      : {};

  const primary = readWindow(snapshot.primary);
  const secondary = readWindow(snapshot.secondary);
  let session: PlanWindow | undefined;
  let week: PlanWindow | undefined;
  if (primary !== undefined && secondary !== undefined) {
    const swapped =
      primary.mins !== undefined && secondary.mins !== undefined && primary.mins > secondary.mins;
    session = swapped ? secondary.window : primary.window;
    week = swapped ? primary.window : secondary.window;
  } else {
    const only = primary ?? secondary;
    if (only !== undefined) {
      const isSession = only.mins !== undefined ? only.mins <= SESSION_MAX_MINS : only === primary;
      if (isSession) session = only.window;
      else week = only.window;
    }
  }
  if (session === undefined && week === undefined) return plan;

  const full =
    (session?.usedPercent ?? 0) >= 100 ||
    (week?.usedPercent ?? 0) >= 100 ||
    typeof snapshot.rateLimitReachedType === "string";
  const credits = isObject(snapshot.credits) ? snapshot.credits : {};
  const canSpend = credits.hasCredits === true || credits.unlimited === true;
  return {
    ...plan,
    limits: {
      ...(session === undefined ? {} : { session }),
      ...(week === undefined ? {} : { week }),
      usingOverage: full && canSpend,
      seenAtMs: nowMs,
    },
  };
}

/** The messages the adapter writes, and no other: the handshake and the one request. */
export const INITIALIZE = {
  id: 1,
  method: "initialize",
  params: { clientInfo: { name: "matters", title: "Matters", version: "1" } },
} as const;
export const INITIALIZED = { method: "initialized" } as const;
export const READ_LIMITS = {
  id: 2,
  method: "account/rateLimits/read",
  // A read in the background: the details of reset credits are not needed, only the windows.
  params: { excludeResetCreditDetails: true },
} as const;

/** What the adapter answers to anything the server asks of it. */
const REFUSED = { code: -32601, message: "Not supported." } as const;

const MAX_LINE_CHARS = 1024 * 1024;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

export interface ReadOptions {
  /** The Codex program, found already. */
  readonly file: string;
  readonly spawn: SpawnFn;
  /** The child's whole environment, as for a turn. */
  readonly env: NodeJS.ProcessEnv;
  /** Where the read's own directory is made, and its name's start (swept as a turn's is). */
  readonly tmpRoot: string;
  readonly prefix: string;
  readonly timeoutMs: number;
}

/** A path that goes into a TOML string: no quote, no backslash, nothing to escape. */
const SAFE_PATH = /^\/[A-Za-z0-9._/+-]+$/;

/**
 * Starts `codex app-server` in a directory of its own, asks for the account's limits, and returns
 * the result of that request; null when it fails, is refused, or is late. Never throws. It resolves
 * as soon as the answer is in: the server is stopped then (SIGTERM to its group, SIGKILL after a
 * grace) and its directory is removed once it is gone.
 */
export async function readRateLimits(o: ReadOptions): Promise<unknown> {
  let root: string;
  try {
    root = await mkdtemp(join(o.tmpRoot, o.prefix));
  } catch {
    return null;
  }
  const work = join(root, "work");
  const state = join(root, "state");
  const remove = () => rm(root, { recursive: true, force: true }).catch(() => {});
  try {
    if (!SAFE_PATH.test(state)) throw new Error("odd path");
    await Promise.all([mkdir(work, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
  } catch {
    await remove();
    return null;
  }
  const args = [
    "app-server",
    ...closedServerArgs(),
    "-c",
    'model_provider="openai"',
    "-c",
    `sqlite_home="${state}"`,
    "-c",
    `log_dir="${state}"`,
    "-c",
    "mcp_servers={}",
  ];
  let child: ChildProcess;
  try {
    child = o.spawn(o.file, args, {
      cwd: work,
      env: o.env,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
      // Its own process group, so that a kill reaches whatever it started.
      detached: true,
    });
  } catch {
    await remove();
    return null;
  }
  return new Promise<unknown>((resolve) => {
    let settled = false;
    let exited = false;
    let buffer = "";
    let received = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const signalTree = (sig: NodeJS.Signals) => {
      if (exited) return;
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
    const settle = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
      try {
        child.stdin?.end();
      } catch {
        // Closed already.
      }
      signalTree("SIGTERM");
      if (!exited) {
        killTimer = setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const send = (message: object) => {
      if (settled) return;
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        settle(null);
      }
    };
    const deadline = setTimeout(() => settle(null), o.timeoutMs);

    const handle = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed[0] !== "{") return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!isObject(message) || settled) return;
      const { id } = message;
      const hasId = typeof id === "number" || typeof id === "string";
      if (typeof message.method === "string") {
        // The server asks something of us: refused, whatever it is. A notification is let be.
        if (hasId) send({ id, error: REFUSED });
        return;
      }
      if (id === INITIALIZE.id) {
        if (!Object.hasOwn(message, "result")) return settle(null);
        send(INITIALIZED);
        send(READ_LIMITS);
        return;
      }
      if (id === READ_LIMITS.id) settle(Object.hasOwn(message, "result") ? message.result : null);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      received += chunk.length;
      if (received > MAX_OUTPUT_CHARS) return settle(null);
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) buffer = "";
    });
    child.stdin?.on("error", () => {
      // The child may close its input early (it was killed, or failed to start).
    });
    child.on("error", () => {
      exited = true;
      settle(null);
      void remove();
    });
    child.on("close", () => {
      exited = true;
      clearTimeout(killTimer);
      settle(null);
      void remove();
    });

    send(INITIALIZE);
  });
}
