import {
  foldText,
  type ParsedQuery,
  type PersonSuggestion,
  QUERY_FIELDS,
  type QueryFieldName,
  type QueryToken,
  tokenize,
} from "@matters/core";

/** ADR 0026. What the panel offers at the caret. Pure: it never runs a query. */
export interface SuggestionSources {
  /** Folded names from `listLabels`. */
  readonly labels: readonly string[];
  readonly accounts: readonly { id: string; address: string; displayName: string }[];
  /**
   * The latest answer to `suggestPeople` (ADR 0028). It may be for an earlier prefix: the
   * items are narrowed to what is typed now, so a late answer never shows a wrong person.
   */
  readonly people: readonly PersonSuggestion[];
  /** ADR 0030. The active view's searches, latest first, offered while nothing was typed. */
  readonly recent?: readonly string[];
  /** The text the active view stands for: the bar holding it means nothing was typed. */
  readonly baseline?: string;
}

/** Replace `text[start, end)` with `text`, then put the caret at `caret`. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly caret: number;
}

export interface Suggestion {
  readonly label: string;
  readonly hint: string;
  /** Shown on the right (messages with this person). */
  readonly count?: number;
  readonly edit: Edit;
  /** A recent search: replaces the text, and can be forgotten. */
  readonly recent?: string;
  /** The row that clears the view's recent searches; it edits nothing. */
  readonly clearsRecent?: boolean;
}

export interface SuggestionGroup {
  readonly title: string;
  readonly items: readonly Suggestion[];
}

const MAX_LABELS = 20;
/** People asked for and shown in a field value, and in the group of a plain word. */
export const PEOPLE_IN_VALUE = 8;
const PEOPLE_IN_WORD = 5;
/** A plain word this long (folded) starts asking for people. */
const PEOPLE_WORD_MIN = 2;
const RECENT_SHOWN = 5;
const PLAIN_ADDRESS = /^[^\s()":]+$/;
const DATE_PRESETS: readonly (readonly [string, string])[] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["-7d", "7 days ago"],
  ["-30d", "30 days ago"],
  ["-1y", "A year ago"],
];

const quoted = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

function replace(start: number, end: number, text: string, back = 0): Edit {
  return { start, end, text, caret: start + text.length - back };
}

/** One word per account that, typed after `account:`, matches that account only. */
function accountWords(accounts: SuggestionSources["accounts"]) {
  const matches = (word: string, a: SuggestionSources["accounts"][number]) => {
    const theirs = tokenize(`${a.displayName} ${a.address}`);
    return theirs.some((t) => t.startsWith(word));
  };
  return accounts.map((a) => {
    const first = tokenize(a.displayName)[0];
    const unique =
      first !== undefined && accounts.filter((other) => matches(first, other)).length === 1;
    return { word: unique ? first : a.address.toLowerCase(), hint: a.address, account: a };
  });
}

/** Whether what was typed (folded words) starts words of the person, as the index reads it. */
export function matchesPerson(p: PersonSuggestion, typed: string): boolean {
  const want = tokenize(typed);
  if (want.length === 0) return false;
  const have = tokenize(`${p.name ?? ""} ${p.address}`);
  return want.every((w) => have.some((h) => h.startsWith(w)));
}

/** The people that fit `typed`, as suggestions that insert `insert(address)`. */
function personItems(
  people: readonly PersonSuggestion[],
  typed: string,
  max: number,
  edit: (address: string) => Edit,
): Suggestion[] {
  const items: Suggestion[] = [];
  for (const p of people) {
    if (items.length >= max) break;
    // An address the parser could not read back whole is not offered.
    if (!PLAIN_ADDRESS.test(p.address)) continue;
    // Nothing typed: the frequent people, as the backend ranked them (ADR 0029).
    if (typed.trim() !== "" && !matchesPerson(p, typed)) continue;
    const named = p.name !== undefined && p.name !== "";
    items.push({
      label: named ? (p.name as string) : p.address,
      hint: named ? p.address : "",
      count: p.count,
      edit: edit(p.address),
    });
  }
  return items;
}

function valueItems(
  field: QueryFieldName,
  typed: string,
  start: number,
  end: number,
  sources: SuggestionSources,
): SuggestionGroup[] {
  const info = QUERY_FIELDS[field];
  const want = foldText(typed).trim();
  const done = (value: string, label: string, hint: string): Suggestion => ({
    label,
    hint,
    edit: replace(start, end, `${quoted(value)} `),
  });
  let items: Suggestion[] = [];
  switch (info.type) {
    case "person":
      if ("me".startsWith(want)) items = [done("me", "me", "Any of your addresses")];
      // The address is what is inserted, however much of the name was typed.
      items.push(
        ...personItems(sources.people, typed, PEOPLE_IN_VALUE, (a) => replace(start, end, `${a} `)),
      );
      break;
    case "enum":
      items = Object.entries(info.values)
        .filter(([k]) => k.startsWith(want))
        .map(([k, hint]) => done(k, k, hint));
      break;
    case "label":
      items = sources.labels
        .filter((l) => l.startsWith(want))
        .slice(0, MAX_LABELS)
        .map((l) => done(l, l, ""));
      break;
    case "account":
      items = accountWords(sources.accounts)
        .filter(({ word, account }) => {
          const theirs = tokenize(`${account.displayName} ${account.address}`);
          return word.startsWith(want) || theirs.some((t) => t.startsWith(want));
        })
        .map(({ word, hint }) => done(word, word, hint));
      break;
    case "date":
      items = DATE_PRESETS.filter(([k]) => k.startsWith(typed.trim().toLowerCase())).map(
        ([k, hint]) => done(k, k, hint),
      );
      break;
    default:
      break;
  }
  return items.length === 0 ? [] : [{ title: info.hint, items }];
}

