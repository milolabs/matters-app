import type { FlagName, LabelRoleOf, QueryNode, TextField } from "@matters/core";
import {
  asksForHidden,
  HIDDEN_MAILBOXES,
  MAILBOX_BIT,
  MESSAGE_KEY_SEQ_LIMIT,
  tokenize,
} from "@matters/core";

/**
 * Compiles a query tree to SQL (ADR 0025). FTS-only subtrees become one `MATCH`; date
 * bounds become key ranges; the rest are conditions over `messages m`. User text only ever
 * reaches `MATCH` quoted: the `AND`, `OR` and `NOT` in a `MATCH` string are written here.
 */
export type Param = string | number;
export interface Frag {
  readonly sql: string;
  readonly params: readonly Param[];
}

/** A top-level conjunct that is not part of the `MATCH`. */
export interface Conj {
  /** Over alias `m`. */
  readonly cond: Frag;
  /** Keys that satisfy the condition, from an index; countable and usable as a driver. */
  readonly keys?: Frag;
}

export interface SearchPlan {
  /** Nothing can match. */
  readonly empty: boolean;
  readonly match: Frag | null;
  /** Cost per row of evaluating the MATCH; infinite when it holds a prefix FTS has no index for. */
  readonly matchWeight: number;
  /** Inclusive and exclusive bounds on the key, from top-level `after:` / `before:`. */
  readonly lowKey: number;
  readonly highKey: number;
  readonly conjs: readonly Conj[];
  /** The conditions hold an FTS subquery, which cannot be bounded cheaply. */
  readonly nestedFts: boolean;
  /**
   * Leave out messages in Trash and Spam: the query does not ask for them (ADR 0044, rule 3). Not
   * a conjunct: it is true of nearly every row, so it neither drives a query nor makes it heavy.
   */
  readonly visibleOnly: boolean;
}

/**
 * What `visibleOnly` is, over alias `m`. The partial index `messages_visible` has this very text,
 * which All mail relies on (`NEWEST_VISIBLE_SQL`).
 */
export const VISIBLE_SQL = `m.mailboxes & ${HIDDEN_MAILBOXES} = 0`;

/**
 * The same test for a search. Its unary plus keeps the planner from choosing `messages_visible` to
 * answer it: nearly every message is in that index, so it would take the place of a rarer index
 * (`messages_unread`) that the rest of the query could use. It is a filter here and nothing more.
 * A second copy of a message shown already is left out too (ADR 0092, rule 4).
 */
const VISIBLE_FILTER_SQL = `+m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.copy_of IS NULL`;

/** Without FTS, `m.key IN` up to this many rows; beyond it the table walk ends sooner. */
export const KEY_DRIVER_MAX = 10_000;
/**
 * With a MATCH, `rowid IN` re-runs the FTS filter per rowid. That costs about 0.025 ms per row
 * per exact term and 0.25 ms per row per prefix-indexed prefix, but seconds for a prefix with
 * no index, which FTS5 rebuilds as a merged doclist each time. A driver is used while
 * `rows * weight` stays within this budget (about 12 ms, measured); see `matchWeight`.
 */
export const MATCH_DRIVER_BUDGET = 500;
/** Prefixes of 2-3 characters are covered by the FTS prefix index (`prefix = '2 3'`). */
const INDEXED_PREFIX_WEIGHT = 12;
/** Prefixes of this many characters are expanded into the indexed terms they start with. */
export const EXPAND_MIN = 4;
export const EXPAND_MAX = 32;
/** An expansion wider than this falls back to the native prefix. */
export const MAX_EXPANSION = 64;

/**
 * A token longer than EXPAND_MAX is not stored: its first EXPAND_MAX characters plus this mark
 * are, which says "longer words start here". An expansion that meets the mark cannot be
 * exact, so it falls back to the native prefix (the mark is not a clean term).
 */
export const LONG_TERM_MARK = "\u{10FFFE}";

/** What `message_terms` holds for a token, or null when it needs no entry (under 4 characters). */
export function termEntry(token: string): string | null {
  if (token.length < EXPAND_MIN) return null;
  if (token.length <= EXPAND_MAX) return token;
  const cut = /[\uD800-\uDBFF]/.test(token.charAt(EXPAND_MAX - 1)) ? EXPAND_MAX - 1 : EXPAND_MAX;
  return token.slice(0, cut) + LONG_TERM_MARK;
}

