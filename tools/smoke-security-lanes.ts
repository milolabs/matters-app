// The lanes of one corpus case in tools/smoke-security.ts (ADR 0047): a case read through the
// reader's own pipeline reports in `blocked` and `images`; one put past it (`bypass`) in lanes of
// its own. What a case's links did is read in that case's own blocked lane, so a check of what a
// link opened never passes over an empty set.

export interface Lanes {
  readonly blocked: string;
  readonly images: string;
}

/** The lanes a case of this mode reports in. */
export function lanesOf(mode: string): Lanes {
  return mode === "bypass"
    ? { blocked: "bypass-blocked", images: "bypass-images" }
    : { blocked: "blocked", images: "images" };
}

/** What a link in the blocked lane did: the links handed to the system, the messages opened. */
export function linkEvents<E extends { readonly kind: string; readonly lane: string }>(
  events: readonly E[],
  lanes: Lanes,
): { readonly opened: E[]; readonly composed: E[] } {
  const mine = events.filter((e) => e.lane === lanes.blocked);
  return {
    opened: mine.filter((e) => e.kind === "open-external"),
    composed: mine.filter((e) => e.kind === "compose"),
  };
}
