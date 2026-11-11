import { linkify, readablePieces } from "./body.ts";
import { countHits } from "./hits.ts";

/**
 * ADR 0077. Walking through the matches of a thread. A match is one marked place in the words of a
 * letter (not in its title, its snippet or its file names, which are marked but are not stops).
 * The letters are numbered from the first; `Slot` says how many stops each has, and a match is
 * its place in the whole run. Pure: the reader turns a place into an element.
 */
export interface Slot {
  readonly key: number;
  readonly count: number;
}

/** Where a match is: which letter, and which of that letter's matches it is (from 0). */
export interface Place {
  readonly key: number;
  readonly ordinal: number;
}

/**
 * The stops in one plain body, counted the way the reader marks them: piece by piece, and a link
 * on its own (a word never matches across the edge of a link).
 */
export function letterMatches(bodyText: string, words: readonly string[]): number {
  if (words.length === 0 || bodyText === "") return 0;
  let n = 0;
  for (const piece of readablePieces(bodyText)) {
    for (const part of linkify(piece)) n += countHits(part.text, words);
  }
  return n;
}

export const totalMatches = (slots: readonly Slot[]): number =>
  slots.reduce((sum, s) => sum + s.count, 0);

/** The place of match number `index` (from 0), or null when there is none. */
export function locate(slots: readonly Slot[], index: number): Place | null {
  if (index < 0) return null;
  let left = index;
  for (const slot of slots) {
    if (left < slot.count) return { key: slot.key, ordinal: left };
    left -= slot.count;
  }
  return null;
}

/**
 * The match after a step. `current` is -1 before any has been chosen: forwards goes to the first,
 * backwards to the last. Both wrap. -1 when there is nothing to stop at.
 */
export function stepMatch(current: number, delta: 1 | -1, total: number): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return delta === 1 ? 0 : total - 1;
  return (current + delta + total) % total;
}

/** What has to open for a letter to show a match. */
export interface Reveal {
  /** The run of folded earlier messages unfolds. */
  readonly unfold: boolean;
  /** The letter itself opens. */
  readonly open: boolean;
}

export function planReveal(
  key: number,
  state: { readonly folded: ReadonlySet<number>; readonly open: ReadonlySet<number> },
): Reveal {
  return { unfold: state.folded.has(key), open: state.folded.has(key) || !state.open.has(key) };
}

/** A count that follows the words: the position text of the toolbar. */
export function matchLabel(current: number, total: number): string {
  if (total <= 0) return "";
  if (current < 0 || current >= total) return total === 1 ? "1 match" : `${total} matches`;
  return `${current + 1} of ${total}`;
}
