import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ReceivedAttachment } from "@matters/core";
import { makeDocument, makeLocation } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  SELECT_THREAD_SQL,
  SqliteMessageStore,
  schemaVersion,
  UNKNOWN_ATTACHMENTS_SQL,
} from "../src/index.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pdf = (partId: string, name: string, over: Partial<ReceivedAttachment> = {}) => ({
  partId,
  name,
  mimeType: "application/pdf",
  size: 100,
  inline: false,
  ...over,
});

describe("upgrade from schema 19 (ADR 0043)", () => {
  it("keeps the mail, counts the ones with no files as known and the others as not, and learns them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v19-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 19)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const docs = [
      makeDocument({ subject: "Faktura", providerId: "p1", hasAttachments: true }, "z fakturą"),
      makeDocument({ subject: "Zwykły", providerId: "p2" }, "bez plików"),
      makeDocument({ subject: "Umowa", providerId: "p3", hasAttachments: true }, "z umową"),
    ];
    await upsertOnOldSchema(
      old,
      docs.map((d) => d.message),
    );
    docs.forEach((d, i) => {
      old
        .prepare("INSERT INTO message_locations VALUES ('acc1', 'INBOX', '1', ?, ?)")
        .run(i + 1, d.message.key);
    });
    expect(schemaVersion(old)).toBe(19);
    const columns = (old.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("attachments_known");
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    const known = db
      .prepare("SELECT subject, attachments_known AS known FROM messages ORDER BY subject")
      .all() as { subject: string; known: number }[];
    expect(known).toEqual([
      { subject: "Faktura", known: 0 },
      { subject: "Umowa", known: 0 },
      { subject: "Zwykły", known: 1 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM message_attachments").get()).toEqual({ n: 0 });
    db.close();

    const storage = createSqliteStorage(path);
    try {
      expect(await storage.store.listUnknownAttachmentUids("acc1", "INBOX", "1", 10)).toEqual([
        1, 3,
      ]);
      const view = await storage.store.getThread(docs[0]?.message.threadId as string);
      expect(view?.messages.map((m) => m.subject)).toEqual(["Faktura"]);
      expect(view?.attachments.get(docs[0]?.message.key as number)).toEqual({
        known: false,
        items: [],
        hasInline: false,
      });

      await storage.store.setAttachments([
        { location: makeLocation(1), attachments: [pdf("2", "Faktura FV 1.pdf")] },
        { location: makeLocation(3), attachments: [] },
      ]);
      expect(await storage.store.listUnknownAttachmentUids("acc1", "INBOX", "1", 10)).toEqual([]);
      const learned = await storage.store.getByKeys(docs.map((d) => d.message.key));
      // The second claimed files and has none: the flag is corrected from the structure.
      expect(learned.map((m) => m.hasAttachments)).toEqual([true, false, false]);
    } finally {
      storage.close();
    }
  });

  it("does not rewrite the table for the messages that have none", () => {
    const sql = MIGRATIONS.find((m) => m.version === 20)?.sql ?? "";
    // The column is added with the answer most rows need, so the table is not rewritten.
    expect(sql).toMatch(/ADD COLUMN attachments_known INTEGER NOT NULL DEFAULT 1/);
    expect(sql).toMatch(/SET attachments_known = 0 WHERE has_attachments = 1/);
  });
});

describe("storage of the files of a message", () => {
  it("removes the rows with the message (ON DELETE CASCADE)", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteMessageStore(db);
      const a = makeDocument({ providerId: "a", hasAttachments: true }).message;
      const b = makeDocument({ providerId: "b", hasAttachments: true }).message;
      await store.upsertMessages([a, b]);
      await store.addLocations([
        { key: a.key, location: makeLocation(1) },
        { key: b.key, location: makeLocation(2) },
      ]);
      await store.setAttachments([
        { location: makeLocation(1), attachments: [pdf("2", "a.pdf"), pdf("3", "a2.pdf")] },
        { location: makeLocation(2), attachments: [pdf("2", "b.pdf")] },
      ]);
      const count = () =>
        (db.prepare("SELECT count(*) AS n FROM message_attachments").get() as { n: number }).n;
      expect(count()).toBe(3);

      db.prepare("DELETE FROM messages WHERE key = ?").run(a.key);
      expect(count()).toBe(1);
      expect(
        (db.prepare("SELECT message_key AS k FROM message_attachments").get() as { k: number }).k,
      ).toBe(b.key);

      // Through the store's own removal as well.
      await store.removeByProviderIds("acc1", ["b"]);
      expect(count()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("stores a row for every part, inline ones too, with the position in the message", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteMessageStore(db);
      const m = makeDocument({ hasAttachments: true }).message;
      await store.upsertMessages([m]);
      await store.addLocations([{ key: m.key, location: makeLocation(1) }]);
      await store.setAttachments([
        {
          location: makeLocation(1),
          attachments: [
            pdf("1.2", "logo.png", { inline: true, contentId: "cid" }),
            pdf("2", "b.pdf"),
            pdf("3", "a.pdf"),
          ],
        },
      ]);
      const rows = db
        .prepare(
          "SELECT part_id, position, name, content_id, inline FROM message_attachments ORDER BY position",
        )
        .all();
      expect(rows).toEqual([
        { part_id: "1.2", position: 0, name: "logo.png", content_id: "cid", inline: 1 },
        { part_id: "2", position: 1, name: "b.pdf", content_id: null, inline: 0 },
        { part_id: "3", position: 2, name: "a.pdf", content_id: null, inline: 0 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("the query for messages whose files are not known (ADR 0043, rule 2)", () => {
  const plan = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
      .map((p) => p.detail)
      .join("\n");

  it("is driven by the partial index and looks locations up by message, never scanning the folder", () => {
    const db = openDatabase(":memory:");
    const text = plan(db, UNKNOWN_ATTACHMENTS_SQL, "acc1", "INBOX", "1", 50);
    expect(text).toMatch(/SEARCH m USING (COVERING )?INDEX messages_attachments_unknown/);
    expect(text).toMatch(/SEARCH l USING (COVERING )?INDEX message_locations_message/);
    expect(text).not.toMatch(/SCAN/);
    expect(text).not.toMatch(/PRIMARY KEY/);
    // Newest first comes out of the index: no sort step.
    expect(text).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it("indexes only the rows that claim files and have not been read", () => {
    const db = openDatabase(":memory:");
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_attachments_unknown'")
      .get() as { sql: string };
    expect(row.sql).toMatch(/WHERE has_attachments = 1 AND attachments_known = 0/);
    db.close();
  });

  it("reads nothing once every message knows", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    const docs = Array.from({ length: 50 }, (_, i) =>
      makeDocument({ providerId: `p${i}`, hasAttachments: i % 2 === 0 }, "x"),
    );
    await store.upsertMessages(docs.map((d) => d.message));
    await store.addLocations(
      docs.map((d, i) => ({ key: d.message.key, location: makeLocation(i + 1) })),
    );
    await store.setAttachments(
      docs.map((d, i) => ({
        location: makeLocation(i + 1),
        attachments: d.message.hasAttachments ? [pdf("2", "a.pdf")] : [],
      })),
    );
    const index = db
      .prepare(
        "SELECT count(*) AS n FROM messages INDEXED BY messages_attachments_unknown WHERE has_attachments = 1 AND attachments_known = 0",
      )
      .get() as { n: number };
    expect(index.n).toBe(0);
    expect(await store.listUnknownAttachmentUids("acc1", "INBOX", "1", 50)).toEqual([]);
    db.close();
  });
});

describe("opening a thread reads its files in the one statement (ADR 0012, ADR 0043 rule 1)", () => {
  it("looks the thread up by its index and the files by their key, never scanning a table", () => {
    const db = openDatabase(":memory:");
    const text = (
      db.prepare(`EXPLAIN QUERY PLAN ${SELECT_THREAD_SQL}`).all("t") as { detail: string }[]
    )
      .map((p) => p.detail)
      .join("\n");
    expect(text).toMatch(/SEARCH m USING INDEX messages_thread/);
    expect(text).toMatch(/SEARCH a USING PRIMARY KEY \(message_key=\?\)/);
    expect(text).not.toMatch(/SCAN m/);
    expect(text).not.toMatch(/SCAN message_attachments/);
    db.close();
  });

  it("is one statement however many messages the thread has", async () => {
    const db = openDatabase(":memory:");
    try {
      // The store prepares through this, so every run of a statement is counted.
      let runs = 0;
      const counting = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "prepare") return typeof value === "function" ? value.bind(target) : value;
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(inner, name) {
                const value = Reflect.get(inner, name);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                  if (name === "all" || name === "get" || name === "run") runs++;
                  return value.apply(inner, args);
                };
              },
            });
          };
        },
      });
      const store = new SqliteMessageStore(counting);
      const docs = Array.from({ length: 30 }, (_, i) =>
        makeDocument({ providerId: `m${i}`, threadId: "long", hasAttachments: true }, "x"),
      );
      await store.upsertMessages(docs.map((d) => d.message));
      await store.addLocations(
        docs.map((d, i) => ({ key: d.message.key, location: makeLocation(i + 1) })),
      );
      await store.setAttachments(
        docs.map((_, i) => ({
          location: makeLocation(i + 1),
          attachments: [pdf("2", `f${i}.pdf`), pdf("3", `g${i}.pdf`)],
        })),
      );
      runs = 0;
      const view = await store.getThread("long");
      expect(runs).toBe(1);
      expect(view?.messages).toHaveLength(30);
      expect([...(view?.attachments.values() ?? [])].every((a) => a.items.length === 2)).toBe(true);
    } finally {
      db.close();
    }
  });
});
