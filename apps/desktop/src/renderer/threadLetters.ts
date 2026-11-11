import type { ThreadMessage } from "@matters/contracts";

/**
 * The letters of an open thread are keyed by message key, not by the message object. A refetch
 * (a reply arrived, a message was marked read) hands back new objects for the same messages, and
 * a list keyed by object would take every letter for a new one: open letters would fold, and the
 * frame of a message sent as designed would load again. Keys stay put when only a flag moves.
 */
export function letterKeys(messages: readonly ThreadMessage[]): number[] {
  return messages.map((m) => m.key);
}

/** For the memo's `equals`: the same keys in the same order change nothing. */
export function sameKeys(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** What the fold rule needs to know about each letter, oldest first. */
export interface FoldInput {
  /** Whether the letter starts open (the newest and the unread do). */
  readonly open: boolean;
  readonly dateMs: number;
  /** A promise or ask is shown under this message: it stays a row of its own (ADR 0075). */
  readonly hasPromise?: boolean;
}

/** The run of letters one row stands for: `start` to `end` (exclusive) in the thread's order. */
export interface FoldRun {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly fromMs: number;
  readonly toMs: number;
}

/** A run this long, before the first open letter, is folded (ADR 0073, rule 5). */
export const FOLD_AFTER = 3;

/**
 * Three or more collapsed letters in a row before the first open one: the first stays as a row, the
 * rest of the run becomes one row ("N earlier messages"). Nothing else folds: a collapsed letter
 * after an open one is a row of its own. Decided once per thread render, from the starting state.
 *
 * A letter with a promise line under it is never folded away (ADR 0075, rule 4): it splits the run,
 * and the longest stretch of letters without one that is long enough is the one that folds.
 */
export function foldRun(letters: readonly FoldInput[]): FoldRun | null {
  const firstOpen = letters.findIndex((l) => l.open);
  const run = firstOpen < 0 ? letters.length : firstOpen;
  if (run < FOLD_AFTER) return null;
  let best: { start: number; end: number } | null = null;
  let start = 1;
  for (let i = 1; i <= run; i++) {
    if (i < run && (letters[i] as FoldInput).hasPromise !== true) continue;
    if (i - start >= FOLD_AFTER - 1 && (best === null || i - start > best.end - best.start)) {
      best = { start, end: i };
    }
    start = i + 1;
  }
  if (best === null) return null;
  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;
  for (let i = best.start; i < best.end; i++) {
    const ms = (letters[i] as FoldInput).dateMs;
    if (ms < fromMs) fromMs = ms;
    if (ms > toMs) toMs = ms;
  }
  return { ...best, count: best.end - best.start, fromMs, toMs };
}

/** For the memo's `equals`: the same run changes nothing. */
export function sameRun(a: FoldRun | null, b: FoldRun | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end && a.fromMs === b.fromMs && a.toMs === b.toMs;
}
