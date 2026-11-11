/**
 * The two answers a model gives, as JSON Schema for the runtime and as strict validators for us
 * (ADR 0051, rule 9). The schema asks; the validator decides. Messages of a thread are numbered
 * 1..n in the prompt, so answers name a message by `message: number`, never by a key or an id.
 */
import type {
  AmountRole,
  AnalysisIntent,
  CaseStatus,
  Consequence,
  Stakes,
  ThreadCategory,
  ThreadState,
} from "./agent.ts";
import {
  AMOUNT_ROLES,
  ANALYSIS_INTENTS,
  CASE_STATUSES,
  MAX_INSTRUCTION_CHARS,
  THREAD_CATEGORIES,
} from "./agent.ts";

export const MAX_HEADLINE_CHARS = 200;
export const MAX_QUOTE_CHARS = 500;
export const MAX_FACTS = 12;
export const MAX_DRAFT_CHARS = 20_000;
export const MAX_MISSING_CHARS = 500;
export const MAX_DIRECTION_CHARS = 200;
export const MAX_DIRECTIONS = 3;
export const MAX_REASON_CHARS = 200;
export const MAX_CASE_CHARS = 120;
export const MAX_ANCHOR_CHARS = 80;
export const MAX_ANCHORS = 6;

export interface AnalysisAnswerFact {
  readonly kind: "promise" | "ask";
  readonly who: "you" | "them";
  /** 1-based number of the message the quote comes from. */
  readonly message: number;
  readonly quote: string;
  /** `YYYY-MM-DD`, only when the message names a date. */
  readonly due?: string;
}

export interface AnalysisAnswer {
  readonly state: ThreadState;
  readonly headline: string;
  readonly facts: readonly AnalysisAnswerFact[];
  readonly stakes: Stakes;
  readonly confidence: number;
  /** What ignoring it costs (ADR 0058). `real` must be backed by `consequenceQuote`. */
  readonly consequence?: Consequence;
  readonly consequenceQuote?: string;
  /** A short name for the matter this thread is about, the same for any thread about it. */
  readonly case?: string;
  /** What identifies the matter, word for word: numbers, names of projects, files. */
  readonly anchors?: readonly string[];
  /** What the thread asks of the person (ADR 0066). `intentQuote` may be empty only for `none`. */
  readonly intent: AnalysisIntent;
  readonly intentQuote: string;
  /** The main amount and what it means; `quote` is the passage it was read from. */
  readonly amount?: AnalysisAnswerAmount;
  /** `YYYY-MM-DD`: when an offer or chance ends. */
  readonly windowEnd?: string;
  /** Whether this is about the person's own matter, or would go to anyone on a list. */
  readonly forYou: "specific" | "generic";
  readonly forYouQuote?: string;
  /** Whether the thread itself shows the matter finished. */
  readonly status: CaseStatus;
  /** What kind of mail it is; a value outside the list has been read as `other`. */
  readonly category: ThreadCategory;
}

export interface AnalysisAnswerAmount {
  readonly value: number;
  readonly currency: string;
  readonly role: AmountRole;
  readonly quote: string;
}

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
/** Only a state the readings can answer for; the other two are never a question about waiting. */
export type TalkSearchState = "onYou" | "waiting";
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
  readonly state?: TalkSearchState;
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

