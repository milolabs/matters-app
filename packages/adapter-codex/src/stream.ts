// What Codex writes, read only to tell answers apart. No text of it ever goes into an error, which
// may reach logs and the person: every message is ours (ADR 0120, rule 10).

type Obj = Record<string, unknown>;

export const isObject = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One line of `--json`, or `null` when it is not a JSON object. Never throws. */
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

/** The kinds of item that are Codex's own tools: any of them in a turn is a failure (rule 3). */
export const OWN_TOOL_ITEMS: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "web_search",
  "collab_tool_call",
  "todo_list",
]);

/** Kinds of item that carry no action: its words, its thinking, a warning. */
const QUIET_ITEMS: ReadonlySet<string> = new Set(["agent_message", "reasoning", "error"]);

export type ItemVerdict =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly server: string;
      readonly tool: string;
      readonly input: unknown;
    }
  | { readonly kind: "quiet" }
  | { readonly kind: "forbidden" };

/**
 * What one item says. A kind not known here counts against the turn: a new version of Codex that
 * reports a new kind of action must fail, not run unchecked.
 */
export function itemVerdict(item: unknown): ItemVerdict {
  if (!isObject(item) || typeof item.type !== "string") return { kind: "forbidden" };
  const type = item.type;
  if (type === "agent_message") {
    return typeof item.text === "string" ? { kind: "message", text: item.text } : { kind: "quiet" };
  }
  if (type === "mcp_tool_call") {
    return {
      kind: "tool",
      server: typeof item.server === "string" ? item.server : "",
      tool: typeof item.tool === "string" ? item.tool : "",
      input: item.arguments,
    };
  }
  if (QUIET_ITEMS.has(type)) return { kind: "quiet" };
  return { kind: "forbidden" };
}

export function tokens(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!isObject(usage)) return {};
  const count = (k: string) =>
    typeof usage[k] === "number" && Number.isFinite(usage[k]) && usage[k] >= 0
      ? usage[k]
      : undefined;
  // Cached input is part of the input; thinking is part of the output.
  const input = count("input_tokens");
  const output = count("output_tokens");
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
  };
}

export type FailureKind =
  | "notSignedIn"
  | "limit"
  | "refused"
  | "modelGone"
  | "effort"
  | "tooLong"
  | "failed";

/**
 * Sorts a failure into something a caller can act on, from the words Codex used. The text is only
 * read here; it is never copied into an error, since it can quote the mail.
 */
export function classifyFailure(text: string): FailureKind {
  const t = text.toLowerCase();
  if (
    /not logged in|log ?in again|codex login|sign in again|unauthori[sz]ed|\b401\b|refresh token|could not be refreshed|token.*expired|authenticat/.test(
      t,
    )
  ) {
    return "notSignedIn";
  }
  if (/usage limit|rate limit|too many requests|\b429\b|quota exceeded/.test(t)) return "limit";
  if (/context window|context length|too long|maximum context|input exceeds/.test(t)) {
    return "tooLong";
  }
  if (/reasoning[._ ]?effort|reasoning level|\beffort\b/.test(t)) return "effort";
  if (
    /model.*(not found|does not exist|not supported|unsupported|unknown|not available)|(unknown|unsupported) model/.test(
      t,
    )
  ) {
    return "modelGone";
  }
  if (/refus|violat|usage polic|flagged|cyber/.test(t)) return "refused";
  return "failed";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When a usage limit lifts, from the words of Codex's refusal: `Try again at 3:45 PM.` for today,
 * or `at Nov 13th, 2026 3:45 PM`, in this Mac's time zone. Undefined when it says no time, or one
 * that is not in the future.
 */
export function retryAt(text: string, nowMs: number): number | undefined {
  const time =
    /try again at\s+(?:([A-Z][a-z]{2})\s+(\d{1,2})(?:st|nd|rd|th),\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(
      text,
    );
  if (time === null) return undefined;
  const [, mon, day, year, hh, mm, ampm] = time;
  let hour = Number(hh) % 12;
  if ((ampm ?? "").toUpperCase() === "PM") hour += 12;
  const minute = Number(mm);
  const now = new Date(nowMs);
  let at: Date;
  if (mon !== undefined && day !== undefined && year !== undefined) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return undefined;
    at = new Date(Number(year), month, Number(day), hour, minute);
  } else {
    at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  }
  const ms = at.getTime();
  return Number.isFinite(ms) && ms > nowMs ? ms : undefined;
}

// --- The schema Codex is given (ADR 0120, rule 5) ---

/** What the answer schema of a turn may hold: Codex sends it in OpenAI's strict mode. */
const STRICT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "description",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

/**
 * Our schema in the form strict mode takes: every object closed and every property required, a
 * property that was optional made nullable, and only the keywords strict mode knows (lengths go:
 * the code checks them when it reads the answer, as for every runtime). `nullable` keeps, for
 * each path, the properties made nullable, so `dropNulls` can take their nulls out again.
 */
export function strictSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const out: Obj = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!STRICT_KEYS.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      const props: Obj = {};
      for (const [name, sub] of Object.entries(value)) props[name] = strictSchema(sub);
      out.properties = props;
    } else if (key === "items") out.items = strictSchema(value);
    else if (key === "anyOf" && Array.isArray(value)) out.anyOf = value.map(strictSchema);
    else out[key] = value;
  }
  if (isObject(out.properties)) {
    const names = Object.keys(out.properties);
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const name of names) {
      if (required.has(name)) continue;
      const sub = (out.properties as Obj)[name];
      (out.properties as Obj)[name] = { anyOf: [sub, { type: "null" }] };
    }
    out.required = names;
    out.additionalProperties = false;
  }
  return out;
}

/**
 * The answer as our schema has it: a null Codex wrote for a property our schema left optional is
 * taken out, as if it were not written. Nothing else changes.
 */
export function dropNulls(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value;
  if (Array.isArray(value)) return value.map((v) => dropNulls(v, schema.items));
  if (!isObject(value) || !isObject(schema.properties)) return value;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out: Obj = {};
  for (const [name, v] of Object.entries(value)) {
    const sub = (schema.properties as Obj)[name];
    if (v === null && sub !== undefined && !required.has(name)) continue;
    out[name] = sub === undefined ? v : dropNulls(v, sub);
  }
  return out;
}
