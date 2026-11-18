// Backing up and restoring the database (ADR 0145, rules 6 to 10): the SQLite side. A backup is
// `VACUUM INTO` on a read-only connection of its own: one read transaction, so the copy is one
// moment of the database while the writer goes on (in WAL mode a reader never blocks it). A file
// to restore is untrusted: it is opened read-only with every defence `node:sqlite` offers, its
// schema is compared with the one our own migrations make for its version before anything else
// reads it, and only then is its integrity checked. What may be restored is core's judgement.
import { closeSync, openSync, readSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import {
  type AccountConnection,
  type BackupFindings,
  type DatabaseBackupPort,
  judgeBackup,
  type RestoreVerdict,
  type SchemaObject,
} from "@matters/core";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from "./database.ts";

/** The first 16 bytes of every SQLite database file. */
const MAGIC = Buffer.from("SQLite format 3\u0000", "latin1");

/** The schema as `sqlite_schema` lists it, in a stable order. */
function schemaOf(db: DatabaseSync): SchemaObject[] {
  return (
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[]
  ).map((r) => ({ type: r.type, name: r.name, tableName: r.tbl_name, sql: r.sql }));
}

const expected = new Map<number, readonly SchemaObject[]>();

/**
 * The schema this build's migrations make for `version` (ADR 0145, rule 8): a database in memory,
 * made by the same migrations a real one went through, up to that version. Not a list kept by
 * hand, so a new migration is covered the day it is written.
 */
export function expectedSchema(version: number): readonly SchemaObject[] {
  const known = expected.get(version);
  if (known) return known;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.version > version) break;
      db.exec("BEGIN IMMEDIATE");
      db.exec(migration.sql);
      migration.run?.(db);
      db.prepare("INSERT INTO schema_version (version, applied_at_ms) VALUES (?, 0)").run(
        migration.version,
      );
      db.exec("COMMIT");
    }
    const objects = schemaOf(db);
    expected.set(version, objects);
    return objects;
  } finally {
    db.close();
  }
}

/** Whether the file starts as an SQLite database does; false for anything shorter or else. */
function hasMagic(path: string): boolean {
  const head = Buffer.alloc(MAGIC.length);
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The statements a check of a file we did not make may run: reads and the pragmas below. */
const READS = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION]);
const PRAGMAS = new Set([
  "integrity_check",
  // The full-text index's own check of its tables asks for it.
  "data_version",
  "trusted_schema",
  "cell_size_check",
  "mmap_size",
  "query_only",
  "busy_timeout",
]);

/**
 * Opens a file nobody vouches for (ADR 0145, rule 8): read-only, no extension loading (the
 * driver's default, said again), defensive mode (no writing the schema, no `PRAGMA
 * writable_schema`, no shadow-table writes), `trusted_schema` off (functions and virtual tables
 * in the schema may not run unless SQLite knows them harmless), the cell-size check on, no memory
 * map, `query_only`, and an authorizer that lets through only reads and the pragmas above.
 */