/** The terms an indexed word of 4..32 characters can start with, or null when not known. */
export type Expand = (prefix: string) => readonly string[] | null;

export const KEY_MIN = Number.MIN_SAFE_INTEGER;
export const KEY_MAX = Number.MAX_SAFE_INTEGER;

const COLUMN: Record<TextField, string | undefined> = {
  any: undefined,
  from: "sender",
  to: "recipients",
  cc: "cc",
  subject: "subject",
};

const FLAG_SQL: Record<FlagName, string> = {
  unread: "m.flags & 1 = 0",
  read: "m.flags & 1 = 1",
  starred: "m.flags & 2 = 2",
  replied: "m.flags & 4 = 4",
  draft: "m.flags & 8 = 8",
};

/** Flags with a partial index; `keys` selects exactly what the index covers. */
const FLAG_KEYS: Partial<Record<FlagName, string>> = {
  unread: "SELECT d.key FROM messages d WHERE d.flags & 1 = 0",
  starred: "SELECT d.key FROM messages d WHERE d.flags & 2 = 2",
  draft: "SELECT d.key FROM messages d WHERE d.flags & 8 = 8",
};

// The subquery is cut to the window (`:lo`, `:hi`) the outer query is limited to, so it
// materialises the hits of one window instead of all of them. Same answer for keys inside it.
const FTS_HITS =
  "SELECT rowid FROM message_fts WHERE message_fts MATCH ? AND rowid >= :lo AND rowid < :hi";
const FTS_IN = `m.key IN (${FTS_HITS})`;
const FTS_NOT_IN = `m.key NOT IN (${FTS_HITS})`;

interface Fts {
  readonly sql: string;
  /** Cost of evaluating it once per row: 1 per exact term or phrase, 12 per indexed prefix. */
  readonly weight: number;
}

const CLEAN_TERM = /^[\p{L}\p{N}]+$/u;

function textFts(
  node: Extract<QueryNode, { kind: "text" }>,
  expand: Expand | undefined,
): Fts | null {
  const words = tokenize(node.value);
  if (words.length === 0) return null;
  let body: string;
  let weight: number;
  const word = words[0] as string;
  if (node.match === "phrase") {
    body = `"${words.join(" ")}"`;
    weight = 1;
  } else if (words.length > 1) {
    body = `"${words.join(" ")}"*`;
    weight = Number.POSITIVE_INFINITY;
  } else {
    const forms =
      expand !== undefined && word.length >= EXPAND_MIN && word.length <= EXPAND_MAX
        ? expand(word)
        : null;
    if (
      forms !== null &&
      forms.length > 0 &&
      forms.length <= MAX_EXPANSION &&
      forms.every((f) => CLEAN_TERM.test(f))
    ) {
      // An OR of exact terms stays lazy where an unindexed prefix builds a merged doclist.
      const quoted = forms.map((f) => `"${f}"`);
      body = quoted.length === 1 ? (quoted[0] as string) : `(${quoted.join(" OR ")})`;
      weight = forms.length;
    } else {
      body = `"${word}"*`;
      weight =
        word.length <= 3 && word.length >= 2 ? INDEXED_PREFIX_WEIGHT : Number.POSITIVE_INFINITY;
    }
  }
  const column = COLUMN[node.field];
  return { sql: column === undefined ? `(${body})` : `(${column} : ${body})`, weight };
}

/**
 * The `MATCH` expression of a subtree that FTS can answer alone, or null. Every operand is
 * parenthesised: FTS5 binds NOT tighter than AND, and AND tighter than OR.
 */
function ftsOf(node: QueryNode, expand: Expand | undefined): Fts | null {
  switch (node.kind) {
    case "text":
      return textFts(node, expand);
    case "and": {
      const positive: string[] = [];
      const negative: string[] = [];
      let weight = 0;
      for (const child of node.children) {
        const target = child.kind === "not" ? negative : positive;
        const f = ftsOf(child.kind === "not" ? child.child : child, expand);
        if (f === null) return null;
        target.push(f.sql);
        weight += f.weight;
      }
      if (positive.length === 0) return null;
      const all = `(${positive.join(" AND ")})`;
      return {
        sql: negative.length === 0 ? all : `(${all} NOT (${negative.join(" OR ")}))`,
        weight,
      };
    }
    case "or": {
      if (node.children.length === 0) return null;
      const parts: string[] = [];
      let weight = 0;
      for (const child of node.children) {
        const f = ftsOf(child, expand);
        if (f === null) return null;
        parts.push(f.sql);
        weight += f.weight;
      }
      return { sql: `(${parts.join(" OR ")})`, weight };
    }
    default:
      return null;
  }
}

