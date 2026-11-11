/**
 * The answers a model gives, as JSON Schema for the runtime and as strict validators for us
 * (ADR 0051, rule 9). The schema asks; the validator decides. Messages of a thread are numbered
 * 1..n in the prompt, so answers name a message by `message: number`, never by a key or an id.
 */
import { MAX_INSTRUCTION_CHARS } from "./agent.ts";

export const MAX_QUOTE_CHARS = 500;
export const MAX_DRAFT_CHARS = 20_000;
export const MAX_MISSING_CHARS = 500;
export const MAX_DIRECTION_CHARS = 200;
export const MAX_DIRECTIONS = 3;
export const MAX_REASON_CHARS = 200;

export type PreparedAnswer =
  | { readonly kind: "draft"; readonly body: string; readonly nudge: boolean }
  | { readonly kind: "needs"; readonly missing: string; readonly directions: readonly string[] }
  | { readonly kind: "closed"; readonly reason: string };

/** The answer of a turn in a talk about a thread (ADR 0064, rule 6). */
export type TalkAnswer =
  | {
      readonly kind: "answer";
      readonly text: string;
      readonly quotes: readonly { readonly message: number; readonly quote: string }[];
    }
  | { readonly kind: "draft"; readonly body: string; readonly nudge: boolean }
  | { readonly kind: "needs"; readonly missing: string; readonly directions: readonly string[] }
  | { readonly kind: "closed"; readonly reason: string };

/** An answer is one short paragraph. */
export const MAX_TALK_TEXT_CHARS = 800;
export const MAX_TALK_QUOTES = 3;

export const MAX_REMEMBER_ITEMS = 3;

// --- The talk across all mail (ADR 0064, rule 7) ---

/** The query the search turn returns, in the language of ADR 0025. */
export const MAX_TALK_QUERY_CHARS = 300;
/** The longest age that makes sense to ask for, in days. */
export const MAX_TALK_OLDER_DAYS = 3650;
/** A note on one hit: a line, in the language of the person's words. */
export const MAX_TALK_NOTE_CHARS = 160;
export const MAX_TALK_ALL_THREADS = 20;

/**
 * The plan turn of a talk across all mail (ADR 0080): what the person is after, where to look,
 * what to avoid. It names no thread and holds no text from the mail. Limits are starting values.
 */
export const MAX_TALK_TRAILS = 5;
export const MAX_TRAIL_QUERIES = 3;
export const MAX_PLAN_QUERIES = 8;
export const MAX_PLAN_NOTES = 5;
export const MAX_TRAIL_NAME_CHARS = 80;
export const MAX_TRAIL_WHY_CHARS = 200;
export const MAX_PLAN_GOAL_CHARS = 300;
export const MAX_PLAN_NOTE_CHARS = 200;

export interface TalkTrail {
  readonly name: string;
  readonly why: string;
  /** 1 (side thought) to 5 (most likely). */
  readonly priority: number;
  /** One to three queries in the language of ADR 0025. */
  readonly queries: readonly string[];
}

export interface TalkPlanAnswer {
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly trails: readonly TalkTrail[];
  /** Kinds of mail that would only add noise, to be told to the follow turns. */
  readonly traps: readonly string[];
  readonly olderThanDays?: number;
  /**
   * The words continue the earlier talk ("and from X?", "that one", "why did you not find it"). When
   * false, the earlier talk and what the last question found are background only (ADR 0081).
   */
  readonly followsUp: boolean;
  /**
   * "recent": newer mail is likelier the answer (what waits, what was said lately). "any": the
   * whole history counts alike (every time something happened, everything about X).
   */
  readonly time: TalkTime;
}

export type TalkTime = "recent" | "any";
export const TALK_TIMES: readonly TalkTime[] = ["recent", "any"];