function openUntrusted(path: string): DatabaseSync {
  const db = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: false,
    defensive: true,
  });
  try {
    db.enableDefensive(true);
    db.exec(`
      PRAGMA trusted_schema = OFF;
      PRAGMA cell_size_check = ON;
      PRAGMA mmap_size = 0;
      PRAGMA query_only = ON;
    `);
    db.setAuthorizer((action, first) => {
      if (READS.has(action)) return constants.SQLITE_OK;
      if (action === constants.SQLITE_PRAGMA && first !== null && PRAGMAS.has(first))
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Our `schema_version` table, as every database of ours has it from its first open. */
const versionTable = () =>
  expectedSchema(1).find((o) => o.name === "schema_version" && o.type === "table");

/**
 * Reads a file chosen to restore (ADR 0145, rule 8), in an order that trusts nothing: the header;
 * the schema, which reading `sqlite_schema` takes without running anything of the file's; the
 * version, read only once `schema_version` is found to be our plain table; the comparison with our
 * schema of that version; and only then the integrity check, which reads every page and every
 * index (an index's expression is then known to be ours).
 */
export function inspectBackup(path: string): BackupFindings {
  if (!hasMagic(path)) return { kind: "notSqlite" };
  let db: DatabaseSync;
  try {
    db = openUntrusted(path);
  } catch {
    return { kind: "notSqlite" };
  }
  try {
    let objects: SchemaObject[];
    try {
      objects = schemaOf(db);
    } catch {
      return { kind: "damaged" };
    }
    const table = objects.find((o) => o.name === "schema_version");
    const ours = versionTable();
    if (!table || !ours || table.type !== "table" || table.sql !== ours.sql)
      return { kind: "foreign" };
    let version: number;
    try {
      const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
        v: unknown;
      };
      version = typeof row.v === "number" ? row.v : Number.NaN;
    } catch {
      return { kind: "damaged" };
    }
    if (!Number.isInteger(version) || version < 1) return { kind: "foreign" };
    // A version this build knows is compared now; the rest is judged by core as it is.
    if (version > LATEST_SCHEMA_VERSION) return { kind: "read", version, objects };
    const verdict = judgeBackup({ kind: "read", version, objects }, LATEST_SCHEMA_VERSION, () =>
      expectedSchema(version),
    );
    if (verdict.kind === "refused") return { kind: "read", version, objects };
    try {
      const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") return { kind: "damaged" };
    } catch {
      return { kind: "damaged" };
    }
    return { kind: "read", version, objects };
  } finally {
    db.close();
  }
}

/** Inspects and judges in one: what the window is told about a chosen file. */
export function checkBackup(path: string): RestoreVerdict {
  return judgeBackup(inspectBackup(path), LATEST_SCHEMA_VERSION, expectedSchema);
}

/**
 * A consistent copy of the database at `source` into `target`, an empty file the caller made
 * (mode 0600, so the copy is the person's alone from its first byte) or no file at all (ADR 0145,
 * rule 6). `VACUUM INTO` on a read-only connection: one read transaction, the writer goes on, and
 * the copy has no free pages and no log. SQLite does not flush it to disk; the caller does,
 * before it gives the copy its name. Temporary data of the rebuild goes to files, not memory.
 */
export function copyDatabase(source: string, target: string): void {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = FILE;");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

export const sqliteBackup: DatabaseBackupPort = {
  copy: copyDatabase,
  inspect: inspectBackup,
  expectedSchema,
};

/** What the window says about a backup before the restart (ADR 0145, rule 9). */
export interface PreparedRestore {
  readonly version: number;
  readonly migrated: boolean;
  readonly messages: number;
  readonly accounts: number;
  /** Outbox items held, so nothing is sent again by the restore (rule 10). */
  readonly heldSends: number;
  /** Every account of the restored database, for the hold of this Mac's credentials (rule 9). */
  readonly connections: readonly AccountConnection[];
}

/** The words a held item carries in the outbox: why it waits for the person (rule 10). */
export const RESTORED_SEND_WARNING =
  "Restored from a backup. It may have been sent after the backup was made, so it waits for you.";

/** The accounts' connections, as `accountsToHold` compares them. */
export function accountConnections(db: DatabaseSync): AccountConnection[] {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((c) => c.name),
  );
  const transport = columns.has("transport") ? "transport" : "'imap' AS transport";
  return (
    db
      .prepare(
        `SELECT id, address, ${transport}, imap_host, imap_port, imap_security, imap_username,
                smtp_host, smtp_port, smtp_security, smtp_username FROM accounts ORDER BY id`,
      )
      .all() as Record<string, string | number | null>[]
  ).map((r) => ({
    id: String(r.id),
    address: String(r.address),
    transport: String(r.transport),
    imapHost: (r.imap_host as string | null) ?? null,
    imapPort: (r.imap_port as number | null) ?? null,
    imapSecurity: (r.imap_security as string | null) ?? null,
    imapUsername: (r.imap_username as string | null) ?? null,
    smtpHost: (r.smtp_host as string | null) ?? null,
    smtpPort: (r.smtp_port as number | null) ?? null,
    smtpSecurity: (r.smtp_security as string | null) ?? null,
    smtpUsername: (r.smtp_username as string | null) ?? null,
  }));
}

/** The accounts' connections of the database in use, read on a read-only connection; [] if none. */
export function currentConnections(path: string): AccountConnection[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return accountConnections(db);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Makes our own copy of a checked backup ready to be swapped in (ADR 0145, rules 8 to 10). Only a
 * file `checkBackup` found restorable is given here, and it is our copy in the data folder, never
 * the person's file. Older is carried forward now by the normal migrations, so the swap at the
 * next start is renames only and a migration that fails is told while the window is open. Outbox
 * items waiting to go (`pending`) are held with the reason, so a restore sends nothing by itself;
 * one that was being handed off is settled at start as any interrupted send is. The copy is left
 * as one file in rollback mode, with no log beside it.
 */
export function prepareRestore(path: string, nowMs: number): PreparedRestore {
  // The schema is ours by now (`checkBackup`), so it is opened as our own database is; defensive
  // still, so nothing in it can write the schema.
  const db = new DatabaseSync(path, { allowExtension: false, defensive: true });
  try {
    db.enableDefensive(true);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
    `);
    const before = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number;
    };
    migrate(db);
    const heldSends = Number(
      db
        .prepare(
          "UPDATE send_operations SET state = 'held', state_text = NULL, state_action = NULL, warning = ?, updated_at_ms = ? WHERE state = 'pending'",
        )
        .run(RESTORED_SEND_WARNING, nowMs).changes,
    );
    const count = (table: string) =>
      Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    return {
      version: LATEST_SCHEMA_VERSION,
      migrated: before.v < LATEST_SCHEMA_VERSION,
      messages: count("messages"),
      accounts: count("accounts"),
      heldSends,
      connections: accountConnections(db),
    };
  } finally {
    db.close();
  }
}

/**
 * A set-aside database made into one file (ADR 0145, rule 9), before it is offered to restore:
 * its log is checkpointed into it and the file is left in rollback mode. It is our own database,
 * set aside by the swap, never a file from elsewhere.
 */
export function consolidateDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;",
    );
  } finally {
    db.close();
  }
}
