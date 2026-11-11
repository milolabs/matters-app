import type { ClockPort } from "@matters/core";

export interface FlagRunnerDeps {
  readonly clock: ClockPort;
  /** Pushes every request that is due. */
  process(): Promise<void>;
  /** `nextAttemptMs` of the earliest waiting request, or null. */
  nextDueMs(): Promise<number | null>;
  onError(error: unknown): void;
}

/** A timer never sleeps longer than this: a clock that jumped is noticed within it. */
const MAX_SLEEP_MS = 30_000;

/**
 * Drives the push of read state in the sync worker (ADR 0039), modelled on `OutboxRunner`: one
 * timer for the earliest due request, one run at a time. The coalescing is in the data, not here:
 * every request is stored with the time it may go (a second after the latest change), so a
 * `wake()` only has to look at the clock again, and a burst of toggles is one `STORE`.
 * Started with the worker, it also finds the requests an earlier run left behind.
 */
export class FlagRunner {
  private readonly deps: FlagRunnerDeps;
  private cancelTimer: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private armed: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(deps: FlagRunnerDeps) {
    this.deps = deps;
  }

  /** A request was stored or replaced: look at the earliest time again. */
  wake(): void {
    if (this.stopped || this.running) return; // a run ends by arming
    this.armed = this.armed.then(() => this.arm());
  }

  /** Stops the timer and waits for the run in flight, which is never cut short. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.running;
    await this.armed;
  }

  /** Runs what is due now (start-up and tests), then arms for what is not. */
  async runNow(): Promise<void> {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async drain(): Promise<void> {
    try {
      await this.deps.process();
    } catch (error) {
      this.deps.onError(error);
    }
    await this.arm();
  }

  private async arm(): Promise<void> {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    let due: number | null = null;
    try {
      due = await this.deps.nextDueMs();
    } catch (error) {
      this.deps.onError(error);
    }
    if (this.stopped) return;
    const wait =
      due === null
        ? MAX_SLEEP_MS
        : Math.min(MAX_SLEEP_MS, Math.max(0, due - this.deps.clock.now()));
    this.cancelTimer = this.deps.clock.setTimeout(() => {
      this.cancelTimer = null;
      void this.runNow();
    }, wait);
  }
}
