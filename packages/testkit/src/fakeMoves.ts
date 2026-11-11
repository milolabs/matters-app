import type {
  ExpungeResult,
  MailMovePort,
  MessageLocation,
  MoveAction,
  MoveOperation,
  MoveOutboxPort,
  MoveResult,
  MoveTarget,
  NewMoveOperation,
} from "@matters/core";
import type { Snapshottable } from "./fakes.ts";

/** Reference semantics for `MoveOutboxPort`. */
export class InMemoryMoveOutbox implements MoveOutboxPort, Snapshottable {
  private rows = new Map<number, MoveOperation>();

  snapshot(): () => void {
    const saved = new Map(this.rows);
    return () => {
      this.rows = saved;
    };
  }

  async put(operations: readonly NewMoveOperation[]): Promise<void> {
    for (const o of operations) {
      const old = this.rows.get(o.key);
      this.rows.set(
        o.key,
        old
          ? {
              ...old,
              operationId: o.operationId,
              action: o.action,
              target: o.target,
              attempts: 0,
              nextAttemptMs: o.nextAttemptMs,
              rev: old.rev + 1,
            }
          : { ...o, attempts: 0, rev: 1 },
      );
    }
  }

  private sorted(rows: Iterable<MoveOperation>): MoveOperation[] {
    return [...rows].sort((a, b) => a.nextAttemptMs - b.nextAttemptMs || a.key - b.key);
  }

  async listPending(accountId?: string): Promise<readonly MoveOperation[]> {
    return this.sorted(
      [...this.rows.values()].filter((r) => accountId === undefined || r.accountId === accountId),
    );
  }

  async listDue(nowMs: number, limit: number): Promise<readonly MoveOperation[]> {
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

  async cancel(
    operationId: string,
    nowMs: number,
  ): Promise<{ readonly removed: readonly MoveOperation[]; readonly late: boolean }> {
    const mine = [...this.rows.values()].filter((r) => r.operationId === operationId);
    if (mine.some((r) => r.nextAttemptMs <= nowMs || r.attempts > 0)) {
      return { removed: [], late: true };
    }
    for (const r of mine) this.rows.delete(r.key);
    return { removed: this.sorted(mine), late: false };
  }

  async settle(operations: readonly MoveOperation[]): Promise<readonly MoveOperation[]> {
    const deleted: MoveOperation[] = [];
    for (const o of operations) {
      const row = this.rows.get(o.key);
      if (!row || row.rev !== o.rev) continue;
      this.rows.delete(o.key);
      deleted.push(row);
    }
    return deleted;
  }

  async defer(
    entries: readonly { readonly operation: MoveOperation; readonly nextAttemptMs: number }[],
  ): Promise<void> {
    for (const { operation, nextAttemptMs } of entries) {
      const row = this.rows.get(operation.key);
      if (!row || row.rev !== operation.rev) continue;
      this.rows.set(operation.key, { ...row, attempts: row.attempts + 1, nextAttemptMs });
    }
  }

  async discardAccount(accountId: string): Promise<void> {
    for (const [key, row] of this.rows) if (row.accountId === accountId) this.rows.delete(key);
  }
}

const locationId = (l: MessageLocation): string =>
  [l.accountId, l.folderId, l.uidValidity, l.uid].join("\u0000");

/**
 * A server's moves behind `MailMovePort`. It records every call; tests script refusals, stale
 * copies and failures, and say whether the server answers with the new UID (`uidMap`).
 */
export class FakeMailMoves implements MailMovePort {
  readonly moveCalls: {
    locations: readonly MessageLocation[];
    action: MoveAction;
    target: MoveTarget;
  }[] = [];
  readonly expungeCalls: { locations: readonly MessageLocation[] }[] = [];
  /** The copies the server has deleted for good, by location. */
  readonly expunged = new Set<string>();
  /** Where the server says a copy went, and the UIDs it hands out. */
  nextUid = 5000;
  /** Without UIDPLUS the server cannot say where a copy went (ADR 0044, rule 13). */
  uidMap = true;
  /** The folder each role is on this server. */
  readonly roleFolders: Record<"inbox" | "archive" | "trash" | "spam", string> = {
    inbox: "INBOX",
    archive: "Archive",
    trash: "Trash",
    spam: "Junk",
  };
  /** The folder a target stands for on this server. */
  readonly folderOf = (target: MoveTarget): string =>
    "folderId" in target ? target.folderId : this.roleFolders[target.role];
  /** Folders whose copies the server refuses to change or delete. */
  readonly rejectFolders = new Set<string>();
  /** The folders that are the account's Trash; `expunge` anywhere else is refused. */
  readonly trashFolders = new Set<string>(["Trash"]);
  /** UIDVALIDITY the server has per folder; a location with another one is stale. */
  readonly uidValidity = new Map<string, string>();
  /** Errors thrown by the next calls, one each. */
  readonly failures: unknown[] = [];

  async move(
    locations: readonly MessageLocation[],
    action: MoveAction,
    target: MoveTarget,
  ): Promise<readonly MoveResult[]> {
    this.moveCalls.push({ locations, action, target });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const folder = this.folderOf(target);
    return locations.map((location): MoveResult => {
      const validity = this.uidValidity.get(location.folderId);
      if (validity !== undefined && validity !== location.uidValidity) {
        return { location, outcome: { kind: "stale" } };
      }
      if (this.rejectFolders.has(location.folderId) || this.rejectFolders.has(folder)) {
        return { location, outcome: { kind: "rejected" } };
      }
      if (this.expunged.has(locationId(location))) {
        return { location, outcome: { kind: "stale" } };
      }
      this.expunged.add(locationId(location));
      if (!this.uidMap) return { location, outcome: { kind: "moved" } };
      const to: MessageLocation = {
        accountId: location.accountId,
        folderId: folder,
        uidValidity: this.uidValidity.get(folder) ?? "1",
        uid: this.nextUid++,
      };
      return { location, outcome: { kind: "moved", location: to } };
    });
  }

  async expunge(locations: readonly MessageLocation[]): Promise<readonly ExpungeResult[]> {
    this.expungeCalls.push({ locations });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return locations.map((location): ExpungeResult => {
      const validity = this.uidValidity.get(location.folderId);
      if (validity !== undefined && validity !== location.uidValidity) {
        return { location, outcome: "stale" };
      }
      if (!this.trashFolders.has(location.folderId) || this.rejectFolders.has(location.folderId)) {
        return { location, outcome: "rejected" };
      }
      this.expunged.add(locationId(location));
      return { location, outcome: "done" };
    });
  }
}
