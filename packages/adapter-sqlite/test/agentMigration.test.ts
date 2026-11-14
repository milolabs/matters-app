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
  SqliteAgentInsightStore,
  SqliteMessageStore,
  schemaVersion,
  THREAD_MEMBERS_SQL,
  THREAD_WALK_SQL,
  UNKNOWN_AUTOMATED_SQL,
} from "../src/index.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("upgrade from schema 22 (ADR 0051, 0052)", () => {
  it("is the latest, after the forward migration", () => {
    expect(MIGRATIONS.map((m) => m.version).slice(-5)).toEqual([52, 53, 54, 55, 56]);
    expect(LATEST_SCHEMA_VERSION).toBe(56);
  });

  it("keeps the mail with the flag not known, adds the agent tables empty, and learns the flag on a later upsert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v22-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 22)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const docs = [
      makeDocument({ subject: "Old one", providerId: "p1" }, "old"),
      makeDocument({ subject: "Old two", providerId: "p2" }, "older"),
    ];
    await upsertOnOldSchema(
      old,
      docs.map((d) => d.message),
    );
    expect(schemaVersion(old)).toBe(22);
    expect(
      (old.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name),
    ).not.toContain("automated");
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    // Not rewritten: every old row is NULL, which means not known.
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE automated IS NULL").get()).toEqual({
      n: 2,
    });
    for (const table of [
      "agent_analyses",
      "agent_prepared",
      "agent_feedback",
      "agent_journal",
      "agent_ledger",
      "agent_consents",
      "agent_runtime_records",
    ]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    db.close();

    const storage = createSqliteStorage(path);
    try {
      const keys = docs.map((d) => d.message.key);
      const before = await storage.store.getByKeys(keys);
      expect(before.map((m) => "automated" in m)).toEqual([false, false]);
      expect((await storage.agentSettings.get()).enabled).toBe(false);
      await storage.store.upsertMessages([{ ...docs[0]?.message, automated: true } as never]);
      const after = await storage.store.getByKeys(keys);
      expect(after.map((m) => m.automated)).toEqual([true, undefined]);
    } finally {
      storage.close();
    }
  });
});

