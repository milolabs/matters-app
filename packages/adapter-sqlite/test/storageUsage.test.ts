import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  partOf,
  SqliteStorageUsage,
  STORAGE_SAMPLE_LIMIT,
  type StorageSample,
} from "../src/index.ts";

// ADR 0089: what the database holds, measured for Settings › Storage, and kept once a day.

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function storage() {
  const dir = mkdtempSync(join(tmpdir(), "matters-storage-"));
  dirs.push(dir);
  const s = createSqliteStorage(join(dir, "mail.db"));
  open.push(s);
  return s;
}

const sample = (atMs: number, messages = 1): StorageSample => ({
  atMs,
  messages,
  fileBytes: 100,
  freeBytes: 10,
  searchBytes: 40,
  htmlBytes: 30,
  textBytes: 10,
  filesTextBytes: 0,
  mailBytes: 10,
});

const DAY = 86_400_000;

describe("storage usage", () => {
  it("groups tables the way Settings shows them", () => {
    expect(partOf("message_fts_data")).toBe("searchBytes");
    expect(partOf("message_terms")).toBe("searchBytes");
    expect(partOf("people_words")).toBe("searchBytes");
    expect(partOf("file_starts")).toBe("searchBytes");
    expect(partOf("html_blocks")).toBe("htmlBytes");
    expect(partOf("html_repack")).toBe("htmlBytes");
    expect(partOf("body_index")).toBe("textBytes");
    expect(partOf("attachment_text")).toBe("filesTextBytes");
    expect(partOf("messages")).toBe("mailBytes");
    expect(partOf("agent_talk")).toBe("mailBytes");
  });

  it("counts mail by account and measures every page once", async () => {
    const s = storage();
    await s.store.upsertMessages([
      makeMessage({ key: 1, accountId: "a", providerId: "p1" }),
      makeMessage({ key: 2, accountId: "a", providerId: "p2" }),
      makeMessage({ key: 3, accountId: "b", providerId: "p3" }),
    ]);
    await s.bodies.putBodies([
      { key: 1, threadId: "t1", sender: "x@y", text: "hello", html: "<p>hello</p>" },
    ]);
    const usage = s.read.storageUsage;
    const overview = usage.overview();
    expect(overview.messages).toBe(3);
    expect([...overview.accounts].sort((x, y) => x.accountId.localeCompare(y.accountId))).toEqual([
      { accountId: "a", messages: 2 },
      { accountId: "b", messages: 1 },
    ]);
    expect(overview.fileBytes).toBeGreaterThan(0);
    expect(overview.filesRead).toBe(0);
    // A new database lists nothing to move once its first step ran; before that it is listing.
    expect(overview.repack).toEqual({ left: 0, listing: true });

    const measured = usage.measure(1234);
    expect(measured.atMs).toBe(1234);
    expect(measured.messages).toBe(3);
    const parts =
      measured.searchBytes +
      measured.htmlBytes +
      measured.textBytes +
      measured.filesTextBytes +
      measured.mailBytes;
    // Every page belongs to a table, the free list or the schema itself.
    expect(parts + measured.freeBytes).toBeLessThanOrEqual(measured.fileBytes);
    expect(parts + measured.freeBytes).toBeGreaterThan(measured.fileBytes * 0.9);
    expect(measured.htmlBytes).toBeGreaterThan(0);
    expect(measured.searchBytes).toBeGreaterThan(0);
  });

  it("measures the text of files apart, counts the files read, and keeps the column in samples (ADR 0087, rule 11)", async () => {
    const s = storage();
    await s.store.upsertMessages([makeMessage({ key: 1, accountId: "a", providerId: "p1" })]);
    const empty = s.read.storageUsage.measure(1);
    expect(empty.filesTextBytes).toBeLessThan(5000);
    const big = randomBytes(150_000).toString("base64");
    await s.fileText.put(1, "2", { text: big, pages: 3, state: "ok", extractedMs: 5 });
    await s.fileText.put(1, "3", { text: "", pages: 1, state: "no_text", extractedMs: 5 });
    const usage = s.read.storageUsage;
    expect(usage.overview().filesRead).toBe(2);
    const measured = usage.measure(2);
    expect(measured.filesTextBytes).toBeGreaterThan(150_000);
    // The mail's own group did not take the pages of the files' text.
    expect(measured.mailBytes).toBe(empty.mailBytes);
    await s.storageSamples.record({ ...measured, atMs: 3 * DAY });
    expect(usage.samples().at(-1)?.filesTextBytes).toBe(measured.filesTextBytes);
  });

  it("keeps one measurement a day, the latest of the day, and at most the limit", async () => {
    const s = storage();
    await s.storageSamples.record(sample(10 * DAY + 1000, 1));
    await s.storageSamples.record(sample(10 * DAY + 5000, 2));
    await s.storageSamples.record(sample(11 * DAY, 3));
    const usage = s.read.storageUsage;
    expect(usage.samples().map((x) => [x.atMs, x.messages])).toEqual([
      [10 * DAY + 5000, 2],
      [11 * DAY, 3],
    ]);
    for (let d = 0; d < STORAGE_SAMPLE_LIMIT + 5; d++)
      await s.storageSamples.record(sample(100 * DAY + d * DAY));
    const kept = usage.samples();
    expect(kept).toHaveLength(STORAGE_SAMPLE_LIMIT);
    expect(kept.at(-1)?.atMs).toBe(100 * DAY + (STORAGE_SAMPLE_LIMIT + 4) * DAY);
  });

  it("compacts the free pages away", async () => {
    const s = storage();
    // Incompressible, so the blocks take real pages.
    const big = randomBytes(300_000).toString("base64");
    await s.bodies.putBodies(
      Array.from({ length: 10 }, (_, i) => ({ key: i + 1, threadId: `t${i}`, text: big })),
    );
    await s.bodies.removeBodies(Array.from({ length: 10 }, (_, i) => i + 1));
    const before = s.read.storageUsage.overview();
    expect(before.freeBytes).toBeGreaterThan(0);
    const { freedBytes } = await s.storageSamples.compact();
    expect(freedBytes).toBeGreaterThan(0);
    expect(s.read.storageUsage.overview().freeBytes).toBe(0);
  });

  it("reads on its own connection too", () => {
    const s = storage();
    expect(s.read.storageUsage).toBeInstanceOf(SqliteStorageUsage);
  });
});
