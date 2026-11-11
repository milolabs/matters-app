/**
 * Promises and asks shown under the message they came from, and the strip's summary of what is still
 * open (ADR 0075). Pure: facts in, lines out. The facts are the ones the code already checked
 * against the mail (ADR 0052); nothing here asks a model or rewrites a quote.
 *
 * A fact's `dueMs` is midnight UTC of a calendar date, and a date is due until its day ends, the
 * same rule `daysLate` follows in the list. "Today" is the calendar day of `nowMs` in `timeZone`
 * (UTC when none is given), so a fact due on the 12th is late from the 13th, wherever the person is.
 */

/** A fact as the thread view carries it: the quote and the message it was found in. */
export interface ThreadFactView {
  readonly kind: "promise" | "ask";
  readonly who: "you" | "them";
  readonly dueMs?: number;
  readonly quote: string;
  readonly messageKey: number;
}

export type PromiseStatus = "open" | "late" | "undated";

export interface PromiseLine {
  readonly messageKey: number;
  readonly who: "you" | "them";
  readonly kind: "promise" | "ask";
  readonly quote: string;
  readonly status: PromiseStatus;
  /** Whole days past the due day; set when `status` is `late`. */
  readonly daysLate?: number;
  /** Whole days until the due day (0 on the day itself); set when `status` is `open`. */
  readonly daysLeft?: number;
  readonly dueMs?: number;
}

export interface OpenPart {
  readonly text: string;
  readonly late: boolean;
}

const DAY_MS = 86_400_000;
export const SUMMARY_MAX_PARTS = 2;
export const SUMMARY_MAX_WORDS = 6;

/** The calendar day of `nowMs` in `timeZone`, as days since the epoch. */
function dayNumber(nowMs: number, timeZone: string | undefined): number {
  if (timeZone === undefined || timeZone === "UTC") return Math.floor(nowMs / DAY_MS);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / DAY_MS);
}

function lineOf(fact: ThreadFactView, today: number): PromiseLine {
  const base = { messageKey: fact.messageKey, who: fact.who, kind: fact.kind, quote: fact.quote };
  if (fact.dueMs === undefined) return { ...base, status: "undated" };
  const due = Math.floor(fact.dueMs / DAY_MS);
  if (due < today) {
    return { ...base, status: "late", dueMs: fact.dueMs, daysLate: today - due };
  }
  return { ...base, status: "open", dueMs: fact.dueMs, daysLeft: due - today };
}

const byDue = (a: PromiseLine, b: PromiseLine): number =>
  (a.dueMs ?? Number.POSITIVE_INFINITY) - (b.dueMs ?? Number.POSITIVE_INFINITY);

/**
 * One line per fact, oldest message first; under one message the earliest due date comes first and
 * the undated come last. Facts of equal rank keep the order they came in.
 */
export function promiseLines(
  facts: readonly ThreadFactView[],
  nowMs: number,
  timeZone?: string,
): PromiseLine[] {
  const today = dayNumber(nowMs, timeZone);
  return facts
    .map((f, i) => ({ line: lineOf(f, today), i }))
    .sort((a, b) => a.line.messageKey - b.line.messageKey || byDue(a.line, b.line) || a.i - b.i)
    .map((x) => x.line);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov", or "12 Nov 2027" when the year is not the current one. */
export function dueDayText(dueMs: number, nowMs: number, timeZone?: string): string {
  const d = new Date(dueMs);
  const year = new Date(dayNumber(nowMs, timeZone) * DAY_MS).getUTCFullYear();
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === year ? base : `${base} ${d.getUTCFullYear()}`;
}

export const daysText = (n: number, word: string): string =>
  `${n} ${n === 1 ? "day" : "days"} ${word}`;

/** The quote's own words, cut to `SUMMARY_MAX_WORDS` with an ellipsis when it was longer. */
export function trimQuote(quote: string): string {
  const words = quote
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length <= SUMMARY_MAX_WORDS) return words.join(" ");
  return `${words.slice(0, SUMMARY_MAX_WORDS).join(" ")}…`;
}

/**
 * The parts of "Still open: …" in the agent strip: late ones first (the longest overdue first),
 * then by due date, undated last; at most two. The noun phrase is the quote as it stands.
 */
export function openSummary(
  facts: readonly ThreadFactView[],
  nowMs: number,
  timeZone?: string,
): OpenPart[] {
  const lines = promiseLines(facts, nowMs, timeZone);
  const rank = (l: PromiseLine) => (l.status === "late" ? 0 : l.status === "open" ? 1 : 2);
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || byDue(a.l, b.l) || a.i - b.i)
    .slice(0, SUMMARY_MAX_PARTS)
    .map(({ l }) => {
      // Whose it is and what it is, then the quote in quotation marks, so a question someone
      // asked never reads as the person's own words.
      // `who` is who is on the hook. A promise belongs to whoever is on the hook; a request belongs
      // to the other side (they asked, you owe the answer).
      const ask = l.kind === "ask";
      const mine = ask ? l.who === "them" : l.who === "you";
      const head = `${mine ? "your" : "their"} ${ask ? "request" : "promise"} „${trimQuote(l.quote)}”`;
      if (l.status === "late")
        return { text: `${head}, ${daysText(l.daysLate ?? 0, "late")}`, late: true };
      if (l.status === "open" && l.dueMs !== undefined) {
        return { text: `${head}, by ${dueDayText(l.dueMs, nowMs, timeZone)}`, late: false };
      }
      return { text: head, late: false };
    });
}
