import type { MoveKind, MoveOperation, MoveOutboxPort, NewMoveOperation } from "@matters/core";
import { type Database, exclusive, write } from "./database.ts";

interface Row {
  message_key: number;
  account_id: string;
  operation_id: string;
  action: string;
  target: string;
  labels_before_json: string;
  mailboxes_before: number;
  attempts: number;
  next_attempt_ms: number;
  created_at_ms: number;
  rev: number;
}

function toOperation(row: Row): MoveOperation {
  return {
    key: row.message_key,
    accountId: row.account_id,
    operationId: row.operation_id,
    action: row.action as MoveKind,
    target: row.target,
    labelsBefore: JSON.parse(row.labels_before_json) as string[],
    mailboxesBefore: row.mailboxes_before,
    attempts: row.attempts,
    nextAttemptMs: row.next_attempt_ms,
    createdAtMs: row.created_at_ms,
    rev: row.rev,
  };
}

const ORDER = "ORDER BY next_attempt_ms, message_key";

/** ADR 0044. One row per message; a replacement keeps the "before" and bumps `rev`. */
export class SqliteMoveOutbox implements MoveOutboxPort {
  private readonly db: Database;
  private readonly upsert;
  private readonly selectAll;
  private readonly selectAccount;
  private readonly selectDue;
  private readonly selectNext;
  private readonly selectOne;
  private readonly selectOperation;
  private readonly deleteAt;
  private readonly deleteOne;
  private readonly deferAt;
  private readonly deleteAccount;

  constructor(db: Database) {
    this.db = db;
    this.upsert = db.prepare(`
      INSERT INTO move_operations (message_key, account_id, operation_id, action, target,
                                   labels_before_json, mailboxes_before, attempts,
                                   next_attempt_ms, created_at_ms, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)
      ON CONFLICT (message_key) DO UPDATE SET operation_id = excluded.operation_id,
        action = excluded.action, target = excluded.target, attempts = 0,
        next_attempt_ms = excluded.next_attempt_ms, rev = rev + 1`);
    this.selectAll = db.prepare(`SELECT * FROM move_operations ${ORDER}`);
    this.selectAccount = db.prepare(`SELECT * FROM move_operations WHERE account_id = ? ${ORDER}`);
    this.selectDue = db.prepare(
      `SELECT * FROM move_operations WHERE next_attempt_ms <= ? ${ORDER} LIMIT ?`,
    );
    this.selectNext = db.prepare("SELECT MIN(next_attempt_ms) AS t FROM move_operations");
    this.selectOne = db.prepare("SELECT * FROM move_operations WHERE message_key = ? AND rev = ?");
    this.selectOperation = db.prepare(
      `SELECT * FROM move_operations WHERE operation_id = ? ${ORDER}`,
    );
    this.deleteAt = db.prepare("DELETE FROM move_operations WHERE message_key = ? AND rev = ?");
    this.deleteOne = db.prepare("DELETE FROM move_operations WHERE message_key = ?");
    this.deferAt = db.prepare(
      "UPDATE move_operations SET attempts = attempts + 1, next_attempt_ms = ? WHERE message_key = ? AND rev = ?",
    );
    this.deleteAccount = db.prepare("DELETE FROM move_operations WHERE account_id = ?");
  }

  async put(operations: readonly NewMoveOperation[]): Promise<void> {
    if (operations.length === 0) return;
    await write(this.db, () => {
      for (const o of operations) {
        this.upsert.run(
          o.key,
          o.accountId,
          o.operationId,
          o.action,
          o.target,
          JSON.stringify(o.labelsBefore),
          o.mailboxesBefore,
          o.nextAttemptMs,
          o.createdAtMs,
        );
      }
    });
  }

  async listPending(accountId?: string): Promise<readonly MoveOperation[]> {
    const rows = (accountId === undefined
      ? this.selectAll.all()
      : this.selectAccount.all(accountId)) as unknown as Row[];
    return rows.map(toOperation);
  }

  async listDue(nowMs: number, limit: number): Promise<readonly MoveOperation[]> {
    return (this.selectDue.all(nowMs, Math.max(0, Math.trunc(limit))) as unknown as Row[]).map(
      toOperation,
    );
  }

  async nextDueMs(): Promise<number | null> {
    return (this.selectNext.get() as { t: number | null }).t;
  }

  async cancel(
    operationId: string,
    nowMs: number,
  ): Promise<{ readonly removed: readonly MoveOperation[]; readonly late: boolean }> {
    return write(this.db, () => {
      const mine = (this.selectOperation.all(operationId) as unknown as Row[]).map(toOperation);
      // One row past its window or tried already and the whole action is on its way.
      if (mine.some((o) => o.nextAttemptMs <= nowMs || o.attempts > 0)) {
        return { removed: [], late: true };
      }
      for (const o of mine) this.deleteOne.run(o.key);
      return { removed: mine, late: false };
    });
  }

  async settle(operations: readonly MoveOperation[]): Promise<readonly MoveOperation[]> {
    if (operations.length === 0) return [];
    return write(this.db, () => {
      const deleted: MoveOperation[] = [];
      for (const o of operations) {
        const row = this.selectOne.get(o.key, o.rev) as Row | undefined;
        if (!row) continue;
        this.deleteAt.run(o.key, o.rev);
        deleted.push(toOperation(row));
      }
      return deleted;
    });
  }

  async defer(
    entries: readonly { readonly operation: MoveOperation; readonly nextAttemptMs: number }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await write(this.db, () => {
      for (const { operation, nextAttemptMs } of entries) {
        this.deferAt.run(nextAttemptMs, operation.key, operation.rev);
      }
    });
  }

  async discardAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.deleteAccount.run(accountId);
    });
  }
}
