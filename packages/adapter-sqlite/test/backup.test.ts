import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compareSchema, judgeBackup } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBackup,
  consolidateDatabase,
  copyDatabase,
  expectedSchema,
  inspectBackup,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  prepareRestore,
  RESTORED_SEND_WARNING,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-backup-"));
  dirs.push(dir);
  return dir;
}

/** A database at `version`, made by our migrations, with an account and a few rows. */
function databaseAt(path: string, version = LATEST_SCHEMA_VERSION): void {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
    db.exec("BEGIN");
    db.exec(m.sql);
    m.run?.(db);
    db.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    db.exec("COMMIT");
  }
  db.close();
}

function withAccount(path: string, id = "a1", host = "imap.example.com"): void {
  const db = openDatabase(path);
  db.prepare(
    `INSERT INTO accounts (id, address, display_name, transport, imap_host, imap_port,
                           imap_security, imap_username, created_at_ms)
     VALUES (?, 'me@example.com', 'Me', 'imap', ?, 993, 'tls', 'me', 1)`,
  ).run(id, host);
  db.close();
}

/** Adds an object our schema never has, the way a crafted file would carry it. */
function tamper(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
}

describe("a backup (ADR 0145, rule 6)", () => {
  it("is a consistent copy taken while another connection writes, and passes the checks", async () => {
    const dir = folder();
    const live = join(dir, "matters.db");
    const db = openDatabase(live);
    db.exec("CREATE TEMP TABLE IF NOT EXISTS t (x)");
    db.prepare(
      `INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms)
       VALUES ('v0', 'Before', 'is:unread', 99, 1, 1)`,
    ).run();
    // The writer goes on in a transaction of its own while the copy is taken on another connection.
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms)
       VALUES ('v1', 'Uncommitted', 'is:starred', 100, 1, 1)`,
    ).run();
    const target = join(dir, "copy.db");
    closeSync(openSync(target, "wx", 0o600));
    copyDatabase(live, target);
    db.exec("COMMIT");
    db.close();

    expect(statSync(target).mode & 0o777).toBe(0o600);
    // One file, in rollback mode: header bytes 18 and 19 are 1.
    const header = readFileSync(target).subarray(18, 20);
    expect([...header]).toEqual([1, 1]);
    expect(checkBackup(target)).toEqual({
      kind: "restorable",
      version: LATEST_SCHEMA_VERSION,
      migrate: false,
    });
    const copy = new DatabaseSync(target, { readOnly: true });
    const names = (copy.prepare("SELECT name FROM saved_views").all() as { name: string }[]).map(
      (r) => r.name,
    );
    copy.close();
    expect(names).toContain("Before");
    // The snapshot is the moment the copy began: the open transaction is not in it.
    expect(names).not.toContain("Uncommitted");
  });
});

describe("a file to restore (ADR 0145, rule 8)", () => {
  it("is refused when it is not SQLite, or is damaged", () => {
    const dir = folder();
    const text = join(dir, "notes.db");
    writeFileSync(text, "just some text, not a database at all, long enough to read");
    expect(inspectBackup(text)).toEqual({ kind: "notSqlite" });

    const broken = join(dir, "broken.db");
    databaseAt(broken);
    withAccount(broken);
    const bytes = readFileSync(broken);
    // Page 2 onwards overwritten: the header still says SQLite.
    bytes.fill(0xa5, 4096, 4096 * 6);
    writeFileSync(broken, bytes);
    expect(["damaged", "notSqlite"]).toContain(inspectBackup(broken).kind);
    expect(checkBackup(broken).kind).toBe("refused");
  });

  it("is refused when it is a database of something else", () => {
    const path = join(folder(), "other.db");
    tamper(path, "CREATE TABLE notes (body TEXT)");
    expect(inspectBackup(path)).toEqual({ kind: "foreign" });
  });

  it("is refused when it is newer than this build", () => {
    const path = join(folder(), "newer.db");
    databaseAt(path);
    tamper(path, `INSERT INTO schema_version VALUES (${LATEST_SCHEMA_VERSION + 1}, 0)`);
    expect(checkBackup(path)).toEqual({
      kind: "refused",
      reason: "newer",
      version: LATEST_SCHEMA_VERSION + 1,
    });
  });

  it.each([
    [
      "a trigger",
      "CREATE TRIGGER planted AFTER INSERT ON saved_views BEGIN DELETE FROM accounts; END",
    ],
    ["a view", "CREATE VIEW planted AS SELECT * FROM accounts"],
    ["a table", "CREATE TABLE planted (x)"],
    ["an index on an expression", "CREATE INDEX planted ON accounts (lower(address) || 'x')"],
    ["a virtual table", "CREATE VIRTUAL TABLE planted USING fts5(x)"],
  ])("is refused when it carries %s our schema does not have", (_what, sql) => {
    const path = join(folder(), "crafted.db");
    databaseAt(path);
    tamper(path, sql);
    expect(checkBackup(path)).toEqual({
      kind: "refused",
      reason: "schema",
      version: LATEST_SCHEMA_VERSION,
    });
  });

  it("is refused when one of our triggers says something else under its own name", () => {
    const path = join(folder(), "crafted.db");
    databaseAt(path);
    const [trigger] = expectedSchema(LATEST_SCHEMA_VERSION).filter((o) => o.type === "trigger");
    if (!trigger) throw new Error("the schema has a trigger");
    tamper(
      path,
      `DROP TRIGGER ${trigger.name}; CREATE TRIGGER ${trigger.name} AFTER INSERT ON ${trigger.tableName} BEGIN DELETE FROM accounts; END`,
    );
    expect(checkBackup(path)).toMatchObject({ kind: "refused", reason: "schema" });
  });

  it("is refused when it lacks something our schema of its version has", () => {
    const path = join(folder(), "short.db");
    databaseAt(path);
    tamper(path, "DROP INDEX drafts_thread");
    expect(checkBackup(path)).toMatchObject({ kind: "refused", reason: "schema" });
  });

  it("of an older version is restorable, and is carried forward by our migrations", () => {
    const path = join(folder(), "older.db");
    databaseAt(path, 57);
    expect(checkBackup(path)).toEqual({ kind: "restorable", version: 57, migrate: true });
    const prepared = prepareRestore(path, 1000);
    expect(prepared).toMatchObject({ version: LATEST_SCHEMA_VERSION, migrated: true });
    expect(checkBackup(path)).toEqual({
      kind: "restorable",
      version: LATEST_SCHEMA_VERSION,
      migrate: false,
    });
  });

  it("matches our schema at every version, so a backup of any version of ours passes", () => {
    for (const version of [1, 20, 40, 56, LATEST_SCHEMA_VERSION]) {
      const path = join(folder(), `v${version}.db`);
      databaseAt(path, version);
      expect(checkBackup(path)).toMatchObject({ kind: "restorable", version });
    }
  });

  it("is read with nothing of it run: the core compares what the adapter read", () => {
    const objects = expectedSchema(LATEST_SCHEMA_VERSION);
    expect(compareSchema(objects, objects)).toEqual({ unexpected: [], missing: [] });
    expect(
      judgeBackup({ kind: "read", version: 3, objects: [] }, LATEST_SCHEMA_VERSION, () => objects),
    ).toMatchObject({ kind: "refused", reason: "schema" });
  });
});

describe("a restore made ready (ADR 0145, rules 9 and 10)", () => {
  it("holds what waited in the outbox, with the reason, and sends nothing by itself", () => {
    const path = join(folder(), "restore.db");
    databaseAt(path);
    withAccount(path);
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO send_operations (id, account_id, draft_id, summary, state, approval_json,
         attempts, not_before_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'a1', ?, 'Lunch', ?, '{}', 0, 0, 0, 0)`,
    );
    insert.run("s1", "d1", "pending");
    insert.run("s2", "d2", "succeeded");
    insert.run("s3", "d3", "unknown");
    db.close();

    const prepared = prepareRestore(path, 5000);
    expect(prepared).toMatchObject({ heldSends: 1, accounts: 1, messages: 0 });
    expect(prepared.connections.map((c) => c.imapHost)).toEqual(["imap.example.com"]);
    const after = new DatabaseSync(path, { readOnly: true });
    const rows = after.prepare("SELECT id, state, warning FROM send_operations ORDER BY id").all();
    after.close();
    expect(rows).toEqual([
      { id: "s1", state: "held", warning: RESTORED_SEND_WARNING },
      { id: "s2", state: "succeeded", warning: null },
      { id: "s3", state: "unknown", warning: null },
    ]);
    // One file, no log beside it.
    expect(() => statSync(`${path}-wal`)).toThrow();
  });

  it("makes a set-aside database with its log into one file", () => {
    const dir = folder();
    const path = join(dir, "aside.db");
    const db = openDatabase(path);
    db.prepare(
      `INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms)
       VALUES ('v9', 'In the log', 'x', 9, 1, 1)`,
    ).run();
    // Left open with its log, as a crash would leave it; a copy of the pair is what the swap moves.
    writeFileSync(join(dir, "pair.db"), readFileSync(path));
    writeFileSync(join(dir, "pair.db-wal"), readFileSync(`${path}-wal`));
    db.close();
    consolidateDatabase(join(dir, "pair.db"));
    expect(() => statSync(join(dir, "pair.db-wal"))).toThrow();
    const back = new DatabaseSync(join(dir, "pair.db"), { readOnly: true });
    expect(back.prepare("SELECT name FROM saved_views WHERE id = 'v9'").get()).toEqual({
      name: "In the log",
    });
    back.close();
  });
});