export function toFts(node: QueryNode, expand?: Expand): string | null {
  return ftsOf(node, expand)?.sql ?? null;
}

type Cond = Frag | boolean;

interface CompileState {
  nestedFts: boolean;
  readonly expand: Expand | undefined;
}

function join(op: "AND" | "OR", parts: readonly Frag[]): Frag {
  return {
    sql: `(${parts.map((p) => p.sql).join(` ${op} `)})`,
    params: parts.flatMap((p) => p.params),
  };
}

/** Any subtree as a condition over alias `m`. */
function compile(node: QueryNode, state: CompileState): Cond {
  const fts = toFts(node, state.expand);
  if (fts !== null) {
    state.nestedFts = true;
    return { sql: FTS_IN, params: [fts] };
  }
  switch (node.kind) {
    case "text":
      return false;
    case "label":
      return {
        sql: "EXISTS (SELECT 1 FROM message_labels l WHERE l.label_fold = ? AND l.message_key = m.key)",
        params: [node.value],
      };
    case "flag":
      return { sql: FLAG_SQL[node.flag], params: [] };
    case "in":
      return { sql: `m.mailboxes & ${MAILBOX_BIT[node.role]} != 0`, params: [] };
    case "attachment":
      return { sql: "m.has_attachments = 1", params: [] };
    case "account":
      return node.ids.length === 0
        ? false
        : { sql: `m.account_id IN (${node.ids.map(() => "?").join(", ")})`, params: node.ids };
    case "after":
      return { sql: "m.key >= ?", params: [node.ms * MESSAGE_KEY_SEQ_LIMIT] };
    case "before":
      return { sql: "m.key < ?", params: [node.ms * MESSAGE_KEY_SEQ_LIMIT] };
    case "not": {
      const c = compile(node.child, state);
      return typeof c === "boolean" ? !c : { sql: `NOT (${c.sql})`, params: c.params };
    }
    case "and":
    case "or": {
      const and = node.kind === "and";
      const parts: Frag[] = [];
      for (const child of node.children) {
        const c = compile(child, state);
        if (typeof c === "boolean") {
          if (c !== and) return c; // false in an AND, true in an OR
        } else {
          parts.push(c);
        }
      }
      if (parts.length === 0) return and;
      return parts.length === 1 ? (parts[0] as Frag) : join(and ? "AND" : "OR", parts);
    }
  }
}

function keysOf(node: QueryNode): Frag | undefined {
  switch (node.kind) {
    case "label":
      return {
        sql: "SELECT l.message_key FROM message_labels l WHERE l.label_fold = ?",
        params: [node.value],
      };
    case "flag": {
      const sql = FLAG_KEYS[node.flag];
      return sql === undefined ? undefined : { sql, params: [] };
    }
    case "attachment":
      return { sql: "SELECT d.key FROM messages d WHERE d.has_attachments = 1", params: [] };
    case "account":
      return node.ids.length === 0
        ? undefined
        : {
            sql: `SELECT d.key FROM messages d WHERE d.account_id IN (${node.ids.map(() => "?").join(", ")})`,
            params: node.ids,
          };
    default:
      return undefined;
  }
}