/** The token the caret is inside or right after, if it is one that can be completed. */
function tokenAt(parsed: ParsedQuery, caret: number): QueryToken | undefined {
  return parsed.tokens.find(
    (t) => (t.kind === "field" || t.kind === "word") && caret > t.start && caret <= t.end,
  );
}

/** Where the caret is, for suggestions: a field's value, or a term. */
type Context =
  | {
      readonly kind: "value";
      readonly field: QueryFieldName;
      readonly typed: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "term"; readonly token: QueryToken | undefined };

function contextAt(text: string, c: number, parsed: ParsedQuery): Context {
  const t = tokenAt(parsed, c);
  if (t?.kind === "field" && t.field !== undefined) {
    const vs = t.valueStart ?? t.end;
    const field = t.field as QueryFieldName;
    // A quoted value or a `field:(` group is the user's own business.
    if (c >= vs && text.charAt(vs) !== '"' && text.charAt(t.end) !== "(" && field in QUERY_FIELDS) {
      return { kind: "value", field, typed: text.slice(vs, c), start: vs, end: t.end };
    }
  } else if (t?.kind === "word" && t.field !== undefined) {
    return {
      kind: "value",
      field: t.field as QueryFieldName,
      typed: text.slice(t.start, c),
      start: t.start,
      end: t.end,
    };
  }
  return { kind: "term", token: t };
}

/**
 * The text people should be asked for at the caret, or null when the context wants none: only
 * the value of a from, to or cc (empty asks for the frequent people), and a plain word of two characters or more (ADR 0028).
 */
export function peoplePrefix(text: string, caret: number, parsed: ParsedQuery): string | null {
  const c = Math.min(Math.max(caret, 0), text.length);
  const ctx = contextAt(text, c, parsed);
  if (ctx.kind === "value") {
    if (!(ctx.field in QUERY_FIELDS) || QUERY_FIELDS[ctx.field].type !== "person") return null;
    const typed = ctx.typed.trim();
    return typed === "" || tokenize(typed).length > 0 ? typed : null;
  }
  const t = ctx.token;
  if (t?.kind !== "word") return null;
  const typed = text.slice(t.start, c);
  // `foo:` is a field that does not exist, not somebody's name.
  if (typed.includes(":")) return null;
  return foldText(typed).trim().length >= PEOPLE_WORD_MIN && tokenize(typed).length > 0
    ? typed
    : null;
}

/** ADR 0030. Only while the bar holds what the view stands for: typing is not interrupted. */
function recentGroups(text: string, sources: SuggestionSources): SuggestionGroup[] {
  const now = text.trim();
  if (now !== (sources.baseline ?? "").trim()) return [];
  const items: Suggestion[] = (sources.recent ?? [])
    .filter((q) => q !== now)
    .slice(0, RECENT_SHOWN)
    .map((q) => ({
      label: q,
      hint: "",
      recent: q,
      edit: replace(0, text.length, q),
    }));
  if (items.length === 0) return [];
  const caret = text.length;
  const clear: Suggestion = {
    label: "Clear all",
    hint: "",
    clearsRecent: true,
    edit: { start: caret, end: caret, text: "", caret },
  };
  return [{ title: "Recent", items: [...items, clear] }];
}

export function querySuggestions(
  text: string,
  caret: number,
  parsed: ParsedQuery,
  sources: SuggestionSources,
): readonly SuggestionGroup[] {
  return [...recentGroups(text, sources), ...suggestionsAt(text, caret, parsed, sources)];
}

function suggestionsAt(
  text: string,
  caret: number,
  parsed: ParsedQuery,
  sources: SuggestionSources,
): readonly SuggestionGroup[] {
  const c = Math.min(Math.max(caret, 0), text.length);
  const ctx = contextAt(text, c, parsed);
  if (ctx.kind === "value") {
    return valueItems(ctx.field, ctx.typed, ctx.start, ctx.end, sources);
  }
  const t = ctx.token;

  const prev = text.charAt(c - 1);
  const afterSpace = c > 0 && /\s/.test(prev);
  const startsTerm = c === 0 || afterSpace || prev === "(" || prev === "-";
  if (t === undefined && (!startsTerm || (c < text.length && !/\s/.test(text.charAt(c))))) {
    return [];
  }
  const typed = t === undefined ? "" : foldText(text.slice(t.start, c));
  const start = t?.start ?? c;
  const end = t?.end ?? c;
  const groups: SuggestionGroup[] = [];
  const word = peoplePrefix(text, c, parsed);
  if (word !== null) {
    const items = personItems(sources.people, word, PEOPLE_IN_WORD, (a) =>
      replace(start, end, `from:${a} `),
    );
    if (items.length > 0) groups.push({ title: "People", items });
  }
  const fields = (Object.keys(QUERY_FIELDS) as QueryFieldName[])
    .filter((k) => k.startsWith(typed))
    .map((k) => ({
      label: `${k}:`,
      hint: QUERY_FIELDS[k].hint,
      edit: replace(start, end, `${k}:`),
    }));
  if (fields.length > 0) groups.push({ title: "Filters", items: fields });
  if (t === undefined && afterSpace && text.trim() !== "") {
    groups.push({
      title: "Combine",
      items: [
        { label: "OR", hint: "Either side matches", edit: replace(c, c, "OR ") },
        { label: "-", hint: "Exclude the next term, like -from:anna", edit: replace(c, c, "-") },
        { label: "( )", hint: "Group terms, like (a OR b) c", edit: replace(c, c, "()", 1) },
      ],
    });
  }
  return groups;
}