/** The follow turns: after a round of searching, what to read and where to look next. */
export const MAX_FOLLOW_KEEP = 20;
export const MAX_FOLLOW_QUERIES = 4;
export const MAX_FOLLOW_DROPS = 5;
export const MAX_HYPOTHESIS_CHARS = 400;

export interface TalkFollowAnswer {
  readonly decision: "answer" | "follow";
  /** Numbers of candidate threads worth reading in full. */
  readonly keep: readonly number[];
  readonly newQueries?: readonly string[];
  readonly dropTrails?: readonly string[];
  readonly hypothesis: string;
}

/** The answer turn across threads. Quotes name a message of the thread they sit in. */
export interface TalkAllAnswer {
  readonly text: string;
  readonly threads: readonly {
    readonly thread: number;
    readonly note: string;
    readonly quotes: readonly { readonly message: number; readonly quote: string }[];
  }[];
}

/** One thing the turn that remembers decided to keep. `text` is absent for `sender` only. */
export interface RememberItem {
  readonly scope: "general" | "understand" | "write" | "thread" | "sender";
  readonly text?: string;
}

export interface RememberAnswer {
  readonly items: readonly RememberItem[];
}

export const PREPARED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["draft", "needs"] },
    body: { type: "string", minLength: 1, maxLength: MAX_DRAFT_CHARS },
    nudge: { type: "boolean" },
    missing: { type: "string", minLength: 1, maxLength: MAX_MISSING_CHARS },
    directions: {
      type: "array",
      maxItems: MAX_DIRECTIONS,
      items: { type: "string", minLength: 1, maxLength: MAX_DIRECTION_CHARS },
    },
  },
} as const;

/**
 * The same, for when the person has given a direction or their own words: the answer may only be
 * a draft, since asking them again for what they just told us would be no help.
 */
export const PREPARED_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "body", "nudge"],
  properties: {
    kind: { type: "string", enum: ["draft"] },
    body: PREPARED_SCHEMA.properties.body,
    nudge: PREPARED_SCHEMA.properties.nudge,
  },
} as const;

/**
 * For when the person typed their own words: a draft, or `closed` with a one-line reason when those
 * words say nothing should be written (ADR 0054). One flat object, for the same reason as above;
 * the backend accepts `closed` only on a turn that has words.
 */
export const PREPARED_GUIDED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["draft", "closed"] },
    body: PREPARED_SCHEMA.properties.body,
    nudge: PREPARED_SCHEMA.properties.nudge,
    reason: { type: "string", minLength: 1, maxLength: MAX_REASON_CHARS },
  },
} as const;

/**
 * The answer in a talk about a thread (ADR 0064). One flat object, as above; `kind` says which of
 * the other keys must be present, and `parseTalkAnswer` insists on it.
 */
export const TALK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["answer", "draft", "needs", "closed"] },
    text: { type: "string", minLength: 1, maxLength: MAX_TALK_TEXT_CHARS },
    quotes: {
      type: "array",
      maxItems: MAX_TALK_QUOTES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["message", "quote"],
        properties: {
          message: { type: "integer", minimum: 1 },
          quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
        },
      },
    },
    body: PREPARED_SCHEMA.properties.body,
    nudge: PREPARED_SCHEMA.properties.nudge,
    missing: PREPARED_SCHEMA.properties.missing,
    directions: PREPARED_SCHEMA.properties.directions,
    reason: { type: "string", minLength: 1, maxLength: MAX_REASON_CHARS },
  },
} as const;

const QUERY_STRING = { type: "string", minLength: 1, maxLength: MAX_TALK_QUERY_CHARS } as const;

