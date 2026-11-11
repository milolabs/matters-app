// The notices inside the window (ADR 0071, rule 7), as data: what is shown, what waits, and when
// each one goes. The view is noticeStack.tsx; this part has no DOM, so a test can drive it.
import type { NoticeText } from "@matters/core";

/** Shown at once; the rest is counted under them. */
export const SHOWN = 3;
/** Kept at all: an old notice nobody looked at says nothing any more. */
const KEPT = 20;

/** A notice never changes once made, so its card is drawn once; its time is kept beside it. */
export interface Notice extends NoticeText {
  /** Unique in the stack: the same made-up test twice is two notices. */
  readonly id: number;
  /** The time it had when it came; null stays until closed. */
  readonly totalMs: number | null;
}

export interface StackState {
  readonly notices: readonly Notice[];
  /** Milliseconds left, by notice id, for those that go by themselves. */
  readonly left: Readonly<Record<number, number>>;
  readonly nextId: number;
}

export const EMPTY: StackState = { notices: [], left: {}, nextId: 1 };

function keep(left: Readonly<Record<number, number>>, notices: readonly Notice[]) {
  const out: Record<number, number> = {};
  for (const n of notices) {
    const ms = left[n.id];
    if (ms !== undefined) out[n.id] = ms;
  }
  return out;
}

/** New notices go on top, newest first; the same message is not shown twice. */
export function push(
  state: StackState,
  incoming: readonly NoticeText[],
  seconds: number,
): StackState {
  let nextId = state.nextId;
  const totalMs = seconds > 0 ? seconds * 1000 : null;
  const fresh: Notice[] = incoming.map((n) => ({ ...n, id: nextId++, totalMs }));
  const keys = new Set(fresh.filter((n) => n.key > 0).map((n) => n.key));
  const older = state.notices.filter((n) => n.key <= 0 || !keys.has(n.key));
  const notices = [...fresh, ...older].slice(0, KEPT);
  const left: Record<number, number> = { ...state.left };
  if (totalMs !== null) for (const n of fresh) left[n.id] = totalMs;
  return { notices, left: keep(left, notices), nextId };
}

export function dismiss(state: StackState, id: number): StackState {
  const notices = state.notices.filter((n) => n.id !== id);
  return { ...state, notices, left: keep(state.left, notices) };
}

export function clear(state: StackState): StackState {
  return { ...state, notices: [], left: {} };
}

/**
 * Time passes for the notices that are shown, and only while the window is in front and the
 * pointer is not over them: a notice never goes unseen. The ones waiting below keep their time.
 */
export function tick(state: StackState, elapsedMs: number): StackState {
  const left: Record<number, number> = { ...state.left };
  const gone = new Set<number>();
  let changed = false;
  for (const n of state.notices.slice(0, SHOWN)) {
    const ms = left[n.id];
    if (ms === undefined) continue;
    changed = true;
    if (ms - elapsedMs > 0) left[n.id] = ms - elapsedMs;
    else gone.add(n.id);
  }
  if (!changed) return state;
  const notices = gone.size > 0 ? state.notices.filter((n) => !gone.has(n.id)) : state.notices;
  return { ...state, notices, left: keep(left, notices) };
}

/** "3 more" under the shown ones; nothing when all fit. */
export function moreText(state: StackState): string {
  const more = state.notices.length - SHOWN;
  return more > 0 ? `${more} more` : "";
}
