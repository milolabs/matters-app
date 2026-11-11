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

describe("upgrade from schema 15 (ADR 0037)", () => {
  it("reads old mail as unknown, adds the rule tables empty, and a new write sets the verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v15-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 15)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const doc = makeDocument({ subject: "Stare" }, "stara poczta");
    await upsertOnOldSchema(old, [doc.message]);
    expect(schemaVersion(old)).toBe(15);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();

    const storage = createSqliteStorage(path);
    try {
      const [read] = await storage.store.getByKeys([doc.message.key]);
      expect(read).toMatchObject({ subject: "Stare", senderAuth: "unknown" });
      expect(await storage.imageRules.list()).toEqual([]);
      expect(await storage.imageRules.getGeneral()).toBe("ask");

      // A sync that parses the message again writes the verdict over the default.
      await storage.store.upsertMessages([{ ...doc.message, senderAuth: "pass" }]);
      expect((await storage.store.getByKeys([doc.message.key]))[0]?.senderAuth).toBe("pass");
    } finally {
      storage.close();
    }
  });

  it("refuses a rule with an unknown scope or decision, and a second general row", () => {
    const db = openDatabase(":memory:");
    const insert = (scope: string, decision: string) =>
      db
        .prepare(
          "INSERT INTO image_rules (scope, value, decision, created_ms) VALUES (?, 'x', ?, 0)",
        )
        .run(scope, decision);
    expect(() => insert("sender", "allow")).toThrow();
    expect(() => insert("address", "maybe")).toThrow();
    expect(() => insert("address", "allow")).not.toThrow();
    expect(() => insert("address", "deny")).toThrow(/UNIQUE|constraint/i);
    expect(() =>
      db.prepare("INSERT INTO image_setting (id, general) VALUES (2, 'ask')").run(),
    ).toThrow();
    db.close();
  });

  it("looks a rule up by its key, without scanning", () => {
    const db = openDatabase(":memory:");
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM image_rules WHERE scope = ? AND value = ?")
      .all("address", "a@x.example") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/SEARCH image_rules USING PRIMARY KEY/);
    db.close();
  });
});
