import { type FileHit, type ParsedQuery, parseQuery } from "@matters/core";
import {
  freeSpans,
  type LiveAnswer,
  type PersonRow,
  peopleRows,
  type ThreadRow,
} from "./liveSearch.ts";
import { addField, addFilter, removeField, removeFilter, senderToken } from "./queryEdits.ts";
import {
  type Edit,
  matchesPerson,
  type Suggestion,
  type SuggestionGroup,
} from "./querySuggestions.ts";

/**
 * ADR 0076. The rows of the search panel as one ordered list: live results first (Threads, People,
 * Files, then the row that asks the agent), the groups that only suggest syntax after them. The
 * keyboard walks the flat list, so the order here is the order of the arrow keys. Pure.
 */
export type PanelItem =
  | { readonly kind: "suggestion"; readonly suggestion: Suggestion }
  | { readonly kind: "thread"; readonly row: ThreadRow }
  | { readonly kind: "person"; readonly row: PersonRow; readonly edit: Edit }
  | { readonly kind: "file"; readonly hit: FileHit }
  | { readonly kind: "ask"; readonly text: string };

export interface PanelGroup {
  readonly title: string;
  readonly live: boolean;
  readonly items: readonly PanelItem[];
}

export interface PanelInput {
  readonly text: string;
  readonly parsed: ParsedQuery;
  /** The groups `querySuggestions` made for the caret. */
  readonly groups: readonly SuggestionGroup[];
  /** The latest live answer, or null when no live result is wanted. */
  readonly live: LiveAnswer | null;
  /** The words of the query now, when they call for live results. */
  readonly words: readonly string[];
  readonly own: ReadonlySet<string>;
  readonly canAsk: boolean;
}

/** Whether every typed word starts a word of the person's name or address. */
function namesPerson(row: PersonRow, words: readonly string[]): boolean {
  return words.length > 0 && words.every((w) => matchesPerson({ ...row, count: 0 }, w));
}

/**
 * The edit that chooses a person: `from:<address>`. When every free word of the query was only
 * finding this person, they give way to the token; otherwise the words stay and the token is
 * added (ADR 0026). Null when the address cannot be written as a token.
 */
export function personEdit(
  text: string,
  parsed: ParsedQuery,
  row: PersonRow,
  words: readonly string[],
): Edit | null {
  const token = senderToken(row.address, false);
  if (token === null) return null;
  let base = text;
  if (namesPerson(row, words)) {
    const spans = freeSpans(text, parsed).sort((a, b) => b.start - a.start);
    for (const { start, end } of spans) base = `${base.slice(0, start)}${base.slice(end)}`;
    base = base.replace(/\s{2,}/g, " ").trim();
  }
  const next = addFilter(base, token);
  return { start: 0, end: text.length, text: next, caret: next.length };
}

export function panelGroups(input: PanelInput): PanelGroup[] {
  const out: PanelGroup[] = [];
  const live = input.live;
  const wanted = input.words.length > 0;
  if (wanted && live !== null && live.text === input.text) {
    if (live.threads.length > 0) {
      out.push({
        title: "Threads",
        live: true,
        items: live.threads.map((row) => ({ kind: "thread", row })),
      });
    }
    const people: PanelItem[] = [];
    for (const row of peopleRows(live.people, live.threads, input.words, input.own)) {
      const edit = personEdit(input.text, input.parsed, row, input.words);
      if (edit !== null) people.push({ kind: "person", row, edit });
    }
    if (people.length > 0) out.push({ title: "People", live: true, items: people });
    if (live.files.length > 0) {
      out.push({
        title: "Files",
        live: true,
        items: live.files.map((hit) => ({ kind: "file", hit })),
      });
    }
  }
  if (wanted && input.canAsk) {
    out.push({
      title: "Ask",
      live: true,
      items: [{ kind: "ask", text: input.text.trim() }],
    });
  }
  for (const g of input.groups) {
    // The live people replace the suggestion of people for the word being typed.
    if (wanted && g.title === "People") continue;
    out.push({
      title: g.title,
      live: false,
      items: g.items.map((suggestion) => ({ kind: "suggestion", suggestion })),
    });
  }
  return out;
}

/** The query has been answered and nothing matched a thread: one quiet line. */
export function noThreadMatches(input: PanelInput): boolean {
  const live = input.live;
  return (
    input.words.length > 0 && live !== null && live.text === input.text && live.threads.length === 0
  );
}

/** How many live rows (threads, people, files) the panel holds: the number announced. */
export function liveCount(groups: readonly PanelGroup[]): number {
  return groups.filter((g) => g.live && g.title !== "Ask").reduce((n, g) => n + g.items.length, 0);
}

// -- The pills at the top of the panel: quick access to filters, as token editors ---------------

export type PillId = "from" | "account" | "attachment" | "unread" | "date";

export interface Pill {
  readonly id: PillId;
  readonly label: string;
  readonly on: boolean;
}

const FIELD_OF: Record<"from" | "account", string> = { from: "from", account: "account" };

/** Whether a top-level, ok `field:` token (any value) is in the query. */
function hasField(text: string, fields: readonly string[]): boolean {
  return parseQuery(text).tokens.some(
    (t) =>
      t.kind === "field" && t.state === "ok" && t.field !== undefined && fields.includes(t.field),
  );
}

export function pills(text: string, accountCount: number): Pill[] {
  const out: Pill[] = [{ id: "from", label: "From…", on: hasField(text, ["from"]) }];
  if (accountCount > 1) {
    out.push({ id: "account", label: "Account…", on: hasField(text, ["account"]) });
  }
  out.push(
    {
      id: "attachment",
      label: "Has attachment",
      on: addFilter(text, "has:attachment") === text,
    },
    { id: "unread", label: "Unread", on: addFilter(text, "is:unread") === text },
    { id: "date", label: "Any time", on: hasField(text, ["after", "before"]) },
  );
  return out;
}

/**
 * What clicking a pill does to the text. A pill that is on takes its token out; one that is off
 * puts it in: a ready token for the two that need none, otherwise the field, waiting for the
 * value the bar already completes.
 */
export function togglePill(text: string, id: PillId, on: boolean): string {
  switch (id) {
    case "attachment":
      return on ? removeFilter(text, "has:attachment") : addFilter(text, "has:attachment");
    case "unread":
      return on ? removeFilter(text, "is:unread") : addFilter(text, "is:unread");
    case "date":
      return on ? removeField(text, ["after", "before"]) : addField(text, "after");
    default:
      return on ? removeField(text, [FIELD_OF[id]]) : addField(text, FIELD_OF[id]);
  }
}
