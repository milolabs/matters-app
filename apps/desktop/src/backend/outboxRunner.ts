import type { ClockPort, ReconcileReport, SendOperation } from "@matters/core";

export interface OutboxRunnerDeps {
  readonly clock: ClockPort;
  /** Hands off what is due. */
  process(): Promise<readonly SendOperation[]>;
  /** Settles unknown sends where the provider can tell. */
  reconcile(): Promise<ReconcileReport>;
  /** `notBeforeMs` of the earliest waiting send, or null. */
  nextDueMs(): Promise<number | null>;
  /** Anything unknown, to decide whether reconciling is worth a connection. */
  hasUnknown(): Promise<boolean>;
  onError(error: unknown): void;
}

/** A timer never sleeps longer than this: a clock that jumped is noticed within it. */
const MAX_SLEEP_MS = 30_000;
/** Between attempts to settle an unknown send the provider has not shown yet. */
const RECONCILE_EVERY_MS = 20_000;

/**
 * Drives the outbox in the sync worker (ADR 0019, 0020): one timer for the next due send, woken
 * when a send is queued, undone or released. One run at a time; a wake during a run causes one
 * more run afterwards.
 */
export class OutboxRunner {
  private readonly deps: OutboxRunnerDeps;
  private cancelTimer: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private reconcileDueMs = 0;

  constructor(deps: OutboxRunnerDeps) {
    this.deps = deps;
  }

  /** Run soon: something changed. */
  wake(): void {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  /** Stops the timer and waits for the run in flight, which is never cut short. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.running;
  }

  /** Runs now, even if a reconcile pause is pending (start-up and tests). */
  async runNow(): Promise<void> {
    this.reconcileDueMs = 0;
    this.wake();
    await this.running;
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      try {
        const done = await this.deps.process();
        const now = this.deps.clock.now();
        const becameUnknown = done.some((op) => op.state.kind === "unknown");
        if ((becameUnknown || now >= this.reconcileDueMs) && (await this.deps.hasUnknown())) {
          const report = await this.deps.reconcile();
          // Only a send the provider may still show later is worth asking about again.
          this.reconcileDueMs =
            report.waiting > 0 ? now + RECONCILE_EVERY_MS : Number.POSITIVE_INFINITY;
        }
      } catch (error) {
        this.deps.onError(error);
      }
    } while (this.again && !this.stopped);
    await this.arm();
  }

  private async arm(): Promise<void> {
    if (this.stopped) return;
    let due: number | null = null;
    try {
      due = await this.deps.nextDueMs();
    } catch (error) {
      this.deps.onError(error);
    }
    const now = this.deps.clock.now();
    const waits: number[] = [MAX_SLEEP_MS];
    if (due !== null) waits.push(Math.max(0, due - now));
    if (Number.isFinite(this.reconcileDueMs) && this.reconcileDueMs > 0) {
      waits.push(Math.max(0, this.reconcileDueMs - now));
    }
    this.cancelTimer = this.deps.clock.setTimeout(
      () => {
        this.cancelTimer = null;
        this.wake();
      },
      Math.min(...waits),
    );
  }
}
