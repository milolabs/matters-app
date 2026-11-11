import type { ClockPort } from "@matters/core";

/** Time that moves only when a test says so; `random` returns a fixed value. */
export class ManualClock implements ClockPort {
  private nowMs = 0;
  private seq = 0;
  private timers: { id: number; at: number; run: () => void }[] = [];
  randomValue = 0.5;

  now(): number {
    return this.nowMs;
  }

  random(): number {
    return this.randomValue;
  }

  setTimeout(run: () => void, delayMs: number): () => void {
    const id = ++this.seq;
    this.timers.push({ id, at: this.nowMs + delayMs, run });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  /** Delays of the timers that are waiting, soonest first. */
  pendingDelays(): number[] {
    return this.timers.map((t) => t.at - this.nowMs).sort((a, b) => a - b);
  }

  /** Runs due timers in order as time passes, letting promises settle after each one. */
  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms;
    for (;;) {
      const next = this.timers
        .filter((t) => t.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.nowMs = Math.max(this.nowMs, next.at);
      next.run();
      await settle();
    }
    this.nowMs = end;
    await settle();
  }
}

/** Lets chains of already-resolved promises and macrotask-free work run to completion. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