export function planQuery(root: QueryNode, expand?: Expand, labelRole?: LabelRoleOf): SearchPlan {
  const state: CompileState = { nestedFts: false, expand };
  const positive: Fts[] = [];
  const negative: Fts[] = [];
  const conjs: Conj[] = [];
  let lowKey = KEY_MIN;
  let highKey = KEY_MAX;
  let empty = false;

  const visit = (node: QueryNode): void => {
    if (node.kind === "and") {
      for (const child of node.children) visit(child);
      return;
    }
    if (node.kind === "after") {
      lowKey = Math.max(lowKey, node.ms * MESSAGE_KEY_SEQ_LIMIT);
      return;
    }
    if (node.kind === "before") {
      highKey = Math.min(highKey, node.ms * MESSAGE_KEY_SEQ_LIMIT);
      return;
    }
    const fts = ftsOf(node, expand);
    if (fts !== null) {
      positive.push(fts);
      return;
    }
    if (node.kind === "not") {
      const inner = ftsOf(node.child, expand);
      if (inner !== null) {
        negative.push(inner);
        return;
      }
    }
    const cond = compile(node, state);
    if (cond === false) empty = true;
    else if (cond !== true) {
      const keys = keysOf(node);
      conjs.push(keys === undefined ? { cond } : { cond, keys });
    }
  };
  visit(root);

  let match: Frag | null = null;
  let matchWeight = 0;
  if (positive.length > 0) {
    const all = positive.map((f) => f.sql).join(" AND ");
    const not = negative.map((f) => f.sql).join(" OR ");
    match = {
      sql: "message_fts MATCH ?",
      params: [negative.length === 0 ? all : `((${all}) NOT (${not}))`],
    };
    matchWeight = [...positive, ...negative].reduce((sum, f) => sum + f.weight, 0);
  } else {
    // Only negations: every message except the FTS hits.
    for (const n of negative) {
      conjs.push({ cond: { sql: FTS_NOT_IN, params: [n.sql] } });
      state.nestedFts = true;
    }
  }
  return {
    empty: empty || lowKey >= highKey,
    match,
    matchWeight,
    lowKey,
    highKey,
    conjs,
    nestedFts: state.nestedFts,
    visibleOnly: !asksForHidden(root, labelRole),
  };
}

export interface Route {
  /** Index into `plan.conjs` of the conjunct that drives the query, if one is rare enough. */
  readonly driver: number | undefined;
  /** Worth running in time windows (ADR 0025). */
  readonly heavy: boolean;
}

export interface DriverLimits {
  /** Largest indexed filter that drives a query without a MATCH. */
  readonly keys: number;
  /** Budget for `rows * matchWeight` of a driver beside a MATCH. */
  readonly matchBudget: number;
  /** Expand prefixes of 4..32 characters into the terms they start with. */
  readonly expand: boolean;
}

export const DEFAULT_DRIVER_LIMITS: DriverLimits = {
  keys: KEY_DRIVER_MAX,
  matchBudget: MATCH_DRIVER_BUDGET,
  expand: true,
};

/** How many rows of a driver the plan can afford; 0 when even one is too many. */
export function driverRows(plan: SearchPlan, limits: DriverLimits): number {
  if (plan.match === null) return Math.max(0, limits.keys);
  if (limits.matchBudget === Number.POSITIVE_INFINITY) return 1e9;
  if (plan.matchWeight === Number.POSITIVE_INFINITY) return 0;
  return Math.max(0, Math.floor(limits.matchBudget / plan.matchWeight));
}

/** `counts[i]` is the capped size of the keys of `plan.conjs[i]`, absent for non-indexed ones. */
export function chooseRoute(
  plan: SearchPlan,
  counts: ReadonlyMap<number, number>,
  limits: DriverLimits = DEFAULT_DRIVER_LIMITS,
): Route {
  let driver: number | undefined;
  let rarest = Number.POSITIVE_INFINITY;
  for (const [i, n] of counts) {
    if (n < rarest) {
      rarest = n;
      driver = i;
    }
  }
  if (rarest > driverRows(plan, limits)) driver = undefined;
  // Without a driver a MATCH walks its hits and any other condition filters them, in windows;
  // without a MATCH only a condition with no index can be sparse enough to need windows.
  const walkHeavy =
    driver === undefined &&
    (plan.match !== null ? plan.conjs.length > 0 : plan.conjs.some((c) => c.keys === undefined));
  return { driver, heavy: plan.nestedFts || walkHeavy };
}

/** A capped count of what an indexed conjunct selects; `cap` is the last parameter. */
export function countSql(keys: Frag): string {
  return `SELECT COUNT(*) AS n FROM (${keys.sql} LIMIT ?)`;
}

export interface Window {
  /** Inclusive. */
  readonly lower: number;
  /** Exclusive. */
  readonly upper: number;
  readonly limit: number;
  /** Only these keys, as a JSON array. */
  readonly within?: string;
  /** Keys ascending (ADR 0116, rule 4b); default newest first. */
  readonly order?: "newest" | "oldest";
}

