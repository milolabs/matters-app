import type {
  FlagOutboxPort,
  FlagResult,
  MailFlagsPort,
  MessageLocation,
  NewSeenIntent,
  SeenIntent,
} from "@matters/core";
import type { Snapshottable } from "./fakes.ts";

/** Reference semantics for `FlagOutboxPort`. */
export class InMemoryFlagOutbox implements FlagOutboxPort, Snapshottable {
  private rows = new Map<number, SeenIntent>();

  snapshot(): () => void {
    const saved = new Map(this.rows);
    return () => {
      this.rows = saved;
    };
  }

  async put(intents: readonly NewSeenIntent[]): Promise<void> {
    for (const i of intents) {
      const old = this.rows.get(i.key);
      this.rows.set(
        i.key,
        old
          ? {
              ...old,
              seen: i.seen,
              attempts: 0,
              nextAttemptMs: i.nextAttemptMs,
              rev: old.rev + 1,
            }
          : {
              key: i.key,
              accountId: i.accountId,
              seen: i.seen,
              previousSeen: i.previousSeen,
              attempts: 0,
              nextAttemptMs: i.nextAttemptMs,
              createdAtMs: i.createdAtMs,
              rev: 1,
            },
      );
    }
  }

  private sorted(rows: Iterable<SeenIntent>): SeenIntent[] {
    return [...rows].sort((a, b) => a.nextAttemptMs - b.nextAttemptMs || a.key - b.key);
  }

  async listPending(accountId?: string): Promise<readonly SeenIntent[]> {
    return this.sorted(
      [...this.rows.values()].filter((r) => accountId === undefined || r.accountId === accountId),
    );
  }

  async listDue(nowMs: number, limit: number): Promise<readonly SeenIntent[]> {
    return this.sorted([...this.rows.values()].filter((r) => r.nextAttemptMs <= nowMs)).slice(
      0,
      Math.max(0, Math.trunc(limit)),
    );
  }

  async nextDueMs(): Promise<number | null> {
    let next: number | null = null;
    for (const r of this.rows.values()) {
      if (next === null || r.nextAttemptMs < next) next = r.nextAttemptMs;
    }
    return next;
  }

  async settle(intents: readonly SeenIntent[]): Promise<readonly SeenIntent[]> {
    const deleted: SeenIntent[] = [];
    for (const i of intents) {
      const row = this.rows.get(i.key);
      if (!row || row.rev !== i.rev) continue;
      this.rows.delete(i.key);
      deleted.push(row);
    }
    return deleted;
  }

  async defer(
    entries: readonly { readonly intent: SeenIntent; readonly nextAttemptMs: number }[],
  ): Promise<void> {
    for (const { intent, nextAttemptMs } of entries) {
      const row = this.rows.get(intent.key);
      if (!row || row.rev !== intent.rev) continue;
      this.rows.set(intent.key, { ...row, attempts: row.attempts + 1, nextAttemptMs });
    }
  }

  async discardAccount(accountId: string): Promise<void> {
    for (const [key, row] of this.rows) if (row.accountId === accountId) this.rows.delete(key);
  }
}

const locationId = (l: MessageLocation): string =>
  [l.accountId, l.folderId, l.uidValidity, l.uid].join("\u0000");

/**
 * A server's flags behind `MailFlagsPort`. It records every call and remembers which copies
 * are `\Seen`; tests script refusals and failures.
 */
export class FakeMailFlags implements MailFlagsPort {
  /** One entry per call, as the adapter was asked. */
  readonly calls: { locations: readonly MessageLocation[]; seen: boolean }[] = [];
  /** Copies the server holds as `\Seen`, by location. */
  readonly seenAt = new Set<string>();
  /** Folders whose copies the server refuses to change. */
  readonly rejectFolders = new Set<string>();
  /** UIDVALIDITY the server has per folder; a location with another one is stale. */
  readonly uidValidity = new Map<string, string>();
  /** Errors thrown by the next calls, one each. */
  readonly failures: unknown[] = [];

  has(location: MessageLocation): boolean {
    return this.seenAt.has(locationId(location));
  }

  async setSeen(
    locations: readonly MessageLocation[],
    seen: boolean,
  ): Promise<readonly FlagResult[]> {
    this.calls.push({ locations, seen });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return locations.map((location): FlagResult => {
      const validity = this.uidValidity.get(location.folderId);
      if (validity !== undefined && validity !== location.uidValidity) {
        return { location, outcome: "stale" };
      }
      if (this.rejectFolders.has(location.folderId)) return { location, outcome: "rejected" };
      if (seen) this.seenAt.add(locationId(location));
      else this.seenAt.delete(locationId(location));
      return { location, outcome: "done" };
    });
  }
}
