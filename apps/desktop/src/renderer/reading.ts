// The reading in the background (ADR 0117, rule 3a), on the page: the status of each saved view
// with a prompt, read when the agent says something changed and at most once per
// `READING_QUIET_MS`, and the pass that reads now, from its own events. It holds signals only.
// Nothing here is on the keystroke path: no read is asked for by typing.
import type { PromptProgress, ReadingStatus } from "@matters/core";
import { type Accessor, batch, createEffect, createSignal, onCleanup } from "solid-js";
import type { Backend } from "./client.ts";

/** After the last push, before the status is read again. */
export const READING_QUIET_MS = 1000;

export type ReadingBackend = Pick<Backend, "agentReadingStatus" | "onEvent">;

export interface ReadingOptions {
  /** Runs `run` after `ms`; returns a cancel. Tests inject one they control. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly quietMs?: number;
}

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function createReading(backend: ReadingBackend, options: ReadingOptions = {}) {
  const schedule = options.schedule ?? realSchedule;
  const quietMs = options.quietMs ?? READING_QUIET_MS;
  const [status, setStatus] = createSignal<ReadingStatus | null>(null);
  // The pass that reads a view now, as its last event told it; null once it ended.
  const [live, setLive] = createSignal<PromptProgress | null>(null);
  let cancel: (() => void) | null = null;
  let reading = false;
  let again = false;
  let wantFresh = false;

  async function read(fresh: boolean) {
    if (reading) {
      again = true;
      wantFresh ||= fresh;
      return;
    }
    reading = true;
    try {
      let f = fresh;
      do {
        again = false;
        try {
          const next = await backend.agentReadingStatus(f);
          batch(() => setStatus(next));
        } catch {
          // What is shown stays; the next push asks again.
        }
        f = wantFresh;
        wantFresh = false;
      } while (again);
    } finally {
      reading = false;
    }
  }

  function later() {
    if (cancel !== null) return;
    cancel = schedule(() => {
      cancel = null;
      void read(false);
    }, quietMs);
  }

  const off = backend.onEvent((event) => {
    if (event.type === "agentPromptProgress" && event.background === true) {
      const was = live();
      setLive(event.finished ? null : event);
      // A view started or ended: what the others say may change with it.
      if (event.finished || was === null || was.view?.id !== event.view?.id) later();
    } else if (event.type === "agentChanged" || event.type === "viewsChanged") {
      later();
    }
  });

  return {
    status,
    live,
    /** The first read. */
    start: () => read(false),
    /** The popover opened: the counts are computed now, not taken as last computed. */
    fresh: () => read(true),
    refresh: () => read(false),
    dispose() {
      off();
      cancel?.();
    },
  };
}

export type ReadingStore = ReturnType<typeof createReading>;

/**
 * The time, ticking once a second while `active` holds and still otherwise: what is out counts
 * its seconds on the page, with no backend call per tick.
 */
export function createTicker(active: Accessor<boolean>, every = 1000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}
