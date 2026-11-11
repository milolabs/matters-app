import type { PromiseLine } from "@matters/core";
import { daysText, dueDayText } from "@matters/core";

// What a promise line says (ADR 0075). The words are fixed here; the only text from the mail is the
// quote, shown as a text node in ink colour.

/** The words before the quote: who is on the hook, and whether it was promised or asked. */
export function lineLead(line: PromiseLine): string {
  if (line.kind === "promise") return line.who === "you" ? "You promised" : "Promised";
  return line.who === "you" ? "Asks you" : "You asked";
}

/**
 * The text of the third column: how late, or the date and what is left; nothing for a fact with no
 * date. The day the thing is due reads "today".
 */
export function lineTrail(line: PromiseLine, nowMs: number, timeZone?: string): string {
  if (line.status === "late") return daysText(line.daysLate ?? 0, "late");
  if (line.status !== "open" || line.dueMs === undefined) return "";
  const left = line.daysLeft ?? 0;
  return `by ${dueDayText(line.dueMs, nowMs, timeZone)} · ${left === 0 ? "today" : daysText(left, "left")}`;
}

/** The whole line as one sentence, for a screen reader (the markers are hidden from it). */
export function lineLabel(line: PromiseLine, nowMs: number, timeZone?: string): string {
  const trail = lineTrail(line, nowMs, timeZone);
  return `${lineLead(line)} „${line.quote}”${trail === "" ? "" : `, ${trail}`}`;
}

/** The lines of each message, by its key; the order within a message is kept. */
export function linesByMessage(lines: readonly PromiseLine[]): ReadonlyMap<number, PromiseLine[]> {
  const map = new Map<number, PromiseLine[]>();
  for (const l of lines) {
    const at = map.get(l.messageKey);
    if (at === undefined) map.set(l.messageKey, [l]);
    else at.push(l);
  }
  return map;
}
