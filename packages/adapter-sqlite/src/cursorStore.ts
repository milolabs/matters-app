import type { CursorPort, SyncCursor } from "@matters/core";
import { type Database, exclusive } from "./database.ts";

export class SqliteCursorStore implements CursorPort {
  private readonly db: Database;
  private readonly select;
  private readonly upsert;
  private readonly removeAccount;

  constructor(db: Database) {
    this.db = db;
    this.select = db.prepare(
      "SELECT cursor_json FROM cursors WHERE account_id = ? AND folder_id = ?",
    );
    this.upsert = db.prepare(`
      INSERT INTO cursors (account_id, folder_id, cursor_json) VALUES (?, ?, ?)
      ON CONFLICT (account_id, folder_id) DO UPDATE SET cursor_json = excluded.cursor_json`);
    this.removeAccount = db.prepare("DELETE FROM cursors WHERE account_id = ?");
  }

  async get(accountId: string, folderId: string): Promise<SyncCursor | null> {
    const row = this.select.get(accountId, folderId) as { cursor_json: string } | undefined;
    return row ? (JSON.parse(row.cursor_json) as SyncCursor) : null;
  }

  async set(accountId: string, folderId: string, cursor: SyncCursor): Promise<void> {
    await exclusive(this.db, () => {
      this.upsert.run(accountId, folderId, JSON.stringify(cursor));
    });
  }

  async deleteAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.removeAccount.run(accountId);
    });
  }
}
