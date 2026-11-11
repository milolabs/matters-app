import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeDocument } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  schemaVersion,
} from "../src/index.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("upgrade from schema 16 (ADR 0039)", () => {
  it("keeps the mail and its flags, adds the request table empty, and marking read works on old rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v16-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 16)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const doc = makeDocument({ subject: "Stare" }, "stara poczta");
    await upsertOnOldSchema(old, [doc.message]);
    expect(schemaVersion(old)).toBe(16);
    expect(
      old.prepare("SELECT name FROM sqlite_master WHERE name = 'flag_operations'").get(),
    ).toBeUndefined();
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();

    const storage = createSqliteStorage(path);
    try {
      expect(await storage.flagOps.listPending()).toEqual([]);
      expect(await storage.flagOps.nextDueMs()).toBeNull();
      const [read] = await storage.store.getByKeys([doc.message.key]);
      expect(read).toMatchObject({ subject: "Stare", flags: { seen: false } });

      const result = await storage.store.setSeen([doc.message.key], true);
      expect(result.changedKeys).toEqual([doc.message.key]);
      expect((await storage.store.getByKeys([doc.message.key]))[0]?.flags.seen).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("refuses a request that is not a clear read or unread, and a second one for a message", () => {
    const db = openDatabase(":memory:");
    const insert = (key: number, seen: number, previous: number) =>
      db
        .prepare(
          `INSERT INTO flag_operations
             (message_key, account_id, seen, previous_seen, next_attempt_ms, created_at_ms)
           VALUES (?, 'a', ?, ?, 0, 0)`,
        )
        .run(key, seen, previous);
    expect(() => insert(1, 2, 0)).toThrow();
    expect(() => insert(1, 1, -1)).toThrow();
    expect(() => insert(1, 1, 0)).not.toThrow();
    expect(() => insert(1, 0, 1)).toThrow(/UNIQUE|constraint/i);
    db.close();
  });

  it("finds what is due and what belongs to an account through an index", () => {
    const db = openDatabase(":memory:");
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((p) => p.detail)
        .join(" ");
    expect(
      plan("SELECT * FROM flag_operations WHERE next_attempt_ms <= 5 ORDER BY next_attempt_ms"),
    ).toMatch(/USING INDEX flag_operations_due/);
    expect(plan("SELECT * FROM flag_operations WHERE account_id = 'a'")).toMatch(
      /USING INDEX flag_operations_account/,
    );
    expect(plan("SELECT MIN(next_attempt_ms) FROM flag_operations")).toMatch(/INDEX/);
    db.close();
  });
});
