import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseQuery } from "@matters/core";
import { makeDocument, makeMessage, person } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Database,
  MIGRATIONS,
  openDatabase,
  SqliteMessageStore,
  SqliteSearchIndex,
  schemaVersion,
} from "../src/index.ts";
import { LONG_TERM_MARK } from "../src/searchPlan.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memory() {
  const db = openDatabase(":memory:");
  dbs.push(db);
  const store = new SqliteMessageStore(db);
  const index = new SqliteSearchIndex(db);
  const add = async (overrides: Parameters<typeof makeDocument>[0], body = "") => {
    const doc = makeDocument(overrides, body);
    await store.upsertMessages([doc.message]);
    await index.indexMessages([doc]);
    return doc.message.key;
  };
  const find = (q: string, limit = 50) => index.search(parseQuery(q), { limit });
  const terms = () =>
    (db.prepare("SELECT term FROM message_terms ORDER BY term").all() as { term: string }[]).map(
      (r) => r.term,
    );
  return { db, store, index, add, find, terms };
}

describe("upgrade from schema 10 (ADR 0025)", () => {
  it("backfills the terms of mail that is already indexed, so its prefixes are found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v10-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    // A database as the previous build left it: migrations 1..10, documents in store and index.
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 10)) {
      old.exec(m.sql);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const long = "z".repeat(40);
    const docs = [
      makeDocument(
        { subject: "Faktura marzec", from: person("Jan", "jan@example.com") },
        "fakturowanie",
      ),
      makeDocument({ subject: "Umowa o dzieło" }, `zażółć gęślą jaźń ${long}`),
      makeDocument({ subject: "abc xy" }, "short words"),
    ];
    await upsertOnOldSchema(
      old,
      docs.map((d) => d.message),
    );
    const insert = old.prepare(
      "INSERT INTO message_fts (rowid, sender, recipients, cc, subject, body) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const fold = (t: string) =>
      t.normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l").toLowerCase();
    for (const d of docs) {
      insert.run(
        d.message.key,
        fold(`${d.message.from.name ?? ""} ${d.message.from.address}`),
        "me example com",
        "",
        fold(d.message.subject),
        fold(d.bodyText),
      );
    }
    expect(schemaVersion(old)).toBe(10);
    old.close();

    const db = openDatabase(path);
    dbs.push(db);
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(11);
    const terms = (db.prepare("SELECT term FROM message_terms").all() as { term: string }[]).map(
      (r) => r.term,
    );
    expect(terms).toEqual(
      expect.arrayContaining([
        "faktura",
        "fakturowanie",
        "marzec",
        "zazolc",
        "gesla",
        `${long.slice(0, 32)}${LONG_TERM_MARK}`,
      ]),
    );
    expect(terms).not.toContain(long);
    expect(
      db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name = 'message_vocab'").get(),
    ).toBeUndefined();

    const index = new SqliteSearchIndex(db);
    const find = (q: string) => index.search(parseQuery(q), { limit: 10 });
    const key = (i: number) => (docs[i] as (typeof docs)[number]).message.key;
    expect(await find("faktu")).toEqual([key(0)]);
    expect(await find("subject:fakt")).toEqual([key(0)]);
    expect(await find("from:janek")).toEqual([]);
    expect(await find("zazol")).toEqual([key(1)]);
    expect(await find("marz -umow")).toEqual([key(0)]);
    expect(await find("zzzzzzzzzzzz")).toEqual([key(1)]); // under a longer word: native fallback
    expect(await find("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toEqual([key(1)]);
    // Mail indexed after the upgrade is found through the same table.
    const later = makeDocument({ subject: "fakturka nowa" });
    await new SqliteMessageStore(db).upsertMessages([later.message]);
    await index.indexMessages([later]);
    expect(await find("faktu")).toEqual([later.message.key, key(0)]);
  });
});

describe("terms of the index", () => {
  it("holds the words of 4+ characters of every column, and only marked heads of long ones", async () => {
    const t = memory();
    await t.add(
      {
        subject: "Faktura",
        from: person("Zażółć Gęślą", "jan@example.com"),
        to: [person("", "odbiorca@firma.pl")],
        cc: [person("Dorota", "dorota@acme.org")],
      },
      `treść listu ${"q".repeat(33)}`,
    );
    const terms = t.terms();
    for (const w of [
      "faktura",
      "zazolc",
      "gesla",
      "example",
      "odbiorca",
      "firma",
      "dorota",
      "acme",
      "tresc",
      "listu",
    ]) {
      expect(terms, w).toContain(w);
    }
    for (const w of ["jan", "com", "pl", "org"]) expect(terms, w).not.toContain(w);
    expect(terms).toContain(`${"q".repeat(32)}${LONG_TERM_MARK}`);
    expect(terms.every((x) => x.length <= 32 + LONG_TERM_MARK.length)).toBe(true);
  });

  it("finds a prefix in the column a filter names, and not in the others", async () => {
    const t = memory();
    const a = await t.add(
      { subject: "kolokwium", from: person("Adam", "adam@example.com") },
      "treść",
    );
    const b = await t.add(
      { subject: "inny temat", from: person("Kolokwiusz", "k@example.com") },
      "treść",
    );
    expect(await t.find("kolokw")).toEqual([b, a]);
    expect(await t.find("subject:kolokw")).toEqual([a]);
    expect(await t.find("from:kolokw")).toEqual([b]);
    expect(await t.find("to:kolokw")).toEqual([]);
    expect(await t.find("subject:(kolokw OR inn)")).toEqual([b, a]);
  });

  it("negates an expanded prefix", async () => {
    const t = memory();
    const a = await t.add({ subject: "faktura marzec" });
    const b = await t.add({ subject: "umowa marzec" });
    const c = await t.add({ subject: "fakturowanie kwiecień" });
    expect(await t.find("marzec -faktu")).toEqual([b]);
    expect(await t.find("-faktu")).toEqual([b]);
    expect(await t.find("-faktu OR umow")).toEqual([b]);
    expect([a, c].length).toBe(2);
  });

  it("finds a word added by a later batch, and survives deletion of the mail", async () => {
    const t = memory();
    const a = await t.add({ subject: "kontrakt" });
    expect(await t.find("kontr")).toEqual([a]);
    expect(await t.find("kontra")).toEqual([a]);
    const b = await t.add({ subject: "kontraktowy aneks" });
    expect(await t.find("kontra")).toEqual([b, a]);
    await t.index.removeMessages([a]);
    expect(await t.find("kontra")).toEqual([b]);
    await t.index.removeMessages([b]);
    // The stale terms stay, and match nothing.
    expect(t.terms()).toContain("kontrakt");
    expect(await t.find("kontra")).toEqual([]);
  });

  it("serves a prefix beside a longer word, and one wider than the expansion cap", async () => {
    const t = memory();
    const keys: number[] = [];
    for (let i = 0; i < 70; i++) keys.push(await t.add({ subject: `katalog${i}x wspólny` }));
    const long = await t.add({ subject: `katalog${"b".repeat(40)}` });
    const all = [long, ...keys.slice().reverse()];
    expect(await t.find("katalog", 100)).toEqual(all); // 71 forms: native
    expect(await t.find("katalog1", 100)).toEqual(
      all.filter((k) => keys.indexOf(k) >= 0 && String(keys.indexOf(k)).startsWith("1")),
    );
    expect(await t.find(`katalog${"b".repeat(10)}`)).toEqual([long]);
    expect(await t.find(`katalog${"b".repeat(40)}`)).toEqual([long]);
    expect(await t.find(`katalog${"b".repeat(41)}`)).toEqual([]);
  });

  it("is committed with the documents, or not at all", async () => {
    const t = memory();
    const doc = makeDocument({ subject: "nieudana transakcja" });
    await t.store.upsertMessages([doc.message]);
    await expect(
      t.index.indexMessages([
        doc,
        { message: { ...makeMessage(), subject: "x" }, bodyText: "" },
        null as never,
      ]),
    ).rejects.toThrow();
    expect(t.terms()).not.toContain("nieudana");
    expect(await t.find("nieud")).toEqual([]);
  });
});
