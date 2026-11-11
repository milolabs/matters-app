import type { ClockPort } from "@matters/core";

/** What one step of the move did, and whether any of it is left (ADR 0088). */
export interface RepackStepResult {
  readonly moved: number;
  readonly done: boolean;
}

export interface HtmlRepackOptions {
  readonly step: () => Promise<RepackStepResult>;
  readonly clock: ClockPort;
  /** Wait after launch before the first step; default 20 s, so launch and first sync go first. */
  readonly startDelayMs?: number;
  /** Wait between two steps; default 100 ms, so new mail never queues long behind one. */
  readonly pauseMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Moves HTML kept per thread into blocks per sender, one small write at a time, on the sync
 * worker (ADR 0088). It ends when the work list is empty; an error ends it until the next
 * launch, which starts again where this one stopped. Returns the function that stops it.
 */
export function startHtmlRepack(options: HtmlRepackOptions): () => void {
  const { step, clock, startDelayMs = 20_000, pauseMs = 100 } = options;
  let stopped = false;
  let cancel: (() => void) | null = null;
  const run = () => {
    cancel = null;
    if (stopped) return;
    step().then(
      ({ done }) => {
        if (!done && !stopped) cancel = clock.setTimeout(run, pauseMs);
      },
      (error) => options.onError?.(error),
    );
  };
  cancel = clock.setTimeout(run, startDelayMs);
  return () => {
    stopped = true;
    cancel?.();
    cancel = null;
  };
}
