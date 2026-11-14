import type { HoldingGroup } from "@matters/core";
import { type Database, exclusive, write } from "./database.ts";
import { measureTableGroups } from "./holdings.ts";

/** The database's part of the erase review (ADR 0138, rule 9). */
export interface EraseMeasure {
  readonly groups: Readonly<Record<HoldingGroup, number>>;
  readonly accounts: number;
  readonly messages: number;
  /** Messages waiting to be sent, which an erase drops (rule 10). */
  readonly unsent: number;
}

/** What the database's pages hold, grouped the way Settings shows them (ADR 0089). */
export interface DatabaseParts {
  /** Message FTS, its vocabulary, people and file names: what search reads. */
  readonly searchBytes: number;
  /** Messages as sent (ADR 0024, 0088). */
  readonly htmlBytes: number;
  /** Text of messages (ADR 0009). */
  readonly textBytes: number;
  /** Text the agent read from attached files (ADR 0087). */
  readonly filesTextBytes: number;
  /** Everything else: messages, headers, labels, locations, agents, drafts. */
  readonly mailBytes: number;
  /** Pages no table uses (`freelist_count`). */
  readonly freeBytes: number;
}

/** One measurement, as kept in `storage_samples`. */
export interface StorageSample extends DatabaseParts {
  readonly atMs: number;
  readonly messages: number;
  /** The database file, `page_count` times `page_size`. */
  readonly fileBytes: number;
}

/** The numbers that cost little: read each time Settings opens the section. */
export interface StorageOverview {
  readonly messages: number;
  readonly accounts: readonly { readonly accountId: string; readonly messages: number }[];
  readonly fileBytes: number;
  readonly freeBytes: number;
  /** Files whose text the agent read and kept (ADR 0087). */
  readonly filesRead: number;
  /** Messages whose HTML still waits for ADR 0088's move; `listing` while it lists them. */
  readonly repack: { readonly left: number; readonly listing: boolean };
}

/** Rows `storage_samples` keeps; older ones go (ADR 0089, rule 4). */
export const STORAGE_SAMPLE_LIMIT = 400;
const DAY_MS = 86_400_000;

const SEARCH = /^(message_fts|message_terms|people|file_fts|file_starts)/;
const HTML = /^html_/;
const TEXT = /^body_/;
const FILES_TEXT = /^attachment_text/;

/** The group of a table's pages, by the table's name. */
export function partOf(table: string): Exclude<keyof DatabaseParts, "freeBytes"> {
  if (SEARCH.test(table)) return "searchBytes";
  if (HTML.test(table)) return "htmlBytes";
  if (TEXT.test(table)) return "textBytes";
  if (FILES_TEXT.test(table)) return "filesTextBytes";
  return "mailBytes";
}

function pragma(db: Database, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return Object.values(row)[0] ?? 0;
}

