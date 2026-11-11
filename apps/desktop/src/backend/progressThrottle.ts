import type { ClockPort } from "@matters/core";

/** Progress is shown, not stored: no item reports more often than four times a second. */
export const PROGRESS_INTERVAL_MS = 250;

/**
 * Lets the first report of an item through at once and then at most one per interval, per item.
 * The latest report that arrived in between is sent when the interval ends, so the last word is
 * never lost (ADR 0041, rule 5). `forget` ends an item without a trailing report.
 */
export class ProgressThrottle<V> {
  private readonly clock: ClockPort;
  private readonly emit: (key: string, value: V) => void;
  private readonly intervalMs: number;
  private readonly items = new Map<
    string,
    { lastMs: number; pending: { value: V } | null; cancel: (() => void) | null }
  >();

  constructor(
    clock: ClockPort,
    emit: (key: string, value: V) => void,
    intervalMs = PROGRESS_INTERVAL_MS,
  ) {
    this.clock = clock;
    this.emit = emit;
    this.intervalMs = intervalMs;
  }

  report(key: string, value: V): void {
    const now = this.clock.now();
    let item = this.items.get(key);
    if (!item) {
      this.prune(now);
      item = { lastMs: Number.NEGATIVE_INFINITY, pending: null, cancel: null };
      this.items.set(key, item);
    }
    const due = item.lastMs + this.intervalMs;
    if (now >= due) {
      item.cancel?.();
      item.cancel = null;
      item.pending = null;
      item.lastMs = now;
      this.emit(key, value);
      return;
    }
    item.pending = { value };
    if (item.cancel) return;
    const state = item;
    item.cancel = this.clock.setTimeout(() => {
      state.cancel = null;
      const pending = state.pending;
      state.pending = null;
      if (!pending) return;
      state.lastMs = this.clock.now();
      this.emit(key, pending.value);
    }, due - now);
  }

  forget(key: string): void {
    this.items.get(key)?.cancel?.();
    this.items.delete(key);
  }

  /** Items that ended without anyone calling `forget` (a failed copy) do not pile up. */
  private prune(now: number): void {
    if (this.items.size < 64) return;
    for (const [key, item] of this.items) {
      if (!item.cancel && now - item.lastMs > 10 * this.intervalMs) this.items.delete(key);
    }
  }
}
