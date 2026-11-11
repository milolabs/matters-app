/** A path main saw with its own eyes, and what it learned about the file (ADR 0041, rule 3). */
export interface Grant {
  readonly grantId: string;
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

/** A request named a grant that does not exist, was used already or has expired. */
export class UnknownGrantError extends Error {
  constructor() {
    super("That file is no longer available to attach. Add it again.");
    this.name = "UnknownGrantError";
  }
}

export interface GrantBookOptions {
  /** A grant that arrives later than the request naming it is waited for this long. Default 1 s. */
  readonly waitMs?: number;
  /** A grant nobody used is dropped after this long. Default 10 minutes. */
  readonly ttlMs?: number;
  /** At most this many unused grants at once; the oldest go first. Default 1000. */
  readonly max?: number;
  readonly now?: () => number;
  /** A grant ended (used, expired or pushed out): main may delete a temporary file behind it. */
  readonly onEnd?: (grantId: string) => void;
}

/**
 * The grants the router holds (ADR 0041, rule 3). Main sends `grant`s over its own port, the page
 * sends only their ids, and `takeAll` turns ids into paths. A grant works once: it is deleted by
 * the call that uses it, and an id that was used or never existed is refused. A grant comes over
 * a different channel than the request that names it, so it may arrive a moment late.
 */
export class GrantBook {
  private readonly grants = new Map<string, { grant: Grant; atMs: number }>();
  /** Ids already spent, so a reuse is refused at once instead of after the wait. */
  private readonly spent = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly options: Required<Omit<GrantBookOptions, "onEnd">> &
    Pick<GrantBookOptions, "onEnd">;

  constructor(options: GrantBookOptions = {}) {
    this.options = {
      waitMs: options.waitMs ?? 1000,
      ttlMs: options.ttlMs ?? 10 * 60_000,
      max: options.max ?? 1000,
      now: options.now ?? Date.now,
      ...(options.onEnd ? { onEnd: options.onEnd } : {}),
    };
  }

  put(grant: Grant): void {
    if (grant.grantId === "" || grant.path === "") return;
    this.expire();
    if (this.grants.has(grant.grantId) || this.spent.has(grant.grantId)) return;
    this.grants.set(grant.grantId, { grant, atMs: this.options.now() });
    while (this.grants.size > this.options.max) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * The grants for these ids, in order, all or none: an id that is unknown, spent, repeated or
   * still missing after the wait refuses the whole request and spends nothing.
   */
  async takeAll(ids: readonly string[]): Promise<readonly Grant[] | null> {
    if (new Set(ids).size !== ids.length || ids.some((id) => this.spent.has(id))) return null;
    const deadline = this.options.now() + this.options.waitMs;
    for (;;) {
      this.expire();
      const found = ids.map((id) => this.grants.get(id));
      if (found.every((f) => f !== undefined)) {
        const taken = found.map((f) => (f as { grant: Grant }).grant);
        for (const id of ids) {
          this.grants.delete(id);
          this.remember(id);
        }
        return taken;
      }
      const left = deadline - this.options.now();
      if (left <= 0) return null;
      await this.nextPut(left);
    }
  }

  /** The copy a grant was for ended: main can delete a temporary file. */
  end(grantId: string): void {
    this.options.onEnd?.(grantId);
  }

  /** Drops what nobody used in time. Called on every `put` and `takeAll`, and by a timer. */
  expire(): void {
    const limit = this.options.now() - this.options.ttlMs;
    for (const [id, entry] of this.grants) {
      if (entry.atMs <= limit) this.drop(id);
    }
  }

  get size(): number {
    return this.grants.size;
  }

  private drop(id: string): void {
    this.grants.delete(id);
    this.remember(id);
    this.options.onEnd?.(id);
  }

  private remember(id: string): void {
    this.spent.add(id);
    if (this.spent.size > 5000) {
      const first = this.spent.values().next().value;
      if (first !== undefined) this.spent.delete(first);
    }
  }

  private nextPut(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, maxMs);
      this.waiters.add(done);
    });
  }
}
