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
  readonly code: "unknown-value" | "invalid-date" | "stray-close" | "too-deep" | "too-many-terms";
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

export interface ParsedQuery {
  /** `null`: the query constrains nothing and behaves like no query at all. */
  readonly root: QueryNode | null;
  readonly tokens: readonly QueryToken[];
  readonly diagnostics: readonly QueryDiagnostic[];
}

export interface QueryContext {
  /** The "now" of relative dates; default `Date.now()`. */
  readonly nowMs?: number;
  /** For `account:` and `me`. */
  readonly accounts?: readonly { id: string; address: string; displayName: string }[];
}

const MAX_INPUT = 1024;
const MAX_TERMS = 32;
const MAX_DEPTH = 8;
const MAX_LABEL = 256;

type Field = TextField | "label" | "has" | "is" | "in" | "account" | "after" | "before";
const FLAGS = enumValues("is") as readonly FlagName[];
const PLACES = enumValues("in") as readonly NamedRole[];
const HAS = enumValues("has");
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

  const parseAtom = (dflt: Field | undefined): QueryNode | null => {
    const tk = toks[pos];
    if (!tk) return null;
    switch (tk.t.kind) {
      case "open":
        pos++;
        return parseGroup(tk, dflt);
      case "field": {
        pos++;
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
    const node = parseAtom(dflt);
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
    let left = parseAnd(dflt);
    if (left !== null) nodes.push(left);
    while (toks[pos]?.t.kind === "or") {
      const op = toks[pos++];
      const right = parseAnd(dflt);
      if (op) op.t.state = left === null || right === null ? "incomplete" : "ok";
      if (right !== null) nodes.push(right);
      left = right;
    }
    return combine("or", nodes);
  };

  const root = parseOr(undefined);
  return { root, tokens: toks.map((x) => x.t), diagnostics };
}

/** A query that constrains nothing behaves like no query at all. */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.root === null;
}
