import type { AttachmentState, AttachmentStorePort, StoredAttachment } from "@matters/core";
import { type Database, exclusive } from "./database.ts";

interface Row {
  id: string;
  draft_id: string;
  account_id: string;
  name: string;
  size: number;
  state: string;
  reason: string | null;
  sha256: string | null;
  source_path: string | null;
  source_mtime_ms: number | null;
  origin_message_key: number | null;
  origin_part_id: string | null;
  created_at_ms: number;
}

const COLUMNS =
  "id, draft_id, account_id, name, size, state, reason, sha256, source_path, source_mtime_ms, origin_message_key, origin_part_id, created_at_ms";

function toAttachment(row: Row): StoredAttachment {
  return {
    id: row.id,
    draftId: row.draft_id,
    accountId: row.account_id,
    name: row.name,
    size: row.size,
    state: row.state as AttachmentState,
    reason: row.reason,
    sha256: row.sha256,
    sourcePath: row.source_path,
    sourceMtimeMs: row.source_mtime_ms,
    origin:
      row.origin_message_key === null || row.origin_part_id === null
        ? null
        : { messageKey: row.origin_message_key, partId: row.origin_part_id },
    createdAtMs: row.created_at_ms,
  };
}

export class SqliteAttachmentStore implements AttachmentStorePort {
  private readonly db: Database;
  private readonly insert;
  private readonly selectOne;
  private readonly byDraft;
  private readonly replace;
  private readonly move;
  private readonly removeOne;
  private readonly ids;
  private readonly discard;

  constructor(db: Database) {
    this.db = db;
    this.insert = db.prepare(
      `INSERT INTO attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectOne = db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`);
    // rowid is the order the files were added in.
    this.byDraft = db.prepare(
      `SELECT ${COLUMNS} FROM attachments WHERE draft_id = ? ORDER BY rowid`,
    );
    this.replace = db.prepare(`
      UPDATE attachments SET name = ?, size = ?, state = ?, reason = ?, sha256 = ?,
        source_path = ?, source_mtime_ms = ?, origin_message_key = ?, origin_part_id = ?
      WHERE id = ?`);
    this.move = db.prepare("UPDATE attachments SET account_id = ? WHERE draft_id = ?");
    this.removeOne = db.prepare("DELETE FROM attachments WHERE id = ?");
    this.ids = db.prepare("SELECT id FROM attachments");
    this.discard = db.prepare("DELETE FROM attachments WHERE account_id = ?");
  }

  async add(a: StoredAttachment): Promise<void> {
    await exclusive(this.db, () => {
      this.insert.run(
        a.id,
        a.draftId,
        a.accountId,
        a.name,
        a.size,
        a.state,
        a.reason,
        a.sha256,
        a.sourcePath,
        a.sourceMtimeMs,
        a.origin?.messageKey ?? null,
        a.origin?.partId ?? null,
        a.createdAtMs,
      );
    });
  }

  async get(id: string): Promise<StoredAttachment | null> {
    const row = this.selectOne.get(id) as Row | undefined;
    return row ? toAttachment(row) : null;
  }

  async forDraft(draftId: string): Promise<readonly StoredAttachment[]> {
    return (this.byDraft.all(draftId) as unknown as Row[]).map(toAttachment);
  }

  async update(a: StoredAttachment): Promise<void> {
    await exclusive(this.db, () => {
      this.replace.run(
        a.name,
        a.size,
        a.state,
        a.reason,
        a.sha256,
        a.sourcePath,
        a.sourceMtimeMs,
        a.origin?.messageKey ?? null,
        a.origin?.partId ?? null,
        a.id,
      );
    });
  }

  async moveDraft(draftId: string, accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.move.run(accountId, draftId);
    });
  }

  async remove(ids: readonly string[]): Promise<void> {
    await exclusive(this.db, () => {
      for (const id of ids) this.removeOne.run(id);
    });
  }

  async listByState(states: readonly AttachmentState[]): Promise<readonly StoredAttachment[]> {
    if (states.length === 0) return [];
    const marks = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM attachments WHERE state IN (${marks}) ORDER BY rowid`)
      .all(...states) as unknown as Row[];
    return rows.map(toAttachment);
  }

  async allIds(): Promise<readonly string[]> {
    return (this.ids.all() as unknown as { id: string }[]).map((r) => r.id);
  }

  async discardAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.discard.run(accountId);
    });
  }
}