export const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "state",
    "headline",
    "facts",
    "stakes",
    "confidence",
    "consequence",
    "case",
    "anchors",
    "intent",
    "intentQuote",
    "forYou",
    "status",
    "category",
  ],
  properties: {
    state: { type: "string", enum: ["onYou", "waiting", "fyi", "none"] },
    headline: { type: "string", minLength: 1, maxLength: MAX_HEADLINE_CHARS },
    facts: {
      type: "array",
      maxItems: MAX_FACTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "who", "message", "quote"],
        properties: {
          kind: { type: "string", enum: ["promise", "ask"] },
          who: { type: "string", enum: ["you", "them"] },
          message: { type: "integer", minimum: 1 },
          quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
          due: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        },
      },
    },
    stakes: { type: "string", enum: ["none", "money", "contract"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    consequence: { type: "string", enum: ["none", "minor", "real"] },
    consequenceQuote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
    case: { type: "string", maxLength: MAX_CASE_CHARS },
    anchors: {
      type: "array",
      maxItems: MAX_ANCHORS,
      items: { type: "string", minLength: 1, maxLength: MAX_ANCHOR_CHARS },
    },
    intent: { type: "string", enum: ["reply", "act", "decide", "wait", "know", "none"] },
    intentQuote: { type: "string", maxLength: MAX_QUOTE_CHARS },
    amount: {
      type: "object",
      additionalProperties: false,
      required: ["value", "currency", "role", "quote"],
      properties: {
        value: { type: "number", exclusiveMinimum: 0 },
        currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
        role: { type: "string", enum: ["debt", "price", "refund", "other"] },
        quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
      },
    },
    windowEnd: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    forYou: { type: "string", enum: ["specific", "generic"] },
    forYouQuote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
    status: { type: "string", enum: ["open", "done", "unknown"] },
    category: { type: "string", enum: [...THREAD_CATEGORIES] },
  },
} as const;

/**
 * One flat object rather than a union: runtimes differ in what they accept at the top level of a
 * schema. `kind` says which of the other keys must be present; `parsePreparedAnswer` insists on it.
 */
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
    state: { type: "string", enum: ["onYou", "waiting"] },
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

const CONSEQUENCES = ["none", "minor", "real"] as const;

function parseFact(raw: unknown): AnalysisAnswerFact | null {
  if (!isObject(raw) || !hasKeys(raw, ["kind", "who", "message", "quote"], ["due"])) return null;
  const kind = oneOf(raw.kind, ["promise", "ask"] as const);
  const who = oneOf(raw.who, ["you", "them"] as const);
  const quote = text(raw.quote, MAX_QUOTE_CHARS);
  const message = raw.message;
  if (kind === null || who === null || quote === null) return null;
  if (typeof message !== "number" || !Number.isInteger(message) || message < 1) return null;
  if ("due" in raw && text(raw.due, 10) === null) return null;
  const fact = { kind, who, message, quote };
  return "due" in raw ? { ...fact, due: raw.due as string } : fact;
}

function parseAmount(raw: unknown): AnalysisAnswerAmount | null {
  if (!isObject(raw) || !hasKeys(raw, ["value", "currency", "role", "quote"])) return null;
  const role = oneOf(raw.role, AMOUNT_ROLES);
  const quote = text(raw.quote, MAX_QUOTE_CHARS);
  const currency = typeof raw.currency === "string" ? raw.currency.trim() : "";
  // A number of any size is a number; whether it can be an amount is for `acceptAnalysis`.
  if (role === null || quote === null || typeof raw.value !== "number") return null;
  if (!/^[A-Za-z]{3}$/.test(currency)) return null;
  return { value: raw.value, currency: currency.toUpperCase(), role, quote };
}