describe("upgrade from schema 24 (ADR 0054)", () => {
  it("rebuilds agent_feedback to allow closed, keeping rows, ids and the id counter", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v24-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 24)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const insert = old.prepare(
      "INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms, until_ms) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("t1", 10, "anna@northwind.example", "notImportant", 5, null);
    insert.run("t2", 4, "bob@example.com", "later", 3, 99);
    insert.run("t3", 1, "carol@example.com", "later", 2, 50);
    old.prepare("DELETE FROM agent_feedback WHERE thread_id = 't3'").run();
    expect(() => insert.run("t4", 1, "dan@example.com", "closed", 1, null)).toThrow();
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        db
          .prepare("SELECT id, thread_id, kind, until_ms, reason FROM agent_feedback ORDER BY id")
          .all(),
      ).toEqual([
        { id: 1, thread_id: "t1", kind: "notImportant", until_ms: null, reason: null },
        { id: 2, thread_id: "t2", kind: "later", until_ms: 99, reason: null },
      ]);
      db.prepare(
        "INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms, reason) VALUES ('t5', 1, 'x@example.com', 'closed', 7, 'An automatic notification')",
      ).run();
      // The counter of the deleted third row is kept, so its id is not handed out again.
      expect(
        db.prepare("SELECT id, reason FROM agent_feedback WHERE thread_id = 't5'").get(),
      ).toEqual({
        id: 4,
        reason: "An automatic notification",
      });
      expect(() =>
        db
          .prepare(
            "INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms) VALUES ('t6', 1, 'x@example.com', 'other', 7)",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("upgrade from schema 25 (ADR 0054, rule 6)", () => {
  it("backfills the journal from feedback: agent when a reason was given, the headline from the reading", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v25-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 25)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const analysis = old.prepare(
      `INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline,
                                   facts_json, stakes, confidence, analyzed_at_ms)
       VALUES (?, ?, 1, 'onYou', ?, '[]', 'none', 0.9, 1)`,
    );
    analysis.run("t1", 10, "Pay the invoice");
    analysis.run("t2", 4, "Old reading");
    analysis.run("t2", 5, "A newer reading");
    const insert = old.prepare(
      "INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms, until_ms, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("t1", 10, "anna@northwind.example", "notImportant", 5, null, null);
    insert.run("t2", 4, "bob@example.com", "later", 3, 99, null);
    insert.run("t3", 1, "carol@example.com", "closed", 2, null, "An automatic notification");
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            `SELECT at_ms, action, actor, thread_id, last_message_key, sender_address, headline,
                    words, reason, until_ms, undone_at_ms FROM agent_journal ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          at_ms: 5,
          action: "notImportant",
          actor: "person",
          thread_id: "t1",
          last_message_key: 10,
          sender_address: "anna@northwind.example",
          headline: "Pay the invoice",
          words: null,
          reason: null,
          until_ms: null,
          undone_at_ms: null,
        },
        {
          at_ms: 3,
          action: "later",
          actor: "person",
          thread_id: "t2",
          last_message_key: 4,
          sender_address: "bob@example.com",
          headline: "Old reading",
          words: null,
          reason: null,
          until_ms: 99,
          undone_at_ms: null,
        },
        {
          at_ms: 2,
          action: "closed",
          actor: "agent",
          thread_id: "t3",
          last_message_key: 1,
          sender_address: "carol@example.com",
          headline: null,
          words: null,
          reason: "An automatic notification",
          until_ms: null,
          undone_at_ms: null,
        },
      ]);
      // Removal by thread is an index lookup.
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN DELETE FROM agent_journal WHERE thread_id IN (SELECT value FROM json_each(?))",
          )
          .all("[]") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toContain("agent_journal_thread");
      expect(() =>
        db
          .prepare(
            "INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address) VALUES (1, 'other', 'person', 't', 1, 'a')",
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address) VALUES (1, 'closed', 'robot', 't', 1, 'a')",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("the candidates query (ADR 0012)", () => {
  function plan(sql: string, ...params: (string | number)[]): string {
    const db = openDatabase(":memory:");
    try {
      return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((r) => r.detail)
        .join("\n");
    } finally {
      db.close();
    }
  }

  it("walks the partial index of visible messages from a key, with no sort and no table scan", () => {
    const text = plan(THREAD_WALK_SQL, 0);
    expect(text).toContain("messages_visible");
    expect(text).not.toMatch(/SCAN m(?! USING)/);
    expect(text).not.toMatch(/TEMP B-TREE/);
    expect(text).toMatch(/key>\?/);
  });

  it("reads the members of the threads found from the thread index", () => {
    const text = plan(THREAD_MEMBERS_SQL, "[]");
    expect(text).toContain("messages_thread");
    expect(text).toMatch(/SEARCH m USING INDEX messages_thread/);
    expect(text).not.toMatch(/SCAN m(?! USING)/);
  });
});

describe("upgrade from schema 26 (ADR 0054, rule 7)", () => {
  it("keeps the journal lines and ids, lets rule lines have no thread, and adds the rules table", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v26-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 26)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const insert = old.prepare(
      `INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address,
                                  headline, words, reason, until_ms, undone_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(5, "closed", "agent", "t1", 10, "a@x.com", "Notice", "nie odpisuj", "Why", null, 9);
    insert.run(6, "later", "person", "t2", 4, "b@x.com", null, null, null, 99, null);
    insert.run(7, "notImportant", "person", "t3", 1, "c@x.com", null, null, null, null, null);
    old.prepare("DELETE FROM agent_journal WHERE id = 3").run();
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            `SELECT id, at_ms, action, actor, thread_id, last_message_key, sender_address, headline,
                    words, reason, until_ms, undone_at_ms, rule_id, subject
               FROM agent_journal ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 1,
          at_ms: 5,
          action: "closed",
          actor: "agent",
          thread_id: "t1",
          last_message_key: 10,
          sender_address: "a@x.com",
          headline: "Notice",
          words: "nie odpisuj",
          reason: "Why",
          until_ms: null,
          undone_at_ms: 9,
          rule_id: null,
          subject: null,
        },
        {
          id: 2,
          at_ms: 6,
          action: "later",
          actor: "person",
          thread_id: "t2",
          last_message_key: 4,
          sender_address: "b@x.com",
          headline: null,
          words: null,
          reason: null,
          until_ms: 99,
          undone_at_ms: null,
          rule_id: null,
          subject: null,
        },
      ]);
      // A rule line has no thread, and the counter of the deleted third row is not reused.
      db.prepare(
        "INSERT INTO agent_journal (at_ms, action, actor, rule_id, subject) VALUES (8, 'ruleAdded', 'person', 1, 'a@x.com')",
      ).run();
      expect(
        db.prepare("SELECT id, thread_id FROM agent_journal WHERE action = 'ruleAdded'").get(),
      ).toEqual({ id: 4, thread_id: null });
      expect(() =>
        db
          .prepare("INSERT INTO agent_journal (at_ms, action, actor) VALUES (1, 'other', 'person')")
          .run(),
      ).toThrow();
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN DELETE FROM agent_journal WHERE thread_id IN (SELECT value FROM json_each(?))",
          )
          .all("[]") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toContain("agent_journal_thread");

      expect(db.prepare("SELECT count(*) AS n FROM agent_rules").get()).toEqual({ n: 0 });
      const rule = db.prepare(
        "INSERT INTO agent_rules (scope, subject, action, actor, at_ms, removed_at_ms) VALUES (?, ?, 'noReply', 'person', 1, ?)",
      );
      rule.run("sender", "a@x.com", null);
      expect(() => rule.run("sender", "a@x.com", null)).toThrow();
      // A removed rule does not block adding the same one again.
      rule.run("sender", "b@x.com", 5);
      rule.run("sender", "b@x.com", null);
      expect(() => rule.run("other", "c@x.com", null)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("upgrade from schema 27 (ADR 0054, rule 7)", () => {
  it("keeps the journal and the ledger as they were, and adds instructions and the new kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v27-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 27)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const journal = old.prepare(
      `INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address,
                                  headline, words, reason, until_ms, undone_at_ms, rule_id, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    journal.run(
      5,
      "closed",
      "agent",
      "t1",
      10,
      "a@x.com",
      "Notice",
      "nie odpisuj",
      "Why",
      null,
      9,
      null,
      null,
    );
    journal.run(
      6,
      "ruleAdded",
      "person",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      "a@x.com",
    );
    journal.run(7, "later", "person", "t2", 4, "b@x.com", null, null, null, 99, null, null, null);
    old.prepare("DELETE FROM agent_journal WHERE id = 3").run();
    const ledger = old.prepare(
      "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (?, ?, ?, ?, ?)",
    );
    ledger.run(1, "claude-code", "acc1", "analysis", 3);
    ledger.run(2, "claude-code", "acc1", "prepare", 1);
    old.prepare("DELETE FROM agent_ledger WHERE id = 2").run();
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            `SELECT id, at_ms, action, actor, thread_id, headline, words, reason, undone_at_ms,
                    rule_id, subject, instruction_id
               FROM agent_journal ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 1,
          at_ms: 5,
          action: "closed",
          actor: "agent",
          thread_id: "t1",
          headline: "Notice",
          words: "nie odpisuj",
          reason: "Why",
          undone_at_ms: 9,
          rule_id: null,
          subject: null,
          instruction_id: null,
        },
        {
          id: 2,
          at_ms: 6,
          action: "ruleAdded",
          actor: "person",
          thread_id: null,
          headline: null,
          words: null,
          reason: null,
          undone_at_ms: null,
          rule_id: 1,
          subject: "a@x.com",
          instruction_id: null,
        },
      ]);
      // The counter of the deleted third row is not reused, and an instruction line is allowed.
      db.prepare(
        "INSERT INTO agent_journal (at_ms, action, actor, thread_id, instruction_id) VALUES (8, 'instructionAdded', 'agent', 't1', 1)",
      ).run();
      expect(db.prepare("SELECT max(id) AS id FROM agent_journal").get()).toEqual({ id: 4 });
      expect(() =>
        db
          .prepare("INSERT INTO agent_journal (at_ms, action, actor) VALUES (1, 'other', 'person')")
          .run(),
      ).toThrow();
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN DELETE FROM agent_journal WHERE thread_id IN (SELECT value FROM json_each(?))",
          )
          .all("[]") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toContain("agent_journal_thread");

      // The ledger kept its rows and its counter, takes `remember`, and still refuses others.
      expect(db.prepare("SELECT id, purpose, threads FROM agent_ledger ORDER BY id").all()).toEqual(
        [{ id: 1, purpose: "analysis", threads: 3 }],
      );
      db.prepare(
        "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (3, 'r', 'a', 'remember', 0)",
      ).run();
      expect(db.prepare("SELECT max(id) AS id FROM agent_ledger").get()).toEqual({ id: 3 });
      expect(() =>
        db
          .prepare(
            "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (3, 'r', 'a', 'other', 0)",
          )
          .run(),
      ).toThrow();
      const ledgerPlan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM agent_ledger ORDER BY at_ms DESC, id DESC LIMIT 5",
          )
          .all() as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(ledgerPlan).toContain("agent_ledger_recent");

      expect(db.prepare("SELECT count(*) AS n FROM agent_instructions").get()).toEqual({ n: 0 });
      const instruction = db.prepare(
        "INSERT INTO agent_instructions (scope, text, thread_id, actor, at_ms, removed_at_ms) VALUES (?, ?, ?, 'person', 1, ?)",
      );
      instruction.run("general", "Answer briefly", null, null);
      expect(() => instruction.run("general", "Answer briefly", null, null)).toThrow();
      // The same text for a thread, or for another scope, is another instruction.
      instruction.run("thread", "Answer briefly", "t1", null);
      expect(() => instruction.run("thread", "Answer briefly", "t1", null)).toThrow();
      instruction.run("thread", "Answer briefly", "t2", null);
      instruction.run("write", "Answer briefly", null, null);
      // A removed one does not block adding the same again.
      instruction.run("general", "Old", null, 5);
      instruction.run("general", "Old", null, null);
      expect(() => instruction.run("everywhere", "x", null, null)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("upgrade from schema 31 (ADR 0064, rule 3)", () => {
  it("keeps the ledger as it was, takes `talk`, and adds the talk table with its index", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v31-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 31)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const ledger = old.prepare(
      "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (?, 'r', 'a', ?, ?)",
    );
    ledger.run(1, "analysis", 3);
    ledger.run(2, "prepare", 1);
    expect(() => ledger.run(3, "talk", 1)).toThrow();
    expect(schemaVersion(old)).toBe(31);
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT id, purpose, threads FROM agent_ledger ORDER BY id").all()).toEqual(
        [
          { id: 1, purpose: "analysis", threads: 3 },
          { id: 2, purpose: "prepare", threads: 1 },
        ],
      );
      const next = db.prepare(
        "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (3, 'r', 'a', ?, 1)",
      );
      next.run("talk");
      expect(db.prepare("SELECT max(id) AS id FROM agent_ledger").get()).toEqual({ id: 3 });
      expect(() => next.run("other")).toThrow();
      const ledgerPlan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM agent_ledger ORDER BY at_ms DESC, id DESC LIMIT 5",
          )
          .all() as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(ledgerPlan).toContain("agent_ledger_recent");

      expect(db.prepare("SELECT count(*) AS n FROM agent_talk").get()).toEqual({ n: 0 });
      const talk = db.prepare(
        "INSERT INTO agent_talk (thread_id, at_ms, role, kind, text) VALUES (?, 1, ?, ?, 'x')",
      );
      // A talk of all mail has no thread; the roles and kinds are closed lists.
      talk.run(null, "you", null);
      talk.run("t1", "agent", "answer");
      expect(() => talk.run("t1", "someone", null)).toThrow();
      expect(() => talk.run("t1", "agent", "other")).toThrow();
      // The kind of an answer across all mail, with its query and hits, is there from the start.
      talk.run(null, "agent", "found");
      db.prepare(
        "INSERT INTO agent_talk (at_ms, role, text, query, hits_json) VALUES (1, 'you', 'x', 'q', '[]')",
      ).run();
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM agent_talk WHERE thread_id = 't1' ORDER BY id DESC",
          )
          .all() as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toContain("agent_talk_thread");
    } finally {
      db.close();
    }
  });
});

describe("upgrade from schema 33 (ADR 0066)", () => {
  function oldDatabase(): { path: string; old: DatabaseSync } {
    const dir = mkdtempSync(join(tmpdir(), "matters-v33-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 33)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    return { path, old };
  }

  it("adds the reading to analyses and the meaning to feedback without rebuilding either", () => {
    const { path, old } = oldDatabase();
    old
      .prepare(
        `INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline,
                                     facts_json, stakes, confidence, analyzed_at_ms)
         VALUES ('t1', 5, 3, 'onYou', 'h', '[]', 'none', 0.9, 1)`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms)
         VALUES ('t1', 5, 'a@northwind.example', 'closed', 1)`,
      )
      .run();
    expect(schemaVersion(old)).toBe(33);
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // Old rows read as nothing said; ids and rows are as they were.
      expect(
        db.prepare("SELECT thread_id, intent, reading_json FROM agent_analyses").all(),
      ).toEqual([{ thread_id: "t1", intent: null, reading_json: null }]);
      expect(
        db.prepare("SELECT id, outcome, case_key, amount_value FROM agent_feedback").all(),
      ).toEqual([{ id: 1, outcome: null, case_key: null, amount_value: null }]);
      // No CHECK: a newer build's values are stored, and read as absent by this one.
      db.prepare(
        `INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms, outcome)
         VALUES ('t2', 1, 'b@northwind.example', 'closed', 2, 'somethingNew')`,
      ).run();
      db.prepare(
        `INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline,
                                     facts_json, stakes, confidence, analyzed_at_ms, intent, reading_json)
         VALUES ('t3', 1, 4, 'fyi', 'h', '[]', 'none', 0.9, 1, 'teleport', '{"status":"vanished"}')`,
      ).run();
    } finally {
      db.close();
    }

    const storage = createSqliteStorage(path);
    return (async () => {
      try {
        // A value this build does not know reads as absent.
        const feedback = await storage.agent.listFeedback();
        expect(feedback.map((f) => f.outcome)).toEqual([undefined, undefined]);
      } finally {
        storage.close();
      }
    })();
  });
});