/** The plan turn of a talk across all mail (ADR 0080). */
export const TALK_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "followsUp", "time", "assumptions", "trails", "traps"],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: MAX_PLAN_GOAL_CHARS },
    followsUp: { type: "boolean" },
    time: { type: "string", enum: ["recent", "any"] },
    assumptions: {
      type: "array",
      maxItems: MAX_PLAN_NOTES,
      items: { type: "string", minLength: 1, maxLength: MAX_PLAN_NOTE_CHARS },
    },
    trails: {
      type: "array",
      maxItems: MAX_TALK_TRAILS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "why", "priority", "queries"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: MAX_TRAIL_NAME_CHARS },
          why: { type: "string", minLength: 1, maxLength: MAX_TRAIL_WHY_CHARS },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          queries: { type: "array", minItems: 1, maxItems: MAX_TRAIL_QUERIES, items: QUERY_STRING },
        },
      },
    },
    traps: {
      type: "array",
      maxItems: MAX_PLAN_NOTES,
      items: { type: "string", minLength: 1, maxLength: MAX_PLAN_NOTE_CHARS },
    },
    olderThanDays: { type: "integer", minimum: 0, maximum: MAX_TALK_OLDER_DAYS },
  },
} as const;

/** A follow turn of a talk across all mail (ADR 0080). */
export const TALK_FOLLOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "keep", "hypothesis"],
  properties: {
    decision: { type: "string", enum: ["answer", "follow"] },
    keep: {
      type: "array",
      maxItems: MAX_FOLLOW_KEEP,
      items: { type: "integer", minimum: 1 },
    },
    newQueries: { type: "array", maxItems: MAX_FOLLOW_QUERIES, items: QUERY_STRING },
    dropTrails: {
      type: "array",
      maxItems: MAX_FOLLOW_DROPS,
      items: { type: "string", minLength: 1, maxLength: MAX_TRAIL_NAME_CHARS },
    },
    hypothesis: { type: "string", maxLength: MAX_HYPOTHESIS_CHARS },
  },
} as const;

/** The answer turn of a talk across all mail: one line, and the threads it cites. */
export const TALK_ALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "threads"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_TALK_TEXT_CHARS },
    threads: {
      type: "array",
      maxItems: MAX_TALK_ALL_THREADS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["thread", "note", "quotes"],
        properties: {
          thread: { type: "integer", minimum: 1 },
          note: { type: "string", minLength: 1, maxLength: MAX_TALK_NOTE_CHARS },
          quotes: {
            type: "array",
            maxItems: MAX_TALK_QUOTES,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["message", "quote"],
              properties: {
                message: { type: "integer", minimum: 1 },
                quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * What to keep from the person's typed words (ADR 0054). Flat objects, with `text` optional in the
 * schema because only `sender` goes without it; `parseRememberAnswer` insists on that.
 */
export const REMEMBER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: MAX_REMEMBER_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scope"],
        properties: {
          scope: { type: "string", enum: ["general", "understand", "write", "thread", "sender"] },
          text: { type: "string", minLength: 1, maxLength: MAX_INSTRUCTION_CHARS },
        },
      },
    },
  },
} as const;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys may be present, and `required` must be. */
function hasKeys(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => k in o) && keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** The prepared-work answer as it is, or `null`. */
export function parsePreparedAnswer(value: unknown): PreparedAnswer | null {
  if (!isObject(value)) return null;
  if (value.kind === "draft") {
    if (!hasKeys(value, ["kind", "body", "nudge"])) return null;
    const body = text(value.body, MAX_DRAFT_CHARS);
    if (body === null || typeof value.nudge !== "boolean") return null;
    return { kind: "draft", body, nudge: value.nudge };
  }
  if (value.kind === "needs") {
    if (!hasKeys(value, ["kind", "missing", "directions"])) return null;
    const missing = text(value.missing, MAX_MISSING_CHARS);
    if (missing === null) return null;
    if (!Array.isArray(value.directions) || value.directions.length > MAX_DIRECTIONS) return null;
    const directions: string[] = [];
    for (const d of value.directions) {
      const direction = text(d, MAX_DIRECTION_CHARS);
      if (direction === null) return null;
      directions.push(direction);
    }
    return { kind: "needs", missing, directions };
  }
  if (value.kind === "closed") {
    if (!hasKeys(value, ["kind", "reason"])) return null;
    const reason = text(value.reason, MAX_REASON_CHARS);
    if (reason === null) return null;
    return { kind: "closed", reason };
  }
  return null;
}

