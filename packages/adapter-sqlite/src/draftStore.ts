import type { Draft, DraftContent, DraftStorePort } from "@matters/core";
import { type Database, exclusive } from "./database.ts";

interface Row {
  id: string;
  account_id: string;
  thread_id: string | null;
  content_json: string;
  version: number;
  fingerprint: string;
  updated_at_ms: number;
}

function toDraft(row: Row): Draft {
  const content = JSON.parse(row.content_json) as DraftContent;
  return {
    ...content,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    id: row.id,
    version: row.version,
    fingerprint: row.fingerprint,
    updatedAtMs: row.updated_at_ms,
  };
}

export class SqliteDraftStore implements DraftStorePort {
  private readonly db: Database;
  private readonly selectOne;
  private readonly selectAll;
  private readonly byThread;
  private readonly upsert;
  private readonly remove;
  private readonly discard;

  constructor(db: Database) {
    this.db = db;
    this.selectOne = db.prepare("SELECT * FROM drafts WHERE id = ?");
    this.selectAll = db.prepare("SELECT * FROM drafts ORDER BY updated_at_ms DESC, id");
    this.byThread = db.prepare(
      "SELECT * FROM drafts WHERE account_id = ? AND thread_id = ? ORDER BY updated_at_ms DESC LIMIT 1",
    );
    this.upsert = db.prepare(`
      INSERT INTO drafts (id, account_id, thread_id, content_json, version, fingerprint, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id,
        thread_id = excluded.thread_id, content_json = excluded.content_json,
        version = excluded.version, fingerprint = excluded.fingerprint,
        updated_at_ms = excluded.updated_at_ms`);
    this.remove = db.prepare("DELETE FROM drafts WHERE id = ?");
    this.discard = db.prepare("DELETE FROM drafts WHERE account_id = ?");
  }

  async get(id: string): Promise<Draft | null> {
    const row = this.selectOne.get(id) as Row | undefined;
    return row ? toDraft(row) : null;
  }

  async put(draft: Draft): Promise<void> {
    const { id, version, fingerprint, updatedAtMs, threadId, ...content } = draft;
    await exclusive(this.db, () => {
      this.upsert.run(
        id,
        draft.accountId,
        threadId ?? null,
        JSON.stringify(content),
        version,
        fingerprint,
        updatedAtMs,
      );
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await exclusive(this.db, () => this.remove.run(id));
    return Number(result.changes) > 0;
  }

  async list(): Promise<readonly Draft[]> {
    return (this.selectAll.all() as unknown as Row[]).map(toDraft);
  }

  async findByThread(accountId: string, threadId: string): Promise<Draft | null> {
    const row = this.byThread.get(accountId, threadId) as Row | undefined;
    return row ? toDraft(row) : null;
  }

  async discardAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.discard.run(accountId);
    });
  }
}