describe("upgrade from schema 34 (ADR 0066, rule 6)", () => {
  it("indexes the messages that do not know if they are automated, and nothing else", async () => {
    const db = openDatabase(":memory:");
    try {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_automated_unknown'")
        .get() as { sql: string };
      expect(row.sql).toMatch(/WHERE automated IS NULL/);
      const text = (
        db.prepare(`EXPLAIN QUERY PLAN ${UNKNOWN_AUTOMATED_SQL}`).all("acc1", "INBOX", "1", 50) as {
          detail: string;
        }[]
      )
        .map((p) => p.detail)
        .join("\n");
      expect(text).toMatch(/SEARCH m USING (COVERING )?INDEX messages_automated_unknown/);
      expect(text).toMatch(/SEARCH l USING (COVERING )?INDEX message_locations_message/);
      expect(text).not.toMatch(/SCAN/);
      expect(text).not.toMatch(/TEMP B-TREE/);
    } finally {
      db.close();
    }
  });

  it("reads nothing once every message knows", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteMessageStore(db);
      const docs = Array.from({ length: 30 }, (_, i) =>
        makeDocument({ providerId: `p${i}`, automated: i % 2 === 0 }, "x"),
      );
      await store.upsertMessages(docs.map((d) => d.message));
      const left = db
        .prepare(
          "SELECT count(*) AS n FROM messages INDEXED BY messages_automated_unknown WHERE automated IS NULL",
        )
        .get() as { n: number };
      expect(left.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("upgrade from schema 35 (ADR 0068, rule 3)", () => {
  it("rebuilds agent_rules to allow a kind of mail, keeping rows, ids, the counter and the unique index", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v35-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 35)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const add = old.prepare(
      "INSERT INTO agent_rules (scope, subject, action, actor, words, at_ms, removed_at_ms) VALUES (?, ?, 'noReply', ?, ?, 5, ?)",
    );
    add.run("sender", "anna@northwind.example", "person", null, null);
    add.run("domain", "shop.example", "agent", "never again", 9);
    add.run("type", "programLike", "person", null, null);
    // A rule that was added, removed and added again: the counter has gone past the rows.
    old.prepare("DELETE FROM agent_rules WHERE id = 3").run();
    expect(() => add.run("category", "offer", "person", null, null)).toThrow();
    expect(schemaVersion(old)).toBe(35);
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT id, scope, subject, actor, words, removed_at_ms FROM agent_rules ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: 1,
          scope: "sender",
          subject: "anna@northwind.example",
          actor: "person",
          words: null,
          removed_at_ms: null,
        },
        {
          id: 2,
          scope: "domain",
          subject: "shop.example",
          actor: "agent",
          words: "never again",
          removed_at_ms: 9,
        },
      ]);
      const next = db.prepare(
        "INSERT INTO agent_rules (scope, subject, action, actor, at_ms) VALUES (?, ?, 'noReply', 'person', 7)",
      );
      next.run("category", "offer");
      // The counter was carried over: the id after the deleted 3 is 4, never 3 again.
      expect(db.prepare("SELECT max(id) AS id FROM agent_rules").get()).toEqual({ id: 4 });
      expect(() => next.run("mood", "x")).toThrow();
      // One active rule per scope and subject; a removed one can be added again.
      expect(() => next.run("category", "offer")).toThrow();
      expect(() => next.run("domain", "shop.example")).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("rows of the reading of an earlier version (ADR 0117, rule 8)", () => {
  it("are kept by the schema, and removed with the mail they belong to", async () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare(
        `INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline,
                                     facts_json, stakes, confidence, analyzed_at_ms)
         VALUES ('t1', 5, 4, 'onYou', 'h', '[]', 'none', 0.9, 1), ('t2', 5, 4, 'fyi', 'h', '[]', 'none', 0.9, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO agent_prepared (thread_id, last_message_key, work_json, prepared_at_ms)
         VALUES ('t1', 5, '{"kind":"draft","body":"b","nudge":false}', 1)`,
      ).run();
      await new SqliteAgentInsightStore(db).removeForThreads(["t1"]);
      expect(db.prepare("SELECT thread_id FROM agent_analyses").all()).toEqual([
        { thread_id: "t2" },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM agent_prepared").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

describe("migration 56: the ledger names a theme turn (ADR 0134, rule 15)", () => {
  it("keeps every line with its id, effort and counter, takes `appearance`, and refuses others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v55-ledger-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 55)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const line = old.prepare(
      "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads, effort) VALUES (?, 'r', 'a', ?, ?, ?)",
    );
    line.run(1, "prompt", 4, "low");
    line.run(2, "prepare", 1, null);
    line.run(3, "talk", 1, "high");
    old.prepare("DELETE FROM agent_ledger WHERE id = 3").run();
    expect(() => line.run(4, "appearance", 0, null)).toThrow();
    old.close();

    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        db.prepare("SELECT id, purpose, threads, effort FROM agent_ledger ORDER BY id").all(),
      ).toEqual([
        { id: 1, purpose: "prompt", threads: 4, effort: "low" },
        { id: 2, purpose: "prepare", threads: 1, effort: null },
      ]);
      // Through the store, as the service writes it: no account and no thread went.
      const store = new SqliteAgentInsightStore(db);
      await store.appendLedger([
        {
          atMs: 5,
          runtimeId: "codex",
          accountId: "",
          purpose: "appearance",
          threads: 0,
          effort: "high",
        },
      ]);
      expect((await store.listLedger(1))[0]).toEqual({
        atMs: 5,
        runtimeId: "codex",
        accountId: "",
        purpose: "appearance",
        threads: 0,
        effort: "high",
      });
      // The counter of the deleted third line is not reused.
      expect(db.prepare("SELECT max(id) AS id FROM agent_ledger").get()).toEqual({ id: 4 });
      expect(() =>
        db
          .prepare(
            "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (6, 'r', 'a', 'other', 0)",
          )
          .run(),
      ).toThrow();
      const plan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM agent_ledger ORDER BY at_ms DESC, id DESC LIMIT 5",
          )
          .all() as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toContain("agent_ledger_recent");
    } finally {
      db.close();
    }
  });
});