/** The answer in a talk as it is, or `null`. Quotes are not yet checked against the mail. */
export function parseTalkAnswer(value: unknown): TalkAnswer | null {
  if (!isObject(value)) return null;
  if (value.kind === "answer") {
    if (!hasKeys(value, ["kind", "text"], ["quotes"])) return null;
    const answer = text(value.text, MAX_TALK_TEXT_CHARS);
    if (answer === null) return null;
    const raw = value.quotes ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_TALK_QUOTES) return null;
    const quotes: { message: number; quote: string }[] = [];
    for (const q of raw) {
      if (!isObject(q) || !hasKeys(q, ["message", "quote"])) return null;
      const quote = text(q.quote, MAX_QUOTE_CHARS);
      const message = q.message;
      if (quote === null || typeof message !== "number") return null;
      if (!Number.isInteger(message) || message < 1) return null;
      quotes.push({ message, quote });
    }
    return { kind: "answer", text: answer, quotes };
  }
  // The other kinds are the prepared answers, with the same keys and the same limits.
  return parsePreparedAnswer(value);
}

function parseStrings(raw: unknown, max: number, each: number): string[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: string[] = [];
  for (const item of raw) {
    const one = text(item, each);
    if (one === null) return null;
    out.push(one.trim());
  }
  return out;
}

/**
 * The plan turn's answer as it is, or `null`. No trail is a valid plan. Limits (ADR 0080): at most 5 trails, 3 queries each, 300 characters each. Past 8 queries
 * in all, the likeliest trails keep theirs and the rest are dropped, rather than the whole plan.
 */
export function parseTalkPlan(value: unknown): TalkPlanAnswer | null {
  if (
    !isObject(value) ||
    !hasKeys(
      value,
      ["goal", "assumptions", "trails", "traps"],
      // `vocabulary` and `state` are keys of plans cached by earlier builds; they are ignored.
      ["state", "olderThanDays", "followsUp", "time", "vocabulary"],
    )
  ) {
    return null;
  }
  const goal = text(value.goal, MAX_PLAN_GOAL_CHARS);
  const assumptions = parseStrings(value.assumptions, MAX_PLAN_NOTES, MAX_PLAN_NOTE_CHARS);
  const traps = parseStrings(value.traps, MAX_PLAN_NOTES, MAX_PLAN_NOTE_CHARS);
  if (goal === null || assumptions === null || traps === null) return null;
  if (!Array.isArray(value.trails) || value.trails.length > MAX_TALK_TRAILS) return null;
  const trails: TalkTrail[] = [];
  let queries = 0;
  for (const raw of value.trails) {
    if (!isObject(raw) || !hasKeys(raw, ["name", "why", "priority", "queries"])) return null;
    const name = text(raw.name, MAX_TRAIL_NAME_CHARS);
    const why = text(raw.why, MAX_TRAIL_WHY_CHARS);
    const priority = raw.priority;
    const list = parseStrings(raw.queries, MAX_TRAIL_QUERIES, MAX_TALK_QUERY_CHARS);
    if (name === null || why === null || list === null || list.length === 0) return null;
    if (typeof priority !== "number" || !Number.isInteger(priority)) return null;
    if (priority < 1 || priority > 5) return null;
    trails.push({ name: name.trim(), why: why.trim(), priority, queries: list });
  }
  // The schema cannot cap the queries of all trails together, and a model that writes too many
  // has still planned well: keep the queries of the likeliest trails up to the cap, drop the rest.
  const byPriority = trails
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i);
  const kept = new Map<number, TalkTrail>();
  for (const { t, i } of byPriority) {
    const room = MAX_PLAN_QUERIES - queries;
    if (room <= 0) break;
    const list = t.queries.slice(0, room);
    queries += list.length;
    kept.set(i, { ...t, queries: list });
  }
  trails.splice(
    0,
    trails.length,
    ...[...kept.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
  );
  // Absent: a plan from before ADR 0081 stands on its own and weighs recency as it did.
  const followsUp = value.followsUp === undefined ? false : value.followsUp;
  if (typeof followsUp !== "boolean") return null;
  const time = value.time === undefined ? "recent" : oneOf(value.time, TALK_TIMES);
  if (time === null) return null;
  const days = value.olderThanDays;
  if (
    days !== undefined &&
    (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_TALK_OLDER_DAYS)
  ) {
    return null;
  }
  return {
    goal: goal.trim(),
    assumptions,
    trails,
    traps,
    followsUp,
    time,
    ...(days === undefined ? {} : { olderThanDays: days }),
  };
}

