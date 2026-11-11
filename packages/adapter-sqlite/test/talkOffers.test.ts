import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openDatabase, SqliteAgentInsightStore, schemaVersion } from "../src/index.ts";

// ADR 0102: what the agent offered and the counts an answer rests on are kept with the answer.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const found = {
  threadId: null,
  atMs: 5,
  role: "agent" as const,
  kind: "found" as const,
  text: "Here are views.",
  quotes: [],
  runtimeName: "Fake",
  model: "m",
  threads: 0,
  query: "",
  hits: [],
};

const offer = {
  kind: "view" as const,
  name: "Invoices",
  query: "subject:invoice",
  why: "Every bill in one place.",
  matches: 500,
  matchesCapped: true,
  unread: 12,
};

const act = {
  kind: "act" as const,
  action: "markRead" as const,
  query: "from:shop.test",
  why: "Shop mail you never open.",
  matches: 40,
  matchesCapped: false,
  unread: 40,
};
const message = {
  kind: "message" as const,
  to: ["anna@north.test"],
  unknownTo: ["x@far.test"],
  subject: "Late",
  body: "I will be late.",
  why: "You asked.",
};
const facts = [
  { kind: "count" as const, query: "from:anna", matches: 9, capped: false, unread: 2 },
  {
    kind: "overview" as const,
    months: 3,
    senders: [{ key: "anna@north.test", name: "Anna", messages: 9, unread: 2 }],
    domains: [{ key: "north.test", messages: 9, unread: 2 }],
  },
];

describe("what the agent offered with an answer across all mail", () => {
  it("is stored with the answer and read back, only the fields of each kind; an answer without has none", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteAgentInsightStore(db);
    await store.appendTalk([
      { threadId: null, atMs: 4, role: "you", text: "make me views" },
      {
        ...found,
        offers: [{ ...offer, extra: "dropped" } as typeof offer, act, message],
        facts,
        loop: { searches: 0, read: 0, counts: 3, views: true },
      },
      { ...found, atMs: 6, offers: [], facts: [] },
    ]);
    const list = await store.listTalk(null, 10);
    expect(list[1]).toMatchObject({ loop: { counts: 3, views: true } });
    if (list[1]?.role !== "agent") throw new Error("expected an agent entry");
    expect(list[1].offers).toEqual([offer, act, message]);
    expect(list[1].facts).toEqual(facts);
    expect(list[2]).not.toHaveProperty("offers");
    expect(list[2]).not.toHaveProperty("facts");
    expect(list[0]).not.toHaveProperty("offers");
    db.close();
  });

  it("keeps the files the loop read (ADR 0087) with what it did", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteAgentInsightStore(db);
    await store.appendTalk([{ ...found, loop: { searches: 2, read: 1, files: 1 } }]);
    const [entry] = await store.listTalk(null, 10);
    expect(entry).toMatchObject({ loop: { searches: 2, read: 1, files: 1 } });
    db.close();
  });

  it("is added by migration 47 to a store from before it; its old answers have none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v46-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 46)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    old
      .prepare(
        "INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, quotes_json, runtime_name, model, threads, query, hits_json) VALUES (NULL, 1, 'agent', 'found', 'Old answer', '[]', 'R', 'm', 1, 'offer', '[]')",
      )
      .run();
    expect(schemaVersion(old)).toBe(46);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(47);
    const store = new SqliteAgentInsightStore(db);
    await store.appendTalk([{ ...found, atMs: 7, offers: [offer], facts }]);
    const list = await store.listTalk(null, 10);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ text: "Old answer" });
    expect(list[0]).not.toHaveProperty("offers");
    expect(list[0]).not.toHaveProperty("facts");
    expect(list[1]).toMatchObject({ offers: [offer], facts });
    db.close();
  });
});
