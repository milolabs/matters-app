import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageKey } from "@matters/core";
import { afterAll, describe, expect, it } from "vitest";
import { backfillFileIndex } from "../src/fileIndex.ts";
import { openDatabase, SqliteSearchIndex } from "../src/index.ts";

// ADR 0074: finding files by name must feel instant at the owner's scale. 100k files, spread over
// 60k messages and 12k threads, the common words of a mailbox repeated many times (so the common
// queries match a great many), and the one-off names among them.
const FILES = 100_000;
const MESSAGES = 60_000;
const THREADS = 12_000;
const P95_BUDGET_MS = 15;

const KINDS = ["Faktura", "Umowa", "Aneks", "Załącznik", "Raport", "Oferta", "scan", "image"];
const EXTENSIONS = ["pdf", "pdf", "pdf", "docx", "xlsx", "png", "jpg", "zip"];

function nameOf(i: number): string {
  const kind = KINDS[i % KINDS.length] as string;
  const ext = EXTENSIONS[(i >> 3) % EXTENSIONS.length] as string;
  if (i % 11 === 0) return `image${String(i % 900).padStart(3, "0")}.png`;
  return `${kind}_${i % 997}_${2020 + (i % 7)}.${ext}`;
}

const dir = mkdtempSync(join(tmpdir(), "matters-files-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("finding files by name at scale (ADR 0074)", () => {
  it(`answers every keystroke of a search within ${P95_BUDGET_MS} ms at p95, with ${FILES} files`, async () => {
    const db = openDatabase(join(dir, "mail.db"));
    const insertMessage = db.prepare(
      `INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
         from_json, to_json, cc_json, subject, snippet, flags, has_attachments, change_seq)
       VALUES (?, 'acc1', ?, ?, ?, ?, ?, '[]', '[]', 's', '', 0, 1, 0)`,
    );
    const insertFile = db.prepare(
      `INSERT INTO message_attachments (message_key, part_id, position, name, mime_type, size, inline)
       VALUES (?, ?, ?, ?, 'application/pdf', 1000, 0)`,
    );
    const day = Date.UTC(2022, 0, 1);
    db.exec("BEGIN");
    for (let m = 0; m < MESSAGES; m++) {
      const key = messageKey(day + m * 600_000, 0);
      insertMessage.run(
        key,
        `p${m}`,
        `t${m % THREADS}`,
        `<${m}@x>`,
        day + m * 600_000,
        '{"name":"Jan","address":"jan@example.com"}',
      );
      const files = m < FILES % MESSAGES ? 2 : 1;
      for (let f = 0; f < files; f++) insertFile.run(key, String(f + 2), f, nameOf(m * 2 + f));
    }
    db.exec("COMMIT");
    const count = db.prepare("SELECT count(*) AS n FROM message_attachments").get() as {
      n: number;
    };
    expect(count.n).toBeGreaterThanOrEqual(FILES);

    // Rebuild from the rows: the migration's own pass, on a store this size.
    db.exec("DELETE FROM file_fts; DELETE FROM file_starts");
    const t0 = performance.now();
    db.exec("BEGIN");
    backfillFileIndex(db);
    db.exec("COMMIT");
    const backfillMs = performance.now() - t0;

    const index = new SqliteSearchIndex(db);
    const typed = (word: string) =>
      Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1));
    const queries = [
      ...typed("zalacznik"),
      ...typed("faktura_12"),
      ...typed("aneks"),
      "651",
      "pdf",
      "png",
      "image001",
      "docx",
      "2024",
      "umowa_5",
      "zzzz-nothing",
    ];
    for (const q of queries) await index.searchFiles(q, 5); // warm up
    const times: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const q of queries) {
        const start = performance.now();
        const hits = await index.searchFiles(q, 5);
        times.push(performance.now() - start);
        if (round === 0 && q !== "zzzz-nothing") expect(hits.length, q).toBeGreaterThan(0);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    const median = times[Math.floor(times.length / 2)] as number;
    const max = times[times.length - 1] as number;
    console.info(
      `files by name: ${count.n} files, backfill ${backfillMs.toFixed(0)} ms, ` +
        `median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
    db.close();
  }, 120_000);
});
