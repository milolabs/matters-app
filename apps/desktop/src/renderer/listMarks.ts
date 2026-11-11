// Several rows of a list chosen at once (ADR 0056, rule 3). The arithmetic is pure, so it is tested
// without a page; `createMarks` only holds it in signals. Ids are whatever names a row in its list:
// a message key in the mail lists, a thread id in Matters.
import { createSignal } from "solid-js";

export interface MarksState<T> {
  readonly ids: ReadonlySet<T>;
  /** Where a Shift range is measured from. */
  readonly anchor: T | null;
  /** The far end of the range, which Shift with an arrow moves. */
  readonly head: T | null;
}

export function noMarks<T>(): MarksState<T> {
  return { ids: new Set(), anchor: null, head: null };
}

/** ⌘-click: the row joins or leaves. The row being read joins with the first one. */
export function toggled<T>(state: MarksState<T>, id: T, current: T | undefined): MarksState<T> {
  const ids = new Set(state.ids);
  if (ids.size === 0 && current !== undefined) ids.add(current);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id, head: id };
}

/** ⇧-click and ⇧-arrow: every row between the anchor and this one, and only those. */
export function ranged<T>(
  state: MarksState<T>,
  order: readonly T[],
  id: T,
  current: T | undefined,
): MarksState<T> {
  const anchor = state.anchor ?? current ?? id;
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return { ids: new Set([id]), anchor: id, head: id };
  return { ids: new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)), anchor, head: id };
}

/** The row Shift with an arrow reaches: one on from the head, stopping at the ends. */
export function stepped<T>(
  state: MarksState<T>,
  order: readonly T[],
  delta: number,
  current: T | undefined,
): T | undefined {
  const from = state.head ?? current;
  const at = from === undefined ? -1 : order.indexOf(from);
  if (at < 0) return undefined;
  return order[Math.min(Math.max(at + delta, 0), order.length - 1)];
}

/** Marks over a list that changes under them: rows that left no longer count. */
export function createMarks<T>(order: () => readonly T[], current: () => T | undefined) {
  const [state, setState] = createSignal<MarksState<T>>(noMarks<T>());
  // Every row asks this each frame: worked out once per change. A plain function rather than a memo,
  // as in the agent's store, so it needs no root and costs nothing while nothing is chosen.
  let from: readonly [ReadonlySet<T>, readonly T[]] | null = null;
  let kept: ReadonlySet<T> = new Set();
  const ids = (): ReadonlySet<T> => {
    const marked = state().ids;
    if (marked.size === 0) return marked;
    const list = order();
    if (from?.[0] !== marked || from[1] !== list) {
      from = [marked, list];
      kept = new Set(list.filter((id) => marked.has(id)));
    }
    return kept;
  };
  const clear = () => {
    if (state().ids.size > 0 || state().anchor !== null) setState(noMarks<T>());
  };
  return {
    ids,
    /** Two rows or more: the reader shows the stack, and the keys act on all of them. */
    active: () => ids().size >= 2,
    has: (id: T) => ids().has(id),
    head: () => state().head,
    clear,
    /** ⌘-click. Returns the one row left when only one is, so that it can simply open. */
    toggle(id: T): T | undefined {
      const next = toggled(state(), id, current());
      if (next.ids.size === 1) {
        setState(noMarks<T>());
        return [...next.ids][0];
      }
      setState(next);
      return undefined;
    },
    /** ⇧-click. */
    extendTo(id: T) {
      setState(ranged(state(), order(), id, current()));
    },
    /** ⇧ with an arrow. */
    extendBy(delta: number) {
      const to = stepped(state(), order(), delta, current());
      if (to !== undefined) setState(ranged(state(), order(), to, current()));
    },
    /** ⌘A: everything the list has loaded. */
    all() {
      const list = order();
      // No head: choosing everything does not walk the list to its end, which would page in more.
      setState({ ids: new Set(list), anchor: list[0] ?? null, head: null });
    },
  };
}

export type Marks<T> = ReturnType<typeof createMarks<T>>;
