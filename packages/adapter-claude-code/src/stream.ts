import type { AgentToolServer, AgentTurnEvent, PlanLimits, PlanWindow } from "@matters/core";

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** One line of the stream, or `null` when it is not a JSON object. Never throws. */
export function parseLine(line: string): Obj | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** What `system/init` must say for a turn to be allowed to go on. */
export type InitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: "notPlan" | "tools" };

/**
 * Plan or nothing (ADR 0051, rule 4) and no tools (rule 3). Anything the event does not say
 * plainly counts against it: a CLI that changes its output must fail here, not run unchecked.
 */
export function checkInit(event: Obj): InitVerdict {
  if (event.apiKeySource !== "none") return { ok: false, why: "notPlan" };
  const { tools, mcp_servers: servers } = event;
  if (!Array.isArray(tools) || tools.some((t) => t !== "StructuredOutput")) {
    return { ok: false, why: "tools" };
  }
  if (servers !== undefined && (!Array.isArray(servers) || servers.length > 0)) {
    return { ok: false, why: "tools" };
  }
  return { ok: true };
}

/**
 * The same for a turn with tools (ADR 0083, rule 3): the plan, and then only `StructuredOutput`
 * and the tools of our one server, which must be connected. Anything else, or anything missing,
 * counts against the turn.
 */
export function checkToolInit(event: Obj, server: AgentToolServer): InitVerdict {
  if (event.apiKeySource !== "none") return { ok: false, why: "notPlan" };
  const { tools, mcp_servers: servers } = event;
  const allowed = new Set(["StructuredOutput", ...server.tools.map((t) => toolId(server, t))]);
  if (!Array.isArray(tools) || !tools.includes("StructuredOutput"))
    return { ok: false, why: "tools" };
  if (tools.some((t) => typeof t !== "string" || !allowed.has(t)))
    return { ok: false, why: "tools" };
  if (!Array.isArray(servers) || servers.length !== 1) return { ok: false, why: "tools" };
  const only = servers[0];
  if (!isObject(only) || only.name !== server.name || only.status !== "connected") {
    return { ok: false, why: "tools" };
  }
  return { ok: true };
}

const toolId = (server: AgentToolServer, tool: string) => `mcp__${server.name}__${tool}`;

/**
 * What an `assistant` event shows of a turn with tools: the model's own lines, and the calls of
 * our tools. A call of anything else sets `stop` (defence in depth: init already said no).
 */
export function toolEventsOf(
  event: Obj,
  server: AgentToolServer,
): { events: AgentTurnEvent[]; stop?: string } {
  const events: AgentTurnEvent[] = [];
  const message = event.message;
  const content = isObject(message) ? message.content : undefined;
  if (!Array.isArray(content)) return { events };
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim().length > 0) {
        events.push({ kind: "text", text: block.text });
      }
    } else if (block.type === "tool_use") {
      if (block.name === "StructuredOutput") continue;
      const tool = server.tools.find((t) => block.name === toolId(server, t));
      if (tool === undefined) {
        return { events, stop: "Claude Code called a tool that was turned off." };
      }
      events.push({ kind: "tool", name: tool, input: block.input });
    }
  }
  return { events };
}

function window(raw: unknown): PlanWindow | undefined {
  if (!isObject(raw)) return undefined;
  const { utilization, resetsAt } = raw;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  const percent = Math.round(Math.min(1, Math.max(0, utilization)) * 10_000) / 100;
  return { usedPercent: percent, resetsAtMs: Math.round(resetsAt * 1000) };
}

/**
 * Folds a `rate_limit_event` into what is known. A window the event leaves out keeps its earlier
 * value; the overage flag is the latest word.
 */
export function mergeLimits(
  before: PlanLimits | undefined,
  event: Obj,
  nowMs: number,
): PlanLimits | undefined {
  const info = event.rate_limit_info;
  if (!isObject(info)) return before;
  const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
  const session = window(windows.five_hour) ?? before?.session;
  const week = window(windows.seven_day) ?? before?.week;
  const usingOverage =
    typeof info.isUsingOverage === "boolean"
      ? info.isUsingOverage
      : (before?.usingOverage ?? false);
  if (session === undefined && week === undefined && before === undefined) return undefined;
  return {
    ...(session === undefined ? {} : { session }),
    ...(week === undefined ? {} : { week }),
    usingOverage,
    seenAtMs: nowMs,
  };
}

export function tokens(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!isObject(usage)) return {};
  const count = (k: string) =>
    typeof usage[k] === "number" && Number.isFinite(usage[k]) && usage[k] >= 0
      ? usage[k]
      : undefined;
  const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .map(count)
    .filter((n): n is number => n !== undefined);
  const output = count("output_tokens");
  return {
    ...(parts.length > 0 ? { inputTokens: parts.reduce((a, b) => a + b, 0) } : {}),
    ...(output === undefined ? {} : { outputTokens: output }),
  };
}

export type FailureKind = "notSignedIn" | "limit" | "refused" | "failed";

/**
 * Sorts a failure into something a caller can act on, from the words the CLI used. The text is
 * only read here; it is never copied into an error, since it can quote the mail.
 */
export function classifyFailure(text: string): FailureKind {
  const t = text.toLowerCase();
  if (
    /not logged in|please run \/login|\/login|log in|sign in|logged out|authenticat|oauth|invalid api key|credential/.test(
      t,
    )
  ) {
    return "notSignedIn";
  }
  if (/rate.?limit|usage limit|limit reached|quota|too many requests|overloaded|\b429\b/.test(t)) {
    return "limit";
  }
  if (/refus|violates|usage polic/.test(t)) return "refused";
  return "failed";
}

export function resultText(event: Obj): string {
  const parts: string[] = [];
  if (typeof event.result === "string") parts.push(event.result);
  if (typeof event.subtype === "string") parts.push(event.subtype);
  if (typeof event.stop_reason === "string") parts.push(event.stop_reason);
  if (Array.isArray(event.errors)) {
    for (const e of event.errors) if (typeof e === "string") parts.push(e);
  }
  return parts.join(" ");
}
