import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredAttachment } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  schemaVersion,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("upgrade from schema 21 (ADR 0045, rule 8)", () => {
  it("has the forward migration right after the moves", () => {
    expect(MIGRATIONS.find((m) => m.version === 22)?.sql).toContain("origin_message_key");
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(22);
  });

  it("keeps the files of drafts as ordinary files, with no origin and their own path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v21-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 21)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const insert = old.prepare(
      `INSERT INTO attachments (id, draft_id, account_id, name, size, state, reason, sha256,
         source_path, source_mtime_ms, created_at_ms)
       VALUES (?, 'd1', 'acc1', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "a",
      "report.pdf",
      1234,
      "ready",
      null,
      "b".repeat(64),
      "/Users/me/report.pdf",
      5.5,
      1,
    );
    insert.run("b", "notes.txt", 10, "reading", null, null, "/Users/me/notes.txt", null, 2);
    insert.run("c", "gone.txt", 10, "failed", "Can't read this file", null, null, null, 3);
    expect(schemaVersion(old)).toBe(21);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();

    const storage = createSqliteStorage(path);
    try {
      const rows = await storage.attachments.forDraft("d1");
      expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
      for (const row of rows) expect(row.origin).toBeNull();
      expect(rows[0]).toMatchObject({
        sourcePath: "/Users/me/report.pdf",
        sourceMtimeMs: 5.5,
        state: "ready",
      });
      expect(rows[2]).toMatchObject({ sourcePath: null, state: "failed" });

      // A forwarded file can be added next to them, and the old rows are untouched by it.
      const forwarded: StoredAttachment = {
        id: "f",
        draftId: "d1",
        accountId: "acc1",
        name: "Faktura.pdf",
        size: 99,
        state: "reading",
        reason: null,
        sha256: null,
        sourcePath: null,
        sourceMtimeMs: null,
        origin: { messageKey: 1_744_965_242_880_000, partId: "2.1" },
        createdAtMs: 4,
      };
      await storage.attachments.add(forwarded);
      expect(await storage.attachments.get("f")).toEqual(forwarded);
      expect((await storage.attachments.get("a"))?.origin).toBeNull();
      expect(await storage.attachments.listByState(["reading"])).toHaveLength(2);
    } finally {
      storage.close();
    }
  });

  it("a row has both halves of an origin or neither", () => {
    const db = openDatabase(":memory:");
    const insert = (key: number | null, part: string | null) =>
      db
        .prepare(
          `INSERT INTO attachments (id, draft_id, account_id, name, size, state, created_at_ms,
             origin_message_key, origin_part_id)
           VALUES (?, 'd', 'a', 'n', 1, 'reading', 0, ?, ?)`,
        )
        .run(`id-${key}-${part}`, key, part);
    expect(() => insert(null, null)).not.toThrow();
    expect(() => insert(1, "2")).not.toThrow();
    expect(() => insert(1, null)).toThrow(/CHECK|constraint/i);
    expect(() => insert(null, "2")).toThrow(/CHECK|constraint/i);
    db.close();
  });

  it("keeps an origin through an update, and can clear nothing by accident", async () => {
    const storage = createSqliteStorage(":memory:");
    try {
      const row: StoredAttachment = {
        id: "f",
        draftId: "d",
        accountId: "a",
        name: "x.pdf",
        size: 1,
        state: "reading",
        reason: null,
        sha256: null,
        sourcePath: null,
        sourceMtimeMs: null,
        origin: { messageKey: 7, partId: "3" },
        createdAtMs: 1,
      };
      await storage.attachments.add(row);
      await storage.attachments.update({ ...row, state: "ready", sha256: "c".repeat(64), size: 2 });
      expect(await storage.attachments.get("f")).toMatchObject({
        state: "ready",
        size: 2,
        origin: { messageKey: 7, partId: "3" },
        sourcePath: null,
      });
    } finally {
      storage.close();
    }
  });
});
