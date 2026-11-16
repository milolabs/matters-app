// The mail window's side of `mailto:` links (ADR 0143, rule 5). There is one composer at a time, so
// the first link that waits in main is asked for whenever none is open or opening: when main says
// one came, and when a composer closes or fails to open. Main keeps it first until the window says,
// by the id main gave it, that a composer opened with it. No DOM here, so the tests drive it.
import type { MailtoPrefill } from "@matters/contracts";
import type { OpenOutcome } from "./compose.ts";

/** After a composer that could not be prepared, the next try of the link waits this long. */
export const LINK_RETRY_MS = 2000;

export interface LinkTakerDeps {
  /** The first link that waits in main, with its id; null when none does. */
  take(): Promise<{ id: string; link: MailtoPrefill } | null>;
  /** Tells main how the link of `id` went; how many links still wait. */
  done(id: string, opened: boolean): Promise<number>;
  /** Opens a new message with the link's fields. */
  open(link: MailtoPrefill): Promise<OpenOutcome>;
  /** A composer is open or being opened. */
  busy(): boolean;
  /** Runs `run` after `ms`; the answer cancels it. */
  later(run: () => void, ms: number): () => void;
}

export function createLinkTaker(deps: LinkTakerDeps) {
  let taking = false;
  /** Main said a link came, or a composer closed, while a link was being opened. */
  let again = false;
  let cancelRetry: (() => void) | null = null;

  async function next(): Promise<void> {
    if (taking) {
      again = true;
      return;
    }
    if (deps.busy()) return;
    taking = true;
    again = false;
    cancelRetry?.();
    cancelRetry = null;
    try {
      const waiting = await deps.take();
      if (waiting === null) return;
      const outcome = await deps.open(waiting.link);
      // A composer the person started while the link was asked for: the link stays first in
      // main, and is asked for again once that composer closes or fails to open.
      if (outcome === "busy") return;
      const left = await deps.done(waiting.id, outcome === "opened");
      // It could not be prepared: main keeps it first, a bounded number of times, and it is tried
      // again in a moment, or sooner when something else happens.
      if (outcome === "failed" && left > 0) {
        cancelRetry = deps.later(() => {
          cancelRetry = null;
          void next();
        }, LINK_RETRY_MS);
      }
    } catch {
      // Main or the bridge did not answer: the link stays in main for the next occasion.
    } finally {
      taking = false;
      // What came during this attempt is not left waiting with no one to hear it.
      if (again && !deps.busy()) void next();
    }
  }

  return {
    next,
    /** The window goes: no retry is left behind. */
    stop(): void {
      cancelRetry?.();
      cancelRetry = null;
    },
  };
}
