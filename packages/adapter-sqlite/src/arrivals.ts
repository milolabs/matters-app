// What arrived, by the order the server gave it (ADR 0106, rule 1). The marks come from the sync
// cursors: the IMAP sync keeps the folder's UIDVALIDITY and the highest UID it stored there, and
// commits them with the mail they cover. The spans are ranges of the locations' primary key.
import type { ArrivalMark, ArrivalPort, ArrivalSpan } from "@matters/core";
import type { Database } from "./database.ts";

/** Bit 0 of `messages.flags` is \Seen (messageStore.ts). */
const SEEN = 1;

function uidOf(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export class SqliteArrivals implements ArrivalPort {
  private readonly selectCursors;
  private readonly selectSpan;

  constructor(db: Database) {
    this.selectCursors = db.prepare("SELECT account_id, folder_id, cursor_json FROM cursors");
    this.selectSpan = db.prepare(`
      SELECT l.message_key AS key
        FROM message_locations l JOIN messages m ON m.key = l.message_key
       WHERE l.account_id = ? AND l.folder_id = ? AND l.uid_validity = ?
         AND l.uid > ? AND l.uid <= ? AND (m.flags & ${SEEN}) = 0
       ORDER BY l.uid DESC
       LIMIT ?`);
  }

  async marks(): Promise<readonly ArrivalMark[]> {
    const rows = this.selectCursors.all() as {
      account_id: string;
      folder_id: string;
      cursor_json: string;
    }[];
    const out: ArrivalMark[] = [];
    for (const row of rows) {
      let cursor: Record<string, unknown>;
      try {
        cursor = JSON.parse(row.cursor_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const uid = uidOf(cursor?.lastUid);
      const uidValidity = cursor?.uidValidity;
      if (uid === null || typeof uidValidity !== "string" || uidValidity === "") continue;
      out.push({ accountId: row.account_id, folderId: row.folder_id, uidValidity, uid });
    }
    return out;
  }

  async unreadIn(spans: readonly ArrivalSpan[], limit: number): Promise<readonly number[]> {
    const keys = new Set<number>();
    for (const s of spans) {
      const rows = this.selectSpan.all(
        s.accountId,
        s.folderId,
        s.uidValidity,
        s.afterUid,
        s.upToUid,
        limit,
      ) as { key: number }[];
      for (const r of rows) keys.add(r.key);
    }
    return [...keys].sort((a, b) => b - a).slice(0, limit);
  }
}