/** Reads only: safe on the read-only connection of the read thread. */
export class SqliteStorageUsage {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  overview(): StorageOverview {
    const pageSize = pragma(this.db, "page_size");
    const accounts = this.db
      .prepare(
        "SELECT account_id AS accountId, COUNT(*) AS messages FROM messages GROUP BY account_id",
      )
      .all() as unknown as { accountId: string; messages: number }[];
    const repack = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM html_repack) AS left,
                (SELECT fill_from IS NOT NULL FROM html_repack_state) AS listing`,
      )
      .get() as { left: number; listing: number | null };
    return {
      messages: accounts.reduce((n, a) => n + a.messages, 0),
      accounts,
      fileBytes: pragma(this.db, "page_count") * pageSize,
      freeBytes: pragma(this.db, "freelist_count") * pageSize,
      filesRead: (
        this.db.prepare("SELECT COUNT(*) AS n FROM attachment_text").get() as { n: number }
      ).n,
      repack: { left: repack.left, listing: repack.listing === 1 },
    };
  }

  /** Reads every page once (`dbstat`): about 1.6 s on 3.6 GB. Run it on the read thread. */
  measure(nowMs: number): StorageSample {
    const pageSize = pragma(this.db, "page_size");
    const rows = this.db
      .prepare(
        `SELECT s.tbl_name AS tbl, SUM(d.pgsize) AS bytes
           FROM dbstat d JOIN sqlite_schema s ON s.name = d.name GROUP BY s.tbl_name`,
      )
      .all() as unknown as { tbl: string; bytes: number }[];
    const parts = { searchBytes: 0, htmlBytes: 0, textBytes: 0, filesTextBytes: 0, mailBytes: 0 };
    for (const row of rows) parts[partOf(row.tbl)] += row.bytes;
    const messages = (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
      .n;
    return {
      atMs: nowMs,
      messages,
      fileBytes: pragma(this.db, "page_count") * pageSize,
      freeBytes: pragma(this.db, "freelist_count") * pageSize,
      ...parts,
    };
  }

  /**
   * What erasing everything would take out of the database, by the review's groups, measured now
   * (ADR 0138, rule 9); reads every page once, like `measure`. With the accounts and the mail
   * still waiting to be sent, which the review names (rule 10).
   */
  eraseMeasure(): EraseMeasure {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      groups: measureTableGroups(this.db),
      accounts: count("SELECT COUNT(*) AS n FROM accounts"),
      messages: count("SELECT COUNT(*) AS n FROM messages"),
      unsent: count(
        "SELECT COUNT(*) AS n FROM send_operations WHERE state IN ('pending', 'held', 'running')",
      ),
    };
  }

  /** Kept measurements, oldest first. */
  samples(): StorageSample[] {
    return this.db
      .prepare(
        `SELECT at_ms AS atMs, messages, file_bytes AS fileBytes, free_bytes AS freeBytes,
                search_bytes AS searchBytes, html_bytes AS htmlBytes, text_bytes AS textBytes,
                files_text_bytes AS filesTextBytes, mail_bytes AS mailBytes
           FROM storage_samples ORDER BY at_ms`,
      )
      .all() as unknown as StorageSample[];
  }
}

/** Keeps measurements: one row per day, the latest of the day wins (ADR 0089, rule 4). */
export class SqliteStorageSamples {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async record(sample: StorageSample): Promise<void> {
    const day = Math.floor(sample.atMs / DAY_MS);
    await write(this.db, () => {
      this.db
        .prepare("DELETE FROM storage_samples WHERE at_ms >= ? AND at_ms < ?")
        .run(day * DAY_MS, (day + 1) * DAY_MS);
      this.db
        .prepare(
          `INSERT INTO storage_samples (at_ms, messages, file_bytes, free_bytes, search_bytes,
             html_bytes, text_bytes, files_text_bytes, mail_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sample.atMs,
          sample.messages,
          sample.fileBytes,
          sample.freeBytes,
          sample.searchBytes,
          sample.htmlBytes,
          sample.textBytes,
          sample.filesTextBytes,
          sample.mailBytes,
        );
      this.db
        .prepare(
          `DELETE FROM storage_samples WHERE at_ms NOT IN
             (SELECT at_ms FROM storage_samples ORDER BY at_ms DESC LIMIT ?)`,
        )
        .run(STORAGE_SAMPLE_LIMIT);
    });
  }

  /**
   * Rewrites the database without its free pages (`VACUUM`), on the writer. It waits for any
   * write in flight and holds every other write until it ends. Returns the bytes given back.
   */
  compact(options?: {
    /**
     * Throws when a reader kept the log from being truncated (ADR 0138, rule 6): the log then
     * still holds the pages that were removed. SQLite says so in the checkpoint's `busy`, not
     * with an error.
     */
    readonly requireCheckpoint?: boolean;
  }): Promise<{ readonly freedBytes: number; readonly ms: number }> {
    // VACUUM cannot run inside a transaction: an exclusive step of its own, not `write`.
    return exclusive(this.db, () => {
      const pageSize = pragma(this.db, "page_size");
      const before = pragma(this.db, "page_count");
      const started = performance.now();
      this.db.exec("VACUUM");
      const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: number }
        | undefined;
      if (options?.requireCheckpoint && (checkpoint?.busy ?? 0) !== 0) {
        throw new Error("a reader kept the log from being truncated; it still holds removed pages");
      }
      return {
        freedBytes: (before - pragma(this.db, "page_count")) * pageSize,
        ms: Math.round(performance.now() - started),
      };
    });
  }
}
