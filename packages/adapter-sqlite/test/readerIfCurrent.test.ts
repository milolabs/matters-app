import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteReaderIfCurrent,
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  schemaVersion,
} from "../src/index.ts";

// The router opens its reader before the sync worker is up only when there is nothing left to
// migrate (ADR 0046, rule 1); in every other case it must wait, as it always did.
const dirs: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-reader-"));
  dirs.push(dir);
  return join(dir, "matters.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createSqliteReaderIfCurrent", () => {
  it("returns null for a database that does not exist, and creates nothing", () => {
    const path = dbPath();
    expect(createSqliteReaderIfCurrent(path)).toBeNull();
    expect(() => new DatabaseSync(path, { readOnly: true })).toThrow();
  });

  it("returns null for a file that is not a database", () => {
    const path = dbPath();
    writeFileSync(path, "not a database at all, just text");
    expect(createSqliteReaderIfCurrent(path)).toBeNull();
  });

  it("returns a working reader for a database at the current schema", async () => {
    const path = dbPath();
    createSqliteStorage(path).close();
    const reader = createSqliteReaderIfCurrent(path);
    expect(reader).not.toBeNull();
    expect(await reader?.read.store.listNewest({ limit: 5 })).toEqual([]);
    reader?.close();
  });

  it("sees what the writer commits afterwards, and never what it has not committed", async () => {
    const path = dbPath();
    const db = openDatabase(path);
    db.close();
    const reader = createSqliteReaderIfCurrent(path);
    expect(reader).not.toBeNull();
    const writer = openDatabase(path);
    writer.exec("BEGIN");
    writer.exec(
      "INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms) VALUES ('x','X','q',99,1,1)",
    );
    expect((await reader?.read.views.list())?.some((v) => v.id === "x")).toBe(false);
    writer.exec("COMMIT");
    expect((await reader?.read.views.list())?.some((v) => v.id === "x")).toBe(true);
    reader?.close();
    writer.close();
  });

  it("reads what a killed writer committed, from a WAL nobody checkpointed", async () => {
    const path = dbPath();
    openDatabase(path).close();
    // A real crash: the process dies with its commit only in the WAL and the -shm left behind.
    const crash = spawnSync(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA wal_autocheckpoint = 0");
         db.exec("INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms) VALUES ('crash','C','q',98,1,1)");
         process.kill(process.pid, "SIGKILL");`,
        path,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    expect(crash.signal).toBe("SIGKILL");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

    const reader = createSqliteReaderIfCurrent(path);
    expect(reader).not.toBeNull();
    expect((await reader?.read.views.list())?.some((v) => v.id === "crash")).toBe(true);
    reader?.close();
  });

  it("returns null for an older schema, which the writer has to migrate first", () => {
    const path = dbPath();
    const db = openDatabase(path);
    db.exec(`DELETE FROM schema_version WHERE version = ${LATEST_SCHEMA_VERSION}`);
    expect(schemaVersion(db)).toBeLessThan(LATEST_SCHEMA_VERSION);
    db.close();
    expect(createSqliteReaderIfCurrent(path)).toBeNull();
  });

  it("returns null for a newer schema, which the writer will refuse", () => {
    const path = dbPath();
    const db = openDatabase(path);
    db.exec(
      `INSERT INTO schema_version (version, applied_at_ms) VALUES (${LATEST_SCHEMA_VERSION + 1}, 1)`,
    );
    db.close();
    expect(createSqliteReaderIfCurrent(path)).toBeNull();
  });

  it("returns null for a database that is not in WAL mode", () => {
    const path = dbPath();
    openDatabase(path).close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = DELETE");
    db.close();
    expect(createSqliteReaderIfCurrent(path)).toBeNull();
  });
});
