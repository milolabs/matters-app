import type { StorageReport } from "@matters/contracts";
import type { StorageApi } from "./handler.ts";
import type { HeavyAnswer, HeavyRead } from "./heavyReads.ts";
import type { SyncHost } from "./syncHost.ts";

/** Wait after launch before the day's measurement, so launch and first sync go first. */
export const FIRST_SAMPLE_DELAY_MS = 2 * 60_000;
/** How often the router checks whether a day has passed since the last measurement. */
export const SAMPLE_CHECK_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

interface Reads {
  ask<R extends HeavyRead>(read: R): Promise<HeavyAnswer<R>>;
}

/**
 * Settings › Storage (ADR 0089). The read thread reads and measures; the sync worker keeps each
 * measurement and compacts. A measurement runs when asked, and on its own once a day.
 */
export class StorageService implements StorageApi {
  private readonly reads: Reads;
  private readonly host: Pick<SyncHost, "command">;
  private readonly now: () => number;
  private measuring: Promise<StorageReport> | null = null;

  constructor(reads: Reads, host: Pick<SyncHost, "command">, now: () => number = Date.now) {
    this.reads = reads;
    this.host = host;
    this.now = now;
  }

  async get(): Promise<StorageReport> {
    const { overview, samples } = await this.reads.ask({ name: "storageOverview" });
    return { ...overview, samples };
  }

  /** One at a time: a second ask while one runs gets the same answer. */
  measure(): Promise<StorageReport> {
    this.measuring ??= (async () => {
      try {
        const sample = await this.reads.ask({ name: "storageMeasure" });
        await this.host.command({ name: "recordStorageSample", sample });
        return await this.get();
      } finally {
        this.measuring = null;
      }
    })();
    return this.measuring;
  }

  compact(): Promise<{ readonly freedBytes: number; readonly ms: number }> {
    return this.host.command({ name: "compactDatabase" });
  }

  /** Empties the text the agent read from attached files (ADR 0087, rule 11). */
  clearFileText(): Promise<number> {
    return this.host.command({ name: "clearFileText" });
  }

  /** Measures when the last kept measurement is a day old or there is none. */
  async measureIfDue(): Promise<boolean> {
    const { samples } = await this.get();
    const last = samples.at(-1);
    if (last !== undefined && this.now() - last.atMs < DAY_MS) return false;
    await this.measure();
    return true;
  }

  /** The day's measurement: first after `FIRST_SAMPLE_DELAY_MS`, then checked each hour. */
  startDaily(onError: (error: unknown) => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      this.measureIfDue()
        .catch(onError)
        .finally(() => {
          timer = setTimeout(run, SAMPLE_CHECK_MS);
        });
    };
    timer = setTimeout(run, FIRST_SAMPLE_DELAY_MS);
    return () => clearTimeout(timer);
  }
}
