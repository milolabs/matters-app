import {
  FILE_SUBSTRING_MIN,
  type FileHit,
  fileNameMatches,
  fileNameWords,
  foldFileName,
  HIDDEN_MAILBOXES,
  type Participant,
} from "@matters/core";
import type { Database } from "./database.ts";

/**
 * ADR 0074. Two small indexes over the names of the files of a message (non-inline parts of
 * `message_attachments`), both keyed by the message:
 *
 * - `file_fts`: FTS5 with the trigram tokenizer, contentless, one row per message whose rowid is
 *   the message key. The row holds the folded names joined by a newline, which a query never
 *   contains, so a match never straddles two names. Reading it by `rowid DESC` yields the newest
 *   message first, one row at a time.
 * - `file_starts`: the first one and two characters of every word of every name. It answers the
 *   texts of one or two characters, which have no trigram.
 *
 * Deleting a message removes both through a trigger; `setAttachments` rewrites them.
 */

/** Messages a search looks at before it gives up on filling its limit with distinct files. */
const SCAN_LIMIT = 2000;
const NAME_SEPARATOR = "\n";

/** The one- and two-character starts of every word of the names, each once. */
export function fileStarts(foldedNames: readonly string[]): string[] {
  const starts = new Set<string>();
  for (const name of foldedNames) {
    for (const word of fileNameWords(name)) {
      const chars = [...word];
      starts.add(chars[0] as string);
      if (chars.length > 1) starts.add(chars.slice(0, 2).join(""));
    }
  }
  return [...starts];
}

export interface FileIndexWriter {
  /** Replaces what the index holds for a message by its (non-inline) file names. */
  set(messageKey: number, names: readonly string[]): void;
}

export function fileIndexWriter(db: Database): FileIndexWriter {
  // Prepared on first use: a store opened on a schema from before migration 37 (the upgrade
  // tests) must be constructible, and never writes files there.
  let statements:
    | {
        deleteNames: ReturnType<Database["prepare"]>;
        insertNames: ReturnType<Database["prepare"]>;
        deleteStarts: ReturnType<Database["prepare"]>;
        insertStart: ReturnType<Database["prepare"]>;
      }
    | undefined;
  return {
    set(messageKey, names) {
      statements ??= {
        deleteNames: db.prepare("DELETE FROM file_fts WHERE rowid = ?"),
        insertNames: db.prepare("INSERT INTO file_fts (rowid, names) VALUES (?, ?)"),
        deleteStarts: db.prepare("DELETE FROM file_starts WHERE message_key = ?"),
        insertStart: db.prepare(
          "INSERT OR IGNORE INTO file_starts (prefix, message_key) VALUES (?, ?)",
        ),
      };
      const { deleteNames, insertNames, deleteStarts, insertStart } = statements;
      deleteNames.run(messageKey);
      deleteStarts.run(messageKey);
      const folded = names.map(foldFileName).filter((n) => n !== "");
      if (folded.length === 0) return;
      insertNames.run(messageKey, folded.join(NAME_SEPARATOR));
      for (const start of fileStarts(folded)) insertStart.run(start, messageKey);
    },
  };
}

/** Migration 37: the index of every file already stored, message by message in key order. */
export function backfillFileIndex(db: Database): void {
  const writer = fileIndexWriter(db);
  const rows = db
    .prepare(
      "SELECT message_key, name FROM message_attachments WHERE inline = 0 ORDER BY message_key, position",
    )
    .iterate() as Iterable<{ message_key: number; name: string }>;
  let key: number | null = null;
  let names: string[] = [];
  for (const row of rows) {
    if (row.message_key !== key) {
      if (key !== null) writer.set(key, names);
      key = row.message_key;
      names = [];
    }
    names.push(row.name);
  }
  if (key !== null) writer.set(key, names);
}

interface CandidateRow {
  part_id: string;
  name: string;
  mime_type: string;
  size: number;
  thread_id: string;
  account_id: string;
  from_json: string;
  date_ms: number;
  mailboxes: number;
}

/** The read side. Statements are prepared on first use, on the connection it is given. */
export class FileSearch {
  private readonly db: Database;
  private byTrigram: ReturnType<Database["prepare"]> | undefined;
  private byStart: ReturnType<Database["prepare"]> | undefined;
  private candidate: ReturnType<Database["prepare"]> | undefined;

  constructor(db: Database) {
    this.db = db;
  }

  search(text: string, limit: number, accountId?: string): readonly FileHit[] {
    const query = foldFileName(text);
    const want = Math.max(0, Math.trunc(limit));
    if (query === "" || want === 0) return [];
    const short = [...query].length < FILE_SUBSTRING_MIN;
    let keys: Iterable<{ key: number }>;
    if (short) {
      // A text with a separator in it matches nothing this short, as `fileNameMatches` says.
      if (!fileNameMatches(query, query)) return [];
      this.byStart ??= this.db.prepare(
        "SELECT message_key AS key FROM file_starts WHERE prefix = ? ORDER BY message_key DESC",
      );
      keys = this.byStart.iterate(query) as Iterable<{ key: number }>;
    } else {
      this.byTrigram ??= this.db.prepare(
        "SELECT rowid AS key FROM file_fts WHERE file_fts MATCH ? ORDER BY rowid DESC",
      );
      // A quoted phrase carries no FTS syntax; a quote inside it is doubled.
      keys = this.byTrigram.iterate(`"${query.replaceAll('"', '""')}"`) as Iterable<{
        key: number;
      }>;
    }
    this.candidate ??= this.db.prepare(
      `SELECT a.part_id, a.name, a.mime_type, a.size, m.thread_id, m.account_id, m.from_json,
              m.date_ms, m.mailboxes
         FROM messages m JOIN message_attachments a ON a.message_key = m.key
        WHERE m.key = ? AND a.inline = 0 ORDER BY a.position`,
    );
    const hits: FileHit[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    for (const { key } of keys) {
      if (++scanned > SCAN_LIMIT) break;
      for (const r of this.candidate.all(key) as unknown as CandidateRow[]) {
        if ((r.mailboxes & HIDDEN_MAILBOXES) !== 0) break;
        if (accountId !== undefined && r.account_id !== accountId) break;
        const folded = foldFileName(r.name);
        if (!fileNameMatches(folded, query)) continue;
        const same = `${r.thread_id}\u0000${folded}`;
        if (seen.has(same)) continue;
        seen.add(same);
        hits.push({
          messageKey: key,
          partId: r.part_id,
          fileName: r.name,
          sizeBytes: r.size,
          contentType: r.mime_type,
          threadId: r.thread_id,
          accountId: r.account_id,
          sender: JSON.parse(r.from_json) as Participant,
          dateMs: r.date_ms,
        });
        if (hits.length >= want) return hits;
      }
    }
    return hits;
  }
}