/** A follow turn's answer as it is, or `null`. Numbers are not yet checked against the candidates. */
export function parseTalkFollow(value: unknown): TalkFollowAnswer | null {
  if (
    !isObject(value) ||
    !hasKeys(value, ["decision", "keep", "hypothesis"], ["newQueries", "dropTrails"])
  ) {
    return null;
  }
  const decision = oneOf(value.decision, ["answer", "follow"] as const);
  if (decision === null) return null;
  if (typeof value.hypothesis !== "string" || value.hypothesis.length > MAX_HYPOTHESIS_CHARS) {
    return null;
  }
  if (!Array.isArray(value.keep) || value.keep.length > MAX_FOLLOW_KEEP) return null;
  const keep: number[] = [];
  for (const n of value.keep) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || keep.includes(n)) return null;
    keep.push(n);
  }
  let newQueries: string[] | undefined;
  if ("newQueries" in value) {
    const list = parseStrings(value.newQueries, MAX_FOLLOW_QUERIES, MAX_TALK_QUERY_CHARS);
    if (list === null) return null;
    newQueries = list;
  }
  let dropTrails: string[] | undefined;
  if ("dropTrails" in value) {
    const list = parseStrings(value.dropTrails, MAX_FOLLOW_DROPS, MAX_TRAIL_NAME_CHARS);
    if (list === null) return null;
    dropTrails = list;
  }
  return {
    decision,
    keep,
    hypothesis: value.hypothesis.trim(),
    ...(newQueries === undefined ? {} : { newQueries }),
    ...(dropTrails === undefined ? {} : { dropTrails }),
  };
}

function parseTalkQuotes(raw: unknown): { message: number; quote: string }[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TALK_QUOTES) return null;
  const quotes: { message: number; quote: string }[] = [];
  for (const q of raw) {
    if (!isObject(q) || !hasKeys(q, ["message", "quote"])) return null;
    const quote = text(q.quote, MAX_QUOTE_CHARS);
    const message = q.message;
    if (quote === null || typeof message !== "number") return null;
    if (!Number.isInteger(message) || message < 1) return null;
    quotes.push({ message, quote });
  }
  return quotes;
}

/** The answer turn across threads as it is, or `null`. Numbers and quotes are not yet checked. */
export function parseTalkAllAnswer(value: unknown): TalkAllAnswer | null {
  if (!isObject(value) || !hasKeys(value, ["text", "threads"])) return null;
  const answer = text(value.text, MAX_TALK_TEXT_CHARS);
  if (answer === null) return null;
  if (!Array.isArray(value.threads) || value.threads.length > MAX_TALK_ALL_THREADS) return null;
  const threads: TalkAllAnswer["threads"][number][] = [];
  for (const raw of value.threads) {
    if (!isObject(raw) || !hasKeys(raw, ["thread", "note", "quotes"])) return null;
    const note = text(raw.note, MAX_TALK_NOTE_CHARS);
    const thread = raw.thread;
    const quotes = parseTalkQuotes(raw.quotes);
    if (note === null || quotes === null || typeof thread !== "number") return null;
    if (!Number.isInteger(thread) || thread < 1) return null;
    threads.push({ thread, note, quotes });
  }
  return { text: answer, threads };
}

