import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeDocument, makeLocation } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  SqliteMessageStore,
  schemaVersion,
  UNKNOWN_REPLY_TO_SQL,
} from "../src/index.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const help = [{ name: "Help", address: "help@shop.example" }];

describe("upgrade from schema 18 (ADR 0042)", () => {
  it("keeps the mail, reads it as unknown, lists it for the sync, and learns it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v18-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 18)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const docs = [
      makeDocument({ subject: "Stare", providerId: "p1", senderAuth: "fail" }, "stara poczta"),
      makeDocument({ subject: "Starsze", providerId: "p2" }, "jeszcze starsza"),
    ];
    await upsertOnOldSchema(
      old,
      docs.map((d) => d.message),
    );
    // The store of today cannot be built on this schema, so the locations go in as rows.
    docs.forEach((d, i) => {
      old
        .prepare("INSERT INTO message_locations VALUES ('acc1', 'INBOX', '1', ?, ?)")
        .run(i + 1, d.message.key);
    });
    expect(schemaVersion(old)).toBe(18);
    expect(
      (old.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name),
    ).not.toContain("reply_to_json");
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    const raw = db
      .prepare("SELECT count(*) AS n, count(reply_to_json) AS known FROM messages")
      .get();
    expect(raw).toMatchObject({ n: 2, known: 0 });
    db.close();

    const storage = createSqliteStorage(path);
    try {
      const read = await storage.store.getByKeys(docs.map((d) => d.message.key));
      expect(read.map((m) => m.subject)).toEqual(["Stare", "Starsze"]);
      expect(read[0]?.senderAuth).toBe("fail");
      for (const m of read) expect(m.replyTo).toBeUndefined();

      expect(await storage.store.listUnknownReplyToUids("acc1", "INBOX", "1", 10)).toEqual([1, 2]);
      await storage.store.setReplyTo([
        { location: makeLocation(1), replyTo: help },
        { location: makeLocation(2), replyTo: [] },
      ]);
      expect(await storage.store.listUnknownReplyToUids("acc1", "INBOX", "1", 10)).toEqual([]);
      const learned = await storage.store.getByKeys(docs.map((d) => d.message.key));
      expect(learned.map((m) => m.replyTo)).toEqual([help, []]);
    } finally {
      storage.close();
    }
  });
});

describe("storage of Reply-To", () => {
  it("round trips a list with names, and an empty list, through the column", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteMessageStore(db);
      const a = makeDocument({ replyTo: help }).message;
      const b = makeDocument({ replyTo: [] }).message;
      const c = makeDocument({}).message;
      await store.upsertMessages([a, b, c]);
      const rows = db
        .prepare("SELECT key, reply_to_json AS json FROM messages ORDER BY key")
        .all() as { key: number; json: string | null }[];
      const byKey = new Map(rows.map((r) => [r.key, r.json]));
      expect(byKey.get(a.key)).toBe(JSON.stringify(help));
      expect(byKey.get(b.key)).toBe("[]");
      expect(byKey.get(c.key)).toBeNull();
      expect((await store.getByKeys([a.key, b.key, c.key])).map((m) => m.replyTo)).toEqual([
        help,
        [],
        undefined,
      ]);
    } finally {
      db.close();
    }
  });
});

describe("the query for messages that do not know (ADR 0042, rule 8)", () => {
  it("is driven by the partial index and looks locations up by message, never scanning the folder", () => {
    const db = openDatabase(":memory:");
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${UNKNOWN_REPLY_TO_SQL}`).all("acc1", "INBOX", "1", 50) as {
        detail: string;
      }[]
    ).map((p) => p.detail);
    const text = plan.join("\n");
    expect(text).toMatch(/SEARCH m USING (COVERING )?INDEX messages_reply_to_unknown/);
    expect(text).toMatch(/SEARCH l USING (COVERING )?INDEX message_locations_message/);
    // Neither table is read in full, nor the folder's locations by their primary key.
    expect(text).not.toMatch(/SCAN/);
    expect(text).not.toMatch(/PRIMARY KEY/);
    // Newest first comes out of the index: no sort step.
    expect(text).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it("indexes only the unknown rows", () => {
    const db = openDatabase(":memory:");
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_reply_to_unknown'")
      .get() as { sql: string };
    expect(row.sql).toMatch(/WHERE reply_to_json IS NULL/);
    db.close();
  });

  it("reads nothing once every message knows", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    const docs = Array.from({ length: 50 }, (_, i) =>
      makeDocument({ providerId: `p${i}`, replyTo: [] }, "x"),
    );
    await store.upsertMessages(docs.map((d) => d.message));
    await store.addLocations(
      docs.map((d, i) => ({ key: d.message.key, location: makeLocation(i + 1) })),
    );
    const index = db
      .prepare(
        "SELECT count(*) AS n FROM messages INDEXED BY messages_reply_to_unknown WHERE reply_to_json IS NULL",
      )
      .get() as { n: number };
    expect(index.n).toBe(0);
    expect(await store.listUnknownReplyToUids("acc1", "INBOX", "1", 50)).toEqual([]);
    db.close();
  });
});
