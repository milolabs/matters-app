import type { NamedRole } from "../domain/mailbox.ts";
import { enumValues, isQueryField } from "../domain/queryFields.ts";
import { foldText, tokenize } from "../domain/text.ts";

/** ADR 0025. A total parser: a tree, token spans and diagnostics; it never throws. */
export type TextField = "any" | "from" | "to" | "cc" | "subject";
export type FlagName = "unread" | "read" | "starred" | "replied" | "draft";

export type QueryNode =
  | { kind: "and"; children: readonly QueryNode[] }
  | { kind: "or"; children: readonly QueryNode[] } // empty `or` matches nothing
  | { kind: "not"; child: QueryNode }
  /** Folded letters, digits and spaces only. `prefix` is one word, `phrase` consecutive words. */
  | { kind: "text"; field: TextField; match: "prefix" | "phrase"; value: string }
  | { kind: "label"; value: string } // folded
  | { kind: "flag"; flag: FlagName }
  /** Where the message is (ADR 0044): the only way, with `label:`, to reach Trash and Spam. */
  | { kind: "in"; role: NamedRole }
  | { kind: "attachment" }
  | { kind: "account"; ids: readonly string[] }
  /** Local-day start in ms: `after` is inclusive, `before` exclusive. Compared with the key's date. */
  | { kind: "after" | "before"; ms: number };

export interface QueryToken {
  readonly kind: "field" | "word" | "phrase" | "or" | "and" | "not" | "minus" | "open" | "close";
  /** Span in the (possibly truncated) input, `end` exclusive. Spans ascend and never overlap. */
  readonly start: number;
  readonly end: number;
  /** `incomplete`: still being typed, constrains nothing. `invalid`: will never match anything. */
  readonly state: "ok" | "incomplete" | "invalid";
  /** Lowercased field name of a field token, or the field a bare word got from `field:(`. */
  readonly field?: string;
  /** Start of the value of a field token. */
  readonly valueStart?: number;
}

