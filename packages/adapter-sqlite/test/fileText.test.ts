import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  schemaVersion,
} from "../src/index.ts";

// ADR 0087, rule 6: the text the agent read from attached files, kept with its message.

const open: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function storage() {
  const s = createSqliteStorage(":memory:");
  open.push(s);
  return s;
}

describe("text of attached files", () => {
  it("starts empty, at schema 43 or later", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
    const s = storage();
    expect(s.read.storageUsage.overview().filesRead).toBe(0);
  });

  it("upgrades a database at schema 42: the table is new and empty, samples gain the column with 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v42-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 42)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    old
      .prepare(
        `INSERT INTO storage_samples (at_ms, messages, file_bytes, free_bytes, search_bytes, html_bytes, text_bytes, mail_bytes)
       VALUES (1, 2, 3, 4, 5, 6, 7, 8)`,
      )
      .run();
    old.close();
    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS n FROM attachment_text").get()).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT files_text_bytes AS b, mail_bytes AS m FROM storage_samples").get(),
      ).toEqual({ b: 0, m: 8 });
      // Foreign keys are on in this database, which is what removes the rows with their message.
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  it("keeps, replaces, reads back, counts and clears", async () => {
    const s = storage();
    await s.store.upsertMessages([makeMessage({ key: 1, providerId: "p1" })]);
    expect(await s.fileText.get(1, "2")).toBeNull();
    await s.fileText.put(1, "2", { text: "Hello", pages: 2, state: "ok", extractedMs: 10 });
    await s.fileText.put(1, "3", { text: "", pages: 1, state: "no_text", extractedMs: 11 });
    expect(await s.fileText.get(1, "2")).toEqual({
      text: "Hello",
      pages: 2,
      state: "ok",
      extractedMs: 10,
    });
    await s.fileText.put(1, "2", { text: "Again", pages: null, state: "ok", extractedMs: 12 });
    expect((await s.fileText.get(1, "2"))?.text).toBe("Again");
    expect((await s.fileText.get(1, "2"))?.pages).toBeNull();
    expect(await s.fileText.count()).toBe(2);
    expect(await s.fileText.clear()).toBe(2);
    expect(await s.fileText.count()).toBe(0);
    expect(await s.fileText.get(1, "2")).toBeNull();
  });

  it("goes with its message", async () => {
    const s = storage();
    const { keys } = await s.store.upsertMessages([
      makeMessage({ providerId: "p1", threadId: "t1" }),
      makeMessage({ providerId: "p2", threadId: "t2" }),
    ]);
    const [a, b] = keys as [number, number];
    await s.fileText.put(a, "2", { text: "a", pages: 1, state: "ok", extractedMs: 1 });
    await s.fileText.put(b, "2", { text: "b", pages: 1, state: "ok", extractedMs: 1 });
    await s.store.removeByProviderIds("acc1", ["p1"]).catch(() => undefined);
    const left = await s.fileText.count();
    // Foreign keys are on, so the row of a deleted message is gone with it.
    expect(left).toBe(1);
    expect(await s.fileText.get(b, "2")).not.toBeNull();
  });

  it("reads again a state this build does not know", async () => {
    const s = storage();
    await s.store.upsertMessages([makeMessage({ key: 1, providerId: "p1" })]);
    await s.fileText.put(1, "2", { text: "x", pages: 1, state: "later" as "ok", extractedMs: 1 });
    expect(await s.fileText.get(1, "2")).toBeNull();
  });

  // ADR 0090, rule 1: PDF text read as 'ok' before the furniture rule is read again.
  it("migration 44 drops the PDF reads kept as ok, and keeps the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v43-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const s = createSqliteStorage(path);
    await s.store.upsertMessages([makeMessage({ key: 1, providerId: "p1" })]);
    await s.fileText.put(1, "pdf", {
      text: "Page 2 from 6",
      pages: 6,
      state: "ok",
      extractedMs: 1,
    });
    await s.fileText.put(1, "scan", { text: "", pages: 2, state: "no_text", extractedMs: 1 });
    await s.fileText.put(1, "docx", { text: "Terms", pages: null, state: "ok", extractedMs: 1 });
    s.close();
    // Back to schema 43, as a database written by the build before this rule.
    const old = new DatabaseSync(path);
    old.prepare("DELETE FROM schema_version WHERE version >= 44").run();
    expect(schemaVersion(old)).toBe(43);
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const rows = db.prepare("SELECT part_id AS p FROM attachment_text ORDER BY part_id").all();
      expect(rows).toEqual([{ p: "docx" }, { p: "scan" }]);
    } finally {
      db.close();
    }
  });
});
