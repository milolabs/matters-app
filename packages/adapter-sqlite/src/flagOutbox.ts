import type { FlagOutboxPort, NewSeenIntent, SeenIntent } from "@matters/core";
import { type Database, exclusive, write } from "./database.ts";

interface Row {
  message_key: number;
  account_id: string;
  seen: number;
  previous_seen: number;
  attempts: number;
  next_attempt_ms: number;
  created_at_ms: number;
  rev: number;
}

function toIntent(row: Row): SeenIntent {
  return {
    key: row.message_key,
    accountId: row.account_id,
    seen: row.seen !== 0,
    previousSeen: row.previous_seen !== 0,
    attempts: row.attempts,
    nextAttemptMs: row.next_attempt_ms,
    createdAtMs: row.created_at_ms,
    rev: row.rev,
  };
}

/** ADR 0039. One row per message; a replacement keeps `previous_seen` and bumps `rev`. */
export class SqliteFlagOutbox implements FlagOutboxPort {
  private readonly db: Database;
  private readonly upsert;
  private readonly selectAll;
  private readonly selectAccount;
  private readonly selectDue;
  private readonly selectNext;
  private readonly selectOne;
  private readonly deleteAt;
  private readonly deferAt;
  private readonly deleteAccount;

  constructor(db: Database) {
    this.db = db;
    this.upsert = db.prepare(`
      INSERT INTO flag_operations (message_key, account_id, seen, previous_seen, attempts,
                                   next_attempt_ms, created_at_ms, rev)
      VALUES (?, ?, ?, ?, 0, ?, ?, 1)
      ON CONFLICT (message_key) DO UPDATE SET seen = excluded.seen, attempts = 0,
        next_attempt_ms = excluded.next_attempt_ms, rev = rev + 1`);
    this.selectAll = db.prepare(
      "SELECT * FROM flag_operations ORDER BY next_attempt_ms, message_key",
    );
    this.selectAccount = db.prepare(
      "SELECT * FROM flag_operations WHERE account_id = ? ORDER BY next_attempt_ms, message_key",
    );
    this.selectDue = db.prepare(
      "SELECT * FROM flag_operations WHERE next_attempt_ms <= ? ORDER BY next_attempt_ms, message_key LIMIT ?",
    );
    this.selectNext = db.prepare("SELECT MIN(next_attempt_ms) AS t FROM flag_operations");
    this.selectOne = db.prepare("SELECT * FROM flag_operations WHERE message_key = ? AND rev = ?");
    this.deleteAt = db.prepare("DELETE FROM flag_operations WHERE message_key = ? AND rev = ?");
    this.deferAt = db.prepare(
      "UPDATE flag_operations SET attempts = attempts + 1, next_attempt_ms = ? WHERE message_key = ? AND rev = ?",
    );
    this.deleteAccount = db.prepare("DELETE FROM flag_operations WHERE account_id = ?");
  }

  async put(intents: readonly NewSeenIntent[]): Promise<void> {
    if (intents.length === 0) return;
    await write(this.db, () => {
      for (const i of intents) {
        this.upsert.run(
          i.key,
          i.accountId,
          i.seen ? 1 : 0,
          i.previousSeen ? 1 : 0,
          i.nextAttemptMs,
          i.createdAtMs,
        );
      }
    });
  }

  async listPending(accountId?: string): Promise<readonly SeenIntent[]> {
    const rows = (accountId === undefined
      ? this.selectAll.all()
      : this.selectAccount.all(accountId)) as unknown as Row[];
    return rows.map(toIntent);
  }

  async listDue(nowMs: number, limit: number): Promise<readonly SeenIntent[]> {
    return (this.selectDue.all(nowMs, Math.max(0, Math.trunc(limit))) as unknown as Row[]).map(
      toIntent,
    );
  }

  async nextDueMs(): Promise<number | null> {
    return (this.selectNext.get() as { t: number | null }).t;
  }

  async settle(intents: readonly SeenIntent[]): Promise<readonly SeenIntent[]> {
    if (intents.length === 0) return [];
    return write(this.db, () => {
      const deleted: SeenIntent[] = [];
      for (const i of intents) {
        const row = this.selectOne.get(i.key, i.rev) as Row | undefined;
        if (!row) continue;
        this.deleteAt.run(i.key, i.rev);
        deleted.push(toIntent(row));
      }
      return deleted;
    });
  }

  async defer(
    entries: readonly { readonly intent: SeenIntent; readonly nextAttemptMs: number }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await write(this.db, () => {
      for (const { intent, nextAttemptMs } of entries) {
        this.deferAt.run(nextAttemptMs, intent.key, intent.rev);
      }
    });
  }

  async discardAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.deleteAccount.run(accountId);
    });
  }
}
