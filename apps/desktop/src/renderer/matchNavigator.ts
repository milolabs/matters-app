import type { ThreadMessage } from "@matters/contracts";
import { type Accessor, createEffect, createMemo, createSignal, on } from "solid-js";
import {
  letterMatches,
  locate,
  matchLabel,
  type Place,
  stepMatch,
  totalMatches,
} from "./matchNav.ts";

/** A request to show a match: bumped `n` makes the same place show again. */
export interface Showing extends Place {
  readonly n: number;
}

export interface MatchNavigator {
  total(): number;
  /** The match chosen, from 0, or -1 before any. */
  current(): number;
  label(): string;
  /** Moves to the next (1) or previous (-1) match; wraps. False when there are none. */
  step(delta: 1 | -1): boolean;
  /** The place the reader has to show now. */
  showing(): Showing | null;
}

/**
 * ADR 0077. The walk through a thread's matches as signals; the order and the wrapping are
 * `matchNav.ts`. The walk starts again when the thread or the words change.
 */
export function createMatchNavigator(
  messages: Accessor<readonly ThreadMessage[] | undefined>,
  words: Accessor<readonly string[]>,
  threadId: Accessor<string | undefined>,
): MatchNavigator {
  const slots = createMemo(() => {
    const w = words();
    const list = messages() ?? [];
    if (w.length === 0) return [];
    // A message with HTML opens as the sender made it, in a frame we do not mark (ADR 0077, 0094).
    return list.map((m) => ({
      key: m.key,
      count: m.htmlKind === undefined ? letterMatches(m.bodyText, w) : 0,
    }));
  });
  const total = createMemo(() => totalMatches(slots()));
  const [current, setCurrent] = createSignal(-1);
  const [showing, setShowing] = createSignal<Showing | null>(null);
  let n = 0;
  createEffect(
    on([threadId, words], () => {
      setCurrent(-1);
      setShowing(null);
    }),
  );
  return {
    total,
    current,
    label: () => matchLabel(current(), total()),
    step(delta) {
      const next = stepMatch(current(), delta, total());
      if (next < 0) return false;
      const place = locate(slots(), next);
      if (place === null) return false;
      setCurrent(next);
      setShowing({ ...place, n: ++n });
      return true;
    },
    showing,
  };
}
