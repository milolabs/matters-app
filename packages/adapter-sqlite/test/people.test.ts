import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeAccount, tokenize } from "@matters/core";
import { makeDocument, makeMessage, person } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  MIGRATIONS,
  openDatabase,
  SqliteSearchIndex,
  schemaVersion,
} from "../src/index.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const day = (n: number) => Date.UTC(2024, 2, n, 12);

describe("upgrade from schema 12 (ADR 0028)", () => {
  it("backfills people from the participants of stored mail, which can then be suggested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v12-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 12)) {
      old.exec(m.sql);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const docs = [
      makeDocument({
        dateMs: day(1),
        from: person("Jan", "Jan@Lodz.pl"),
        to: [person("Łukasz Żółć", "lukasz@zrodlo.pl")],
      }),
      makeDocument({
        dateMs: day(2),
        from: person("Jan Kowalski", "jan@lodz.pl"),
        cc: [{ address: "anna@example.com" }],
      }),
      makeDocument({
        dateMs: day(3),
        from: { address: "jan@lodz.pl" },
        to: [person("Łukasz Żółć", "lukasz@zrodlo.pl"), { address: "" }],
      }),
    ];
    await upsertOnOldSchema(
      old,
      docs.map((d) => d.message),
    );
    for (const { message: m } of docs) {
      const folded = (ps: readonly { name?: string; address: string }[]) =>
        tokenize(ps.map((p) => `${p.name ?? ""} ${p.address}`).join(" ")).join(" ");
      old
        .prepare(
          "INSERT INTO message_fts (rowid, sender, recipients, cc, subject, body) VALUES (?, ?, ?, ?, '', '')",
        )
        .run(m.key, folded([m.from]), folded(m.to), folded(m.cc));
    }
    expect(schemaVersion(old)).toBe(12);
    old.close();

    const storage = createSqliteStorage(path);
    try {
      expect(await storage.index.suggest("j", 5)).toEqual([
        { address: "jan@lodz.pl", name: "Jan Kowalski", count: 3 },
      ]);
      expect(await storage.index.suggest("zol", 5)).toEqual([
        { address: "lukasz@zrodlo.pl", name: "Łukasz Żółć", count: 2 },
      ]);
      expect(await storage.read.people.suggest("anna", 5)).toEqual([
        { address: "anna@example.com", count: 1 },
      ]);
      // Same answer as an index built message by message.
      const fresh = createSqliteStorage(":memory:");
      try {
        await fresh.store.upsertMessages(docs.map((d) => d.message));
        await fresh.index.indexMessages(docs);
        for (const q of ["j", "l", "anna", "zol", "pl"]) {
          expect(await storage.index.suggest(q, 9), q).toEqual(await fresh.index.suggest(q, 9));
        }
      } finally {
        fresh.close();
      }
    } finally {
      storage.close();
    }
  });
});

describe("people are written with the documents", () => {
  it("leaves nothing behind when the batch fails", async () => {
    const db = openDatabase(":memory:");
    const index = new SqliteSearchIndex(db);
    // Terms are written after people, so this fails the batch once the people are in.
    db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON message_terms BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const doc = makeDocument(
      { from: person("Jan Kowalski", "jan@lodz.pl"), subject: "Faktura marzec" },
      "text",
    );
    await expect(index.indexMessages([doc])).rejects.toThrow("boom");
    for (const table of ["people", "people_words", "message_terms"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(await index.suggest("jan", 5)).toEqual([]);
    db.exec("DROP TRIGGER boom");
    await index.indexMessages([doc]);
    expect(await index.suggest("jan", 5)).toHaveLength(1);
    db.close();
  });

  it("adds words only for new or renamed people", async () => {
    const db = openDatabase(":memory:");
    const index = new SqliteSearchIndex(db);
    const words = () =>
      (db.prepare("SELECT word FROM people_words ORDER BY word").all() as { word: string }[]).map(
        (r) => r.word,
      );
    await index.indexMessages([
      makeDocument({ dateMs: day(1), from: person("Jan", "jan@lodz.pl"), to: [] }),
    ]);
    expect(words()).toEqual(["jan", "lodz", "pl"]);
    await index.indexMessages([
      makeDocument({ dateMs: day(2), from: person("Jan Kowalski", "jan@lodz.pl"), to: [] }),
    ]);
    expect(words()).toEqual(["jan", "kowalski", "lodz", "pl"]);
    db.close();
  });

  it("keeps at most 16 words per person", async () => {
    const db = openDatabase(":memory:");
    const index = new SqliteSearchIndex(db);
    const name = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    await index.indexMessages([makeDocument({ from: person(name, "x@y.zz"), to: [] })]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM people_words").get()).toEqual({ n: 16 });
    db.close();
  });

  it("deduplicates a batch: one row per address, the count of its messages", async () => {
    const db = openDatabase(":memory:");
    const index = new SqliteSearchIndex(db);
    await index.indexMessages([
      makeDocument({ dateMs: day(1), from: person("Jan", "jan@lodz.pl"), to: [] }),
      makeDocument({
        dateMs: day(3),
        from: person("Jan K", "JAN@lodz.pl"),
        to: [person("", "jan@lodz.pl")],
      }),
      makeDocument({ dateMs: day(2), from: person("Johnny", "jan@lodz.pl"), to: [] }),
    ]);
    expect(db.prepare("SELECT address, name, count, last_ms FROM people").all()).toEqual([
      { address: "jan@lodz.pl", name: "Jan K", count: 3, last_ms: day(3) },
    ]);
    db.close();
  });

  it("is served by the reader connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-people-"));
    dirs.push(dir);
    const storage = createSqliteStorage(join(dir, "mail.db"));
    try {
      const m = makeMessage({ from: person("Jan Kowalski", "jan@lodz.pl") });
      await storage.store.upsertMessages([m]);
      await storage.index.indexMessages([{ message: m, bodyText: "" }]);
      expect(await storage.read.people.suggest("kowal", 3)).toEqual([
        { address: "jan@lodz.pl", name: "Jan Kowalski", count: 1 },
      ]);
    } finally {
      storage.close();
    }
  });

  it("stops suggesting the people of a removed account, and keeps the others", async () => {
    const storage = createSqliteStorage(":memory:");
    try {
      const docs = [
        makeDocument({ accountId: "a1", from: person("Jan Kowalski", "jan@lodz.pl"), to: [] }),
        makeDocument({ accountId: "a2", from: person("Jan Nowak", "jan.nowak@x.pl"), to: [] }),
      ];
      await storage.store.upsertMessages(docs.map((d) => d.message));
      await storage.index.indexMessages(docs);
      const jans = async () => (await storage.index.suggest("jan", 5)).map((p) => p.address);
      expect(await jans()).toHaveLength(2);
      await removeAccount({ ...storage, credentials: { delete: async () => {} } as never }, "a1");
      expect(await jans()).toEqual(["jan.nowak@x.pl"]);
    } finally {
      storage.close();
    }
  });
});