/** The analysis answer as it is, or `null` for anything that does not match the schema. */
export function parseAnalysisAnswer(value: unknown): AnalysisAnswer | null {
  const optional = [
    "consequence",
    "consequenceQuote",
    "case",
    "anchors",
    "amount",
    "windowEnd",
    "forYouQuote",
  ];
  const required = [
    "state",
    "headline",
    "facts",
    "stakes",
    "confidence",
    "intent",
    "intentQuote",
    "forYou",
    "status",
    "category",
  ];
  if (!isObject(value) || !hasKeys(value, required, optional)) {
    return null;
  }
  const intent = oneOf(value.intent, ANALYSIS_INTENTS);
  const forYou = oneOf(value.forYou, ["specific", "generic"] as const);
  const status = oneOf(value.status, CASE_STATUSES);
  if (intent === null || forYou === null || status === null) return null;
  // A kind this build does not know is `other`, not a reason to lose the reading (ADR 0068).
  if (typeof value.category !== "string") return null;
  const category: ThreadCategory = (THREAD_CATEGORIES as readonly string[]).includes(value.category)
    ? (value.category as ThreadCategory)
    : "other";
  // Empty is a valid string here; `acceptAnalysis` turns a missing passage into `none`.
  if (typeof value.intentQuote !== "string" || value.intentQuote.length > MAX_QUOTE_CHARS) {
    return null;
  }
  const amount = "amount" in value ? parseAmount(value.amount) : undefined;
  if (amount === null) return null;
  const windowEnd = "windowEnd" in value ? text(value.windowEnd, 10) : undefined;
  if (windowEnd === null) return null;
  const forYouQuote = "forYouQuote" in value ? text(value.forYouQuote, MAX_QUOTE_CHARS) : undefined;
  if (forYouQuote === null) return null;
  const state = oneOf(value.state, ["onYou", "waiting", "fyi", "none"] as const);
  const stakes = oneOf(value.stakes, ["none", "money", "contract"] as const);
  const headline = text(value.headline, MAX_HEADLINE_CHARS);
  const confidence = value.confidence;
  if (state === null || stakes === null || headline === null) return null;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return null;
  if (!Array.isArray(value.facts) || value.facts.length > MAX_FACTS) return null;
  const facts: AnalysisAnswerFact[] = [];
  for (const raw of value.facts) {
    const fact = parseFact(raw);
    if (fact === null) return null;
    facts.push(fact);
  }
  const consequence = "consequence" in value ? oneOf(value.consequence, CONSEQUENCES) : undefined;
  if (consequence === null) return null;
  const said = "consequenceQuote" in value ? text(value.consequenceQuote, MAX_QUOTE_CHARS) : "";
  if (said === null) return null;
  const named = value.case;
  if (named !== undefined && (typeof named !== "string" || named.length > MAX_CASE_CHARS)) {
    return null;
  }
  const anchors: string[] = [];
  if (value.anchors !== undefined) {
    if (!Array.isArray(value.anchors) || value.anchors.length > MAX_ANCHORS) return null;
    for (const raw of value.anchors) {
      const anchor = text(raw, MAX_ANCHOR_CHARS);
      if (anchor === null) return null;
      anchors.push(anchor);
    }
  }
  return {
    state,
    headline,
    facts,
    stakes,
    confidence,
    ...(consequence === undefined ? {} : { consequence }),
    ...(said === "" ? {} : { consequenceQuote: said }),
    ...(typeof named === "string" && named.trim() !== "" ? { case: named.trim() } : {}),
    ...(value.anchors === undefined ? {} : { anchors }),
    intent,
    intentQuote: value.intentQuote.trim(),
    ...(amount === undefined ? {} : { amount }),
    ...(windowEnd === undefined ? {} : { windowEnd }),
    forYou,
    ...(forYouQuote === undefined ? {} : { forYouQuote }),
    status,
    category,
  };
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
 * The plan turn's answer as it is, or `null`. No trail is a valid plan: the state may carry the
 * question. Limits (ADR 0080): at most 5 trails, 3 queries each, 300 characters each. Past 8 queries
 * in all, the likeliest trails keep theirs and the rest are dropped, rather than the whole plan.
 */
export function parseTalkPlan(value: unknown): TalkPlanAnswer | null {
  if (
    !isObject(value) ||
    !hasKeys(
      value,
      ["goal", "assumptions", "trails", "traps"],
      // `vocabulary` is a key of plans cached by an earlier build; it is ignored.
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
  const state = "state" in value ? oneOf(value.state, ["onYou", "waiting"] as const) : undefined;
  if (state === null) return null;
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
    ...(state === undefined ? {} : { state }),
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
