import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { messageKey } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersion,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("upgrade from schema 36 (ADR 0074)", () => {
  it("indexes the files already stored, listed ones only, and keeps them current", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v36-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 36)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const day = (n: number) => Date.UTC(2024, 4, n, 12);
    const insertMessage = old.prepare(
      `INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
         from_json, to_json, cc_json, subject, snippet, flags, has_attachments, change_seq)
       VALUES (?, 'acc1', ?, ?, ?, ?, '{"name":"Jan","address":"jan@example.com"}', '[]', '[]',
         's', '', 0, 1, 0)`,
    );
    const insertFile = old.prepare(
      `INSERT INTO message_attachments
         (message_key, part_id, position, name, mime_type, size, inline)
       VALUES (?, ?, ?, ?, 'application/pdf', 500, ?)`,
    );
    const rows = [
      { n: 1, files: [["2", "Załącznik nr 1.pdf", 0]] },
      {
        n: 2,
        files: [
          ["1.1", "logo.png", 1],
          ["2", "Aneks_651_2026.pdf", 0],
        ],
      },
      {
        n: 3,
        files: [
          ["2", "Aneks_651_2026.pdf", 0],
          ["3", "protokol.docx", 0],
        ],
      },
    ] as const;
    for (const { n, files } of rows) {
      const key = messageKey(day(n), 0);
      insertMessage.run(key, `p${n}`, `t${n}`, `<${n}@x>`, day(n));
      for (const [i, [part, name, inline]] of files.entries()) {
        insertFile.run(key, part, i, name, inline);
      }
    }
    expect(schemaVersion(old)).toBe(36);
    old.close();

    const storage = createSqliteStorage(path);
    const names = async (text: string) =>
      (await storage.read.fileSearch.searchFiles(text, 10)).map(
        (h) => `${h.threadId}:${h.fileName}`,
      );
    expect(await names("aneks")).toEqual(["t3:Aneks_651_2026.pdf", "t2:Aneks_651_2026.pdf"]);
    expect(await names("zalacznik")).toEqual(["t1:Załącznik nr 1.pdf"]);
    expect(await names("proto")).toEqual(["t3:protokol.docx"]);
    expect(await names("pr")).toEqual(["t3:protokol.docx"]);
    expect(await names("65")).toEqual(["t3:Aneks_651_2026.pdf", "t2:Aneks_651_2026.pdf"]);
    // The inline part is stored but not a file anyone searches for.
    expect(await names("logo")).toEqual([]);

    // Messages that go leave the index, and files answered later join it.
    await storage.store.removeByProviderIds("acc1", ["p3"]);
    expect(await names("aneks")).toEqual(["t2:Aneks_651_2026.pdf"]);
    expect(await names("proto")).toEqual([]);
    storage.close();

    const check = new DatabaseSync(path, { readOnly: true });
    expect(schemaVersion(check)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(37);
    check.close();
  });
});