/** The answer of the turn that remembers as it is, or `null`. An empty list is a valid answer. */
export function parseRememberAnswer(value: unknown): RememberAnswer | null {
  if (!isObject(value) || !hasKeys(value, ["items"])) return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_REMEMBER_ITEMS) return null;
  const items: RememberItem[] = [];
  for (const raw of value.items) {
    if (!isObject(raw) || !hasKeys(raw, ["scope"], ["text"])) return null;
    const scope = oneOf(raw.scope, ["general", "understand", "write", "thread", "sender"] as const);
    if (scope === null) return null;
    if (scope === "sender") {
      if ("text" in raw) return null;
      items.push({ scope });
      continue;
    }
    const body = text(raw.text, MAX_INSTRUCTION_CHARS);
    if (body === null) return null;
    items.push({ scope, text: body });
  }
  return { items };
}

// --- A prompt is a filter (ADR 0116) ---

/** Most threads of one batch, and so of one answer (ADR 0116, rule 9). */
export const MAX_PROMPT_BATCH_THREADS = 10;
export const MAX_PROMPT_WHY_CHARS = 300;
/** `fit` runs from 0 (does not fit) to this (fits strongly) (ADR 0116, rule 6). */
export const MAX_PROMPT_FIT = 3;

/** One thread of a batch as the model judged it. Numbers and the quote are not yet checked. */
export interface PromptAnswerItem {
  /** 1-based number of the thread in the turn. */
  readonly thread: number;
  readonly fit: number;
  readonly why: string;
  /** 1-based number of the message within that thread; with `quote`, only for a fit above 0. */
  readonly message?: number;
  readonly quote?: string;
}

export interface PromptAnswer {
  readonly verdicts: readonly PromptAnswerItem[];
}

/** The answer of a batch: one verdict per thread (ADR 0116, rule 6). */
export const PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      maxItems: MAX_PROMPT_BATCH_THREADS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["thread", "fit", "why"],
        properties: {
          thread: { type: "integer", minimum: 1 },
          fit: { type: "integer", minimum: 0, maximum: MAX_PROMPT_FIT },
          why: { type: "string", minLength: 1, maxLength: MAX_PROMPT_WHY_CHARS },
          message: { type: "integer", minimum: 1 },
          quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
        },
      },
    },
  },
} as const;

/** The answer of a batch as it is, or `null`. Thread numbers and quotes are not yet checked. */
export function parsePromptAnswer(value: unknown): PromptAnswer | null {
  if (!isObject(value) || !hasKeys(value, ["verdicts"])) return null;
  if (!Array.isArray(value.verdicts) || value.verdicts.length > MAX_PROMPT_BATCH_THREADS) {
    return null;
  }
  const verdicts: PromptAnswerItem[] = [];
  for (const raw of value.verdicts) {
    if (!isObject(raw) || !hasKeys(raw, ["thread", "fit", "why"], ["message", "quote"])) {
      return null;
    }
    const { thread, fit, message } = raw;
    const why = text(raw.why, MAX_PROMPT_WHY_CHARS);
    const quote = "quote" in raw ? text(raw.quote, MAX_QUOTE_CHARS) : undefined;
    if (why === null || quote === null) return null;
    if (typeof thread !== "number" || !Number.isInteger(thread) || thread < 1) return null;
    if (typeof fit !== "number" || !Number.isInteger(fit) || fit < 0 || fit > MAX_PROMPT_FIT) {
      return null;
    }
    if (
      message !== undefined &&
      (typeof message !== "number" || !Number.isInteger(message) || message < 1)
    ) {
      return null;
    }
    verdicts.push({
      thread,
      fit,
      why,
      ...(message === undefined ? {} : { message }),
      ...(quote === undefined ? {} : { quote }),
    });
  }
  return { verdicts };
}