export interface QueryDiagnostic {
  readonly code:
    | "unknown-value"
    | "invalid-date"
    | "stray-close"
    | "too-deep"
    | "too-many-terms"
    /** ADR 0116, rule 1: a prompt that is dropped, and why. */
    | "prompt-twice"
    | "prompt-negated"
    | "prompt-or"
    | "prompt-group"
    /** ADR 0116, rule 11: AI is off, so the prompt constrains nothing. */
    | "prompt-off"
    /** ADR 0116, rule 4a: a `limit:` that is dropped, and why. */
    | "invalid-limit"
    | "limit-twice"
    | "limit-negated"
    | "limit-or"
    | "limit-group"
    /** ADR 0116, rule 4b: a `sort:` that is dropped, and why; the list stays by date. */
    | "sort-twice"
    | "sort-negated"
    | "sort-or"
    | "sort-group"
    /** `sort:fit` without a prompt: there is no fit to sort by. */
    | "sort-fit"
    /** `sort:relevance` with no words to rank by. */
    | "sort-no-words";
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

/**
 * ADR 0116, rule 1: the person's question, taken out of the tree. The mail filters never see it;
 * it only narrows and orders what they found, and only when the person runs it.
 */
export interface QueryPrompt {
  /** The words as typed, without the quotes, trimmed. Never empty. */
  readonly text: string;
  /** Span of the whole `prompt:` term in the (possibly truncated) input, `end` exclusive. */
  readonly start: number;
  readonly end: number;
}

/**
 * ADR 0116, rule 4a: the person's own cap, taken out of the tree like a prompt. With a prompt it
 * is the most threads the prompt reads, best first; without one, the most messages the list
 * shows, newest first.
 */
export interface QueryLimit {
  /** A whole number from 1 to `MAX_QUERY_LIMIT`. */
  readonly n: number;
  /** Span of the whole `limit:` term in the (possibly truncated) input, `end` exclusive. */
  readonly start: number;
  readonly end: number;
}

/** ADR 0116, rule 4b: the orders `sort:` names. */
export type QuerySortValue = "newest" | "oldest" | "relevance" | "fit";

/** ADR 0116, rule 4b: the order of the results, taken out of the tree like a limit. */
export interface QuerySort {
  readonly value: QuerySortValue;
  /** Span of the whole `sort:` term in the (possibly truncated) input, `end` exclusive. */
  readonly start: number;
  readonly end: number;
}

/** The largest `limit:` taken; a larger value is taken as this. */
export const MAX_QUERY_LIMIT = 100_000;

export interface ParsedQuery {
  /** `null`: the mail filters constrain nothing; a prompt may still be there. */
  readonly root: QueryNode | null;
  readonly tokens: readonly QueryToken[];
  readonly diagnostics: readonly QueryDiagnostic[];
  /** At most one per query (ADR 0116, rule 1). Absent: no prompt, or one that is dropped. */
  readonly prompt?: QueryPrompt;
  /** At most one per query (ADR 0116, rule 4a). Absent: no limit, or one that is dropped. */
  readonly limit?: QueryLimit;
  /**
   * At most one per query (ADR 0116, rule 4b). Absent: the default, `newest` without a prompt and
   * `fit` with one, also when the one written is dropped.
   */
  readonly sort?: QuerySort;
}

/** The order a query's results are in (ADR 0116, rule 4b): the default when none is written. */
export function sortOf(parsed: Pick<ParsedQuery, "sort" | "prompt">): QuerySortValue {
  return parsed.sort?.value ?? (parsed.prompt === undefined ? "newest" : "fit");
}

export interface QueryContext {
  /** The "now" of relative dates; default `Date.now()`. */
  readonly nowMs?: number;
  /** For `account:` and `me`. */
  readonly accounts?: readonly { id: string; address: string; displayName: string }[];
  /**
   * AI is off or no account has consent (ADR 0116, rule 11): a prompt is reported and dropped.
   * Absent: the parser does not know, and keeps it.
   */
  readonly promptOff?: boolean;
}

const MAX_INPUT = 1024;
const MAX_TERMS = 32;
const MAX_DEPTH = 8;
const MAX_LABEL = 256;

type Field = TextField | "label" | "has" | "is" | "in" | "account" | "after" | "before";
const FLAGS = enumValues("is") as readonly FlagName[];
const PLACES = enumValues("in") as readonly NamedRole[];
const HAS = enumValues("has");
const SORTS = enumValues("sort") as readonly QuerySortValue[];
const PEOPLE = new Set(["from", "to", "cc"]);

type MutToken = { -readonly [K in keyof QueryToken]: QueryToken[K] };
interface Tok {
  readonly t: MutToken;
  /** Word, phrase body or field value. */
  readonly text: string;
  readonly quoted: boolean;
  /** `field:` directly followed by `(`. */
  readonly group: boolean;
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/** `start` is the index after the opening quote; an unbalanced quote runs to the end. */
function readQuoted(input: string, start: number): { value: string; end: number } {
  const close = input.indexOf('"', start);
  return close === -1
    ? { value: input.slice(start), end: input.length }
    : { value: input.slice(start, close), end: close + 1 };
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const push = (
    kind: QueryToken["kind"],
    start: number,
    end: number,
    text = "",
    quoted = false,
    group = false,
  ): Tok => {
    const tok: Tok = { t: { kind, start, end, state: "ok" }, text, quoted, group };
    toks.push(tok);
    return tok;
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src.charAt(i);
    if (isSpace(ch)) {
      i++;
    } else if (ch === "(" || ch === ")") {
      push(ch === "(" ? "open" : "close", i, i + 1);
      i++;
    } else if (ch === '"') {
      const q = readQuoted(src, i + 1);
      push("phrase", i, q.end, q.value, true);
      i = q.end;
    } else if (ch === "-" && i + 1 < n && !isSpace(src.charAt(i + 1))) {
      push("minus", i, i + 1);
      i++;
    } else {
      let j = i;
      while (j < n) {
        const c = src.charAt(j);
        if (isSpace(c) || c === "(" || c === ")" || c === '"') break;
        j++;
      }
      const word = src.slice(i, j);
      const colon = word.indexOf(":");
      const field = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
      if (isQueryField(field)) {
        let end = j;
        let text = word.slice(colon + 1);
        let quoted = false;
        let group = false;
        if (text === "") {
          if (src.charAt(j) === '"') {
            const q = readQuoted(src, j + 1);
            text = q.value;
            end = q.end;
            quoted = true;
          } else if (src.charAt(j) === "(") {
            group = true;
          }
        }
        const tok = push("field", i, end, text, quoted, group);
        tok.t.field = field;
        tok.t.valueStart = i + colon + 1;
        i = end;
        continue;
      }
      const kind = word === "OR" ? "or" : word === "AND" ? "and" : word === "NOT" ? "not" : "word";
      push(kind, i, j, word);
      i = j;
    }
  }
  return toks;
}

const PARTIAL_DATE = /^(\d{0,4}(-\d{0,2}(-\d{0,2})?)?|-\d*[dwmy]?)$/;
const RELATIVE = /^-(\d+)([dwmy])$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

type DateResult = { ms: number } | "incomplete" | "invalid";

/** Date arithmetic on the local calendar day; months and years clamp to the month's last day. */
function shiftMonths(y: number, m: number, d: number, months: number): Date {
  const total = y * 12 + m - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(ny, nm + 1, 0).getDate();
  return new Date(ny, nm, Math.min(d, last));
}

function parseDate(raw: string, nowMs: number): DateResult {
  const v = raw.trim().toLowerCase();
  const now = new Date(nowMs);
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  let date: Date | undefined;
  const iso = ISO.exec(v);
  const rel = RELATIVE.exec(v);
  if (iso) {
    const [iy, im, id] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const dt = new Date(iy, im - 1, id);
    if (dt.getFullYear() === iy && dt.getMonth() === im - 1 && dt.getDate() === id) date = dt;
  } else if (v === "today") {
    date = new Date(y, m, d);
  } else if (v === "yesterday") {
    date = new Date(y, m, d - 1);
  } else if (rel) {
    const count = Number(rel[1]);
    const unit = rel[2];
    date =
      unit === "d"
        ? new Date(y, m, d - count)
        : unit === "w"
          ? new Date(y, m, d - 7 * count)
          : unit === "m"
            ? shiftMonths(y, m, d, count)
            : shiftMonths(y, m, d, 12 * count);
  } else if (
    v.length < 10 &&
    (PARTIAL_DATE.test(v) || "today".startsWith(v) || "yesterday".startsWith(v))
  ) {
    return "incomplete";
  }
  const ms = date?.getTime();
  // Keys are ms * 1024: stay in the range where that is a safe integer.
  return ms !== undefined && Number.isSafeInteger(ms * 1024) ? { ms } : "invalid";
}

function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

export function parseQuery(input: string, context: QueryContext = {}): ParsedQuery {
  const src = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const toks = lex(src);
  const diagnostics: QueryDiagnostic[] = [];
  const nowMs = context.nowMs ?? Date.now();
  let pos = 0;
  let depth = 0;
  let budget = MAX_TERMS;
  let overflowed = false;
  // ADR 0116, rule 1: every `prompt:` met, with where it stood; one is kept after the parse.
  const prompts: { tk: Tok; text: string; negated: boolean; underOr: boolean }[] = [];
  // ADR 0116, rule 4a: every valid `limit:` met, the same way.
  const limits: { tk: Tok; n: number; negated: boolean; underOr: boolean }[] = [];
  // ADR 0116, rule 4b: every known `sort:` met, the same way.
  const sorts: { tk: Tok; value: QuerySortValue; negated: boolean; underOr: boolean }[] = [];
  let negated = false;

  const diag = (code: QueryDiagnostic["code"], start: number, end: number, message: string) => {
    diagnostics.push({ code, start, end, message });
  };

  const spend = (tk: Tok): boolean => {
    if (budget > 0) {
      budget--;
      return true;
    }
    tk.t.state = "invalid";
    if (!overflowed) {
      overflowed = true;
      diag("too-many-terms", tk.t.start, src.length, `More than ${MAX_TERMS} terms`);
    }
    return false;
  };

  /** Where a value starts: after `field:` for field tokens, else the whole token. */
  const valueSpan = (tk: Tok): [number, number] => [tk.t.valueStart ?? tk.t.start, tk.t.end];

  const combine = (kind: "and" | "or", nodes: QueryNode[]): QueryNode | null => {
    const first = nodes[0];
    if (first === undefined) return null;
    if (nodes.length === 1) return first;
    const flat: QueryNode[] = [];
    for (const node of nodes) {
      if (node.kind === kind) flat.push(...node.children);
      else flat.push(node);
    }
    return flat.length === 1 ? (flat[0] ?? null) : { kind, children: flat };
  };

  const textTerm = (
    field: TextField,
    value: string,
    quoted: boolean,
    tk: Tok,
  ): QueryNode | null => {
    const typing = tk.t.kind === "field" || tk.t.field !== undefined;
    if (PEOPLE.has(field) && !quoted && foldText(value).trim() === "me") {
      if (!spend(tk)) return null;
      const children: QueryNode[] = [];
      for (const account of context.accounts ?? []) {
        const words = tokenize(account.address);
        if (words.length > 0) {
          children.push({ kind: "text", field, match: "phrase", value: words.join(" ") });
        }
      }
      return { kind: "or", children };
    }
    const words = tokenize(value);
    if (words.length === 0) {
      tk.t.state = typing ? "incomplete" : "ok";
      return null;
    }
    if (quoted || (PEOPLE.has(field) && value.includes("@"))) {
      return spend(tk) ? { kind: "text", field, match: "phrase", value: words.join(" ") } : null;
    }
    const nodes: QueryNode[] = [];
    for (const word of words) {
      if (!spend(tk)) break;
      nodes.push({ kind: "text", field, match: "prefix", value: word });
    }
    return combine("and", nodes);
  };

  const enumTerm = (value: string, known: readonly string[], tk: Tok): string | null => {
    const v = foldText(value).trim();
    if (known.includes(v)) return spend(tk) ? v : null;
    if (v === "" || known.some((k) => k.startsWith(v))) {
      tk.t.state = "incomplete";
    } else {
      tk.t.state = "invalid";
      const [s, e] = valueSpan(tk);
      diag("unknown-value", s, e, `Unknown value "${clip(v)}"`);
    }
    return null;
  };

  const term = (field: Field, value: string, quoted: boolean, tk: Tok): QueryNode | null => {
    switch (field) {
      case "label": {
        const v = foldText(value).trim().slice(0, MAX_LABEL);
        if (v === "") {
          tk.t.state = "incomplete";
          return null;
        }
        return spend(tk) ? { kind: "label", value: v } : null;
      }
      case "is": {
        const v = enumTerm(value, FLAGS, tk);
        return v === null ? null : { kind: "flag", flag: v as FlagName };
      }
      case "in": {
        const v = enumTerm(value, PLACES, tk);
        return v === null ? null : { kind: "in", role: v as NamedRole };
      }
      case "has":
        return enumTerm(value, HAS, tk) === null ? null : { kind: "attachment" };
      case "account": {
        const words = tokenize(value);
        if (words.length === 0) {
          tk.t.state = "incomplete";
          return null;
        }
        if (!spend(tk)) return null;
        const accounts = context.accounts;
        if (accounts === undefined) return { kind: "or", children: [] };
        const ids = accounts
          .filter((a) => {
            const theirs = tokenize(`${a.displayName} ${a.address}`);
            return words.every((w) => theirs.some((t) => t.startsWith(w)));
          })
          .map((a) => a.id);
        if (ids.length > 0) return { kind: "account", ids };
        tk.t.state = "invalid";
        const [s, e] = valueSpan(tk);
        diag("unknown-value", s, e, `No account matches "${clip(value)}"`);
        return { kind: "or", children: [] };
      }
      case "after":
      case "before": {
        const r = parseDate(value, nowMs);
        if (r === "incomplete") {
          tk.t.state = "incomplete";
          return null;
        }
        if (r === "invalid") {
          tk.t.state = "invalid";
          const [s, e] = valueSpan(tk);
          diag("invalid-date", s, e, `Not a date: "${clip(value.trim())}"`);
          return null;
        }
        return spend(tk) ? { kind: field, ms: r.ms } : null;
      }
      default:
        return textTerm(field, value, quoted, tk);
    }
  };

  /** The tokens of a group nested too deeply are dropped up to its closing bracket. */
  const skipGroup = (open: Tok): void => {
    let level = 1;
    let end = open.t.end;
    open.t.state = "invalid";
    while (pos < toks.length && level > 0) {
      const tk = toks[pos++];
      if (!tk) break;
      tk.t.state = "invalid";
      end = tk.t.end;
      if (tk.t.kind === "open") level++;
      else if (tk.t.kind === "close") level--;
    }
    diag("too-deep", open.t.start, end, `Brackets nested more than ${MAX_DEPTH} deep`);
  };

  const parseGroup = (open: Tok, dflt: Field | undefined): QueryNode | null => {
    if (depth >= MAX_DEPTH) {
      skipGroup(open);
      return null;
    }
    depth++;
    const node = parseOr(dflt);
    depth--;
    if (toks[pos]?.t.kind === "close") pos++;
    return node;
  };

  /** `prompt:( … )`, `limit:( … )` and `sort:( … )` are dropped up to their closing bracket. */
  const skipAsideGroup = (
    field: Tok,
    code: "prompt-group" | "limit-group" | "sort-group",
    message: string,
  ) => {
    let level = 0;
    let end = field.t.end;
    field.t.state = "invalid";
    while (pos < toks.length) {
      const tk = toks[pos++];
      if (!tk) break;
      tk.t.state = "invalid";
      end = tk.t.end;
      if (tk.t.kind === "open") level++;
      else if (tk.t.kind === "close" && --level <= 0) break;
    }
    diag(code, field.t.start, end, message);
  };

  /** ADR 0116, rule 4a: a whole number above 0, noted beside the tree. */
  const limitTerm = (tk: Tok): null => {
    if (tk.group) {
      skipAsideGroup(tk, "limit-group", "A limit is a number, not a group");
      return null;
    }
    const v = tk.text.trim();
    if (v === "") {
      tk.t.state = "incomplete";
      return null;
    }
    const n = /^\d+$/.test(v) ? Number(v) : 0;
    if (!(n >= 1)) {
      tk.t.state = "invalid";
      const [s, e] = valueSpan(tk);
      diag("invalid-limit", s, e, `Not a whole number above 0: "${clip(v)}"`);
      return null;
    }
    limits.push({ tk, n: Math.min(n, MAX_QUERY_LIMIT), negated, underOr: false });
    return null;
  };

  /** ADR 0116, rule 4b: one of the known orders, noted beside the tree. */
  const sortTerm = (tk: Tok): null => {
    if (tk.group) {
      skipAsideGroup(tk, "sort-group", "An order is one word, not a group");
      return null;
    }
    const v = foldText(tk.text).trim();
    if ((SORTS as readonly string[]).includes(v)) {
      sorts.push({ tk, value: v as QuerySortValue, negated, underOr: false });
    } else if (v === "" || SORTS.some((k) => k.startsWith(v))) {
      tk.t.state = "incomplete";
    } else {
      tk.t.state = "invalid";
      const [s, e] = valueSpan(tk);
      diag("unknown-value", s, e, `Unknown value "${clip(v)}"`);
    }
    return null;
  };

  /** ADR 0116, rule 1: a prompt is noted beside the tree and never becomes a node. */
  const promptTerm = (tk: Tok): null => {
    if (tk.group) {
      skipAsideGroup(tk, "prompt-group", "A prompt is a word or a quoted phrase, not a group");
      return null;
    }
    const text = tk.text.trim();
    if (text === "") {
      tk.t.state = "incomplete";
      return null;
    }
    prompts.push({ tk, text, negated, underOr: false });
    return null;
  };

  const parseAtom = (dflt: Field | undefined): QueryNode | null => {
    const tk = toks[pos];
    if (!tk) return null;
    switch (tk.t.kind) {
      case "open":
        pos++;
        return parseGroup(tk, dflt);
      case "field": {
        pos++;
        if (tk.t.field === "prompt") return promptTerm(tk);
        if (tk.t.field === "limit") return limitTerm(tk);
        if (tk.t.field === "sort") return sortTerm(tk);
        const field = tk.t.field as Field;
        if (tk.group) {
          const open = toks[pos++];
          const node = open ? parseGroup(open, field) : null;
          if (tk.t.state === "ok" && node === null) tk.t.state = "incomplete";
          return node;
        }
        return term(field, tk.text, tk.quoted, tk);
      }
      case "word":
      case "phrase": {
        pos++;
        if (dflt === undefined) return textTerm("any", tk.text, tk.quoted, tk);
        tk.t.field = dflt;
        return term(dflt, tk.text, tk.quoted, tk);
      }
      default:
        return null;
    }
  };

  const parseUnary = (dflt: Field | undefined): QueryNode | null => {
    const negs: Tok[] = [];
    let kind = toks[pos]?.t.kind;
    while (kind === "minus" || kind === "not") {
      const tk = toks[pos++];
      if (tk) negs.push(tk);
      kind = toks[pos]?.t.kind;
    }
    const flips = negs.length % 2 === 1;
    if (flips) negated = !negated;
    const node = parseAtom(dflt);
    if (flips) negated = !negated;
    for (const tk of negs) tk.t.state = node === null ? "incomplete" : "ok";
    if (node === null || negs.length % 2 === 0) return node;
    return node.kind === "not" ? node.child : { kind: "not", child: node };
  };

  const parseAnd = (dflt: Field | undefined): QueryNode | null => {
    const nodes: QueryNode[] = [];
    for (;;) {
      const tk = toks[pos];
      if (!tk || tk.t.kind === "or") break;
      if (tk.t.kind === "close") {
        if (depth > 0) break;
        pos++;
        tk.t.state = "invalid";
        diag("stray-close", tk.t.start, tk.t.end, "Unmatched )");
      } else if (tk.t.kind === "and") {
        pos++;
      } else {
        const node = parseUnary(dflt);
        if (node !== null) nodes.push(node);
      }
    }
    return combine("and", nodes);
  };

  const parseOr = (dflt: Field | undefined): QueryNode | null => {
    const nodes: QueryNode[] = [];
    const firstPrompt = prompts.length;
    const firstLimit = limits.length;
    const firstSort = sorts.length;
    let left = parseAnd(dflt);
    if (left !== null) nodes.push(left);
    let ors = 0;
    while (toks[pos]?.t.kind === "or") {
      const op = toks[pos++];
      ors++;
      const right = parseAnd(dflt);
      if (op) op.t.state = left === null || right === null ? "incomplete" : "ok";
      if (right !== null) nodes.push(right);
      left = right;
    }
    if (ors > 0) {
      for (let i = firstPrompt; i < prompts.length; i++) {
        const p = prompts[i];
        if (p) prompts[i] = { ...p, underOr: true };
      }
      for (let i = firstLimit; i < limits.length; i++) {
        const l = limits[i];
        if (l) limits[i] = { ...l, underOr: true };
      }
      for (let i = firstSort; i < sorts.length; i++) {
        const o = sorts[i];
        if (o) sorts[i] = { ...o, underOr: true };
      }
    }
    return combine("or", nodes);
  };

  const root = parseOr(undefined);
  let prompt: QueryPrompt | undefined;
  for (const p of prompts) {
    const { start, end } = p.tk.t;
    const drop = (code: QueryDiagnostic["code"], message: string) => {
      p.tk.t.state = "invalid";
      diag(code, start, end, message);
    };
    if (p.negated) drop("prompt-negated", "A prompt cannot be excluded");
    else if (p.underOr) drop("prompt-or", "A prompt cannot be one side of OR");
    else if (prompt !== undefined) drop("prompt-twice", "Only one prompt per query");
    else prompt = { text: p.text, start, end };
  }
  let limit: QueryLimit | undefined;
  for (const l of limits) {
    const { start, end } = l.tk.t;
    const drop = (code: QueryDiagnostic["code"], message: string) => {
      l.tk.t.state = "invalid";
      diag(code, start, end, message);
    };
    if (l.negated) drop("limit-negated", "A limit cannot be excluded");
    else if (l.underOr) drop("limit-or", "A limit cannot be one side of OR");
    else if (limit !== undefined) drop("limit-twice", "Only one limit per query");
    else limit = { n: l.n, start, end };
  }
  let promptDropped = false;
  if (prompt !== undefined && context.promptOff === true) {
    diag("prompt-off", prompt.start, prompt.end, "AI is off, so the prompt does nothing");
    prompt = undefined;
    promptDropped = true;
  }
  let sort: QuerySort | undefined;
  for (const o of sorts) {
    const { start, end } = o.tk.t;
    const drop = (code: QueryDiagnostic["code"], message: string) => {
      o.tk.t.state = "invalid";
      diag(code, start, end, message);
    };
    if (o.negated) drop("sort-negated", "An order cannot be excluded");
    else if (o.underOr) drop("sort-or", "An order cannot be one side of OR");
    else if (sort !== undefined) drop("sort-twice", "Only one order per query");
    else sort = { value: o.value, start, end };
  }
  // What the order needs and does not have: the list stays by date, and says why (rule 4b).
  if (sort?.value === "fit" && prompt === undefined) {
    const at = sort;
    const tk = sorts.find((o) => o.tk.t.start === at.start)?.tk;
    if (tk) tk.t.state = "invalid";
    // A prompt dropped because AI is off says so itself.
    if (!promptDropped) diag("sort-fit", at.start, at.end, "Sorting by fit needs a prompt");
    sort = undefined;
  } else if (sort?.value === "relevance" && prompt === undefined && !hasWords(root)) {
    diag("sort-no-words", sort.start, sort.end, "No words to rank by, so the list stays by date");
    sort = undefined;
  }
  return {
    root,
    tokens: toks.map((x) => x.t),
    diagnostics,
    ...(prompt === undefined ? {} : { prompt }),
    ...(limit === undefined ? {} : { limit }),
    ...(sort === undefined ? {} : { sort }),
  };
}

/** Words a rank can go by (ADR 0116, rule 4b): a text term that is not excluded. */
function hasWords(root: QueryNode | null): boolean {
  if (root === null) return false;
  switch (root.kind) {
    case "text":
      return true;
    case "and":
    case "or":
      return root.children.some(hasWords);
    default:
      return false;
  }
}

/**
 * A query whose mail filters constrain nothing behaves like no query at all. A prompt alone does
 * not change that: it narrows only when it is run (ADR 0116, rule 2).
 */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.root === null;
}