/** The one query a route runs over a window of keys, newest first unless `oldest` is asked. */
export function buildSql(
  plan: SearchPlan,
  route: Route,
  win: Window,
): { sql: string; params: Param[]; named: Record<string, number> } {
  const params: Param[] = [];
  const where: string[] = [];
  const add = (f: Frag): void => {
    where.push(f.sql);
    params.push(...f.params);
  };
  const driver = route.driver === undefined ? undefined : plan.conjs[route.driver];
  const rest = plan.conjs.filter((c) => c !== driver);

  const keyColumn = plan.match === null ? "m.key" : "message_fts.rowid";
  let from: string;
  if (plan.match === null) {
    from = "messages m";
  } else {
    // The hits are looked up in `messages` by key only when something besides the MATCH has to
    // read a row: a condition, or the check that the message is not in Trash or Spam.
    from =
      rest.length > 0 || plan.visibleOnly
        ? "message_fts JOIN messages m ON m.key = message_fts.rowid"
        : "message_fts";
    add(plan.match);
  }
  if (driver?.keys) {
    where.push(`${keyColumn} IN (${driver.keys.sql})`);
    params.push(...driver.keys.params);
  }
  where.push(`${keyColumn} >= ?`, `${keyColumn} < ?`);
  params.push(win.lower, win.upper);
  if (win.within !== undefined) {
    // Unary plus: beside a MATCH, an IN the index takes would run the MATCH again for every key.
    where.push(`${plan.match === null ? "" : "+"}${keyColumn} IN (SELECT value FROM json_each(?))`);
    params.push(win.within);
  }
  if (plan.visibleOnly) where.push(VISIBLE_FILTER_SQL);
  for (const c of rest) add(c.cond);

  params.push(win.limit);
  return {
    sql: `SELECT ${keyColumn} AS key FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${keyColumn} ${win.order === "oldest" ? "ASC" : "DESC"} LIMIT ?`,
    params,
    // Only a statement with a nested FTS subquery has these names.
    named: plan.nestedFts ? { lo: win.lower, hi: win.upper } : {},
  };
}

/**
 * Weights of the columns of `message_fts` in the agent's ranking (ADR 0080), in table order:
 * sender, recipients, cc, subject, body. A name in the subject or the sender says more than the
 * same word somewhere in a long body; a copy recipient says least.
 */
export const RANK_WEIGHTS = [3, 1, 0.5, 5, 1] as const;
const BM25 = `bm25(message_fts, ${RANK_WEIGHTS.join(", ")})`;

/** Points of bm25 added to the order of a ranked search before its cut (ADR 0081). */
export interface RankAdjust {
  /** Mail the headers call automated sorts this much lower. */
  readonly automatedPenalty?: number;
  /** The person's own Sent mail sorts this much higher. */
  readonly ownBoost?: number;
}

const finite = (n: number | undefined): number =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * The ranked search: the best `limit` matches by bm25 with the field weights, with what the plan
 * asks of the message (its conditions, the key range, Trash and Spam left out) and the thread
 * and account of each. Needs a MATCH; `relevance` is the negated bm25, higher for a better match.
 * The words are the plan's own: several plain words are ANDed prefixes, as in the person's search.
 */
export function buildRankedSql(
  plan: SearchPlan,
  limit: number,
  adjust: RankAdjust = {},
): { sql: string; params: Param[]; named: Record<string, number> } {
  const params: Param[] = [];
  const where: string[] = [];
  if (plan.match === null) throw new Error("A ranked search needs a MATCH");
  where.push(plan.match.sql, "message_fts.rowid >= ?", "message_fts.rowid < ?");
  params.push(...plan.match.params, plan.lowKey, plan.highKey);
  if (plan.visibleOnly) where.push(VISIBLE_FILTER_SQL);
  for (const c of plan.conjs) {
    where.push(c.cond.sql);
    params.push(...c.cond.params);
  }
  params.push(limit);
  // The best `limit` are chosen after the adjustment, so that a flood of programs does not fill
  // the window; `relevance` stays the plain bm25.
  const penalty = finite(adjust.automatedPenalty);
  const boost = finite(adjust.ownBoost);
  const order =
    penalty === 0 && boost === 0
      ? BM25
      : `${BM25}${penalty === 0 ? "" : ` + CASE WHEN m.automated = 1 THEN ${penalty} ELSE 0 END`}${boost === 0 ? "" : ` - CASE WHEN m.mailboxes & 2 != 0 THEN ${boost} ELSE 0 END`}`;
  return {
    sql: `SELECT message_fts.rowid AS key, m.thread_id AS thread_id, m.account_id AS account_id,
                 -${BM25} AS relevance
            FROM message_fts CROSS JOIN messages m ON m.key = message_fts.rowid
           WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`,
    params,
    named: plan.nestedFts ? { lo: plan.lowKey, hi: plan.highKey } : {},
  };
}
