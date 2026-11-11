import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_VIEWS, parseQuery } from "@matters/core";
import { asStored, makeDocument } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  schemaVersion,
} from "../src/index.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("upgrade from schema 11 (ADR 0027)", () => {
  it("keeps the mail, the index and the drafts, and adds saved_views with the starter views", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v11-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 11)) {
      old.exec(m.sql);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const doc = makeDocument({ subject: "Faktura marzec" }, "fakturowanie");
    await upsertOnOldSchema(old, [doc.message]);
    old
      .prepare(
        "INSERT INTO message_fts (rowid, sender, recipients, cc, subject, body) VALUES (?, '', '', '', 'faktura marzec', 'fakturowanie')",
      )
      .run(doc.message.key);
    expect(schemaVersion(old)).toBe(11);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();

    const storage = createSqliteStorage(path);
    try {
      expect((await storage.views.list()).map((v) => v.name)).toEqual([
        "Inbox",
        "Unread",
        "Starred",
        "Attachments",
      ]);
      for (const v of await storage.views.list()) await storage.views.remove(v.id);
      expect(await storage.store.getByKeys([doc.message.key])).toEqual([asStored(doc.message)]);
      expect(await storage.index.search(parseQuery("faktura"), { limit: 5 })).toEqual([
        doc.message.key,
      ]);
      const view = {
        id: "v1",
        name: "Invoices",
        query: "faktura",
        position: 0,
        createdMs: 1,
        updatedMs: 1,
      };
      await storage.views.put(view);
      // The reader connection sees the committed view.
      expect(await storage.read.views.list()).toEqual([view]);
    } finally {
      storage.close();
    }
  });
});

describe("starter views (ADR 0029)", () => {
  /** A database at schema 13 holding the given views, upgraded on open. */
  function upgradedWith(views: readonly (readonly [string, number])[]) {
    const dir = mkdtempSync(join(tmpdir(), "matters-v13-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 13)) {
      old.exec(m.sql);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    for (const [name, position] of views) {
      old
        .prepare("INSERT INTO saved_views VALUES (?, ?, 'x', ?, 1, 1)")
        .run(`own-${position}`, name, position);
    }
    old.close();
    return path;
  }

  it("come after the views already there, and a taken name is left alone", async () => {
    const storage = createSqliteStorage(
      upgradedWith([
        ["Invoices", 0],
        ["UNREAD", 4],
      ]),
    );
    try {
      const list = await storage.views.list();
      // Inbox (ADR 0044) goes first and moves the rest down by one.
      expect(list.map((v) => [v.name, v.position])).toEqual([
        ["Inbox", 0],
        ["Invoices", 1],
        ["UNREAD", 5],
        ["Starred", 6],
        ["Attachments", 7],
      ]);
      expect(list.find((v) => v.name === "UNREAD")?.query).toBe("x");
    } finally {
      storage.close();
    }
  });

  it("do not go over the limit", async () => {
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => [`v${i}`, i] as const);
    const storage = createSqliteStorage(upgradedWith(full));
    try {
      expect(await storage.views.list()).toHaveLength(MAX_VIEWS);
    } finally {
      storage.close();
    }
  });

  it("stay deleted when the database is opened again", async () => {
    const path = upgradedWith([]);
    const first = createSqliteStorage(path);
    await first.views.remove("starter-unread");
    first.close();
    const second = createSqliteStorage(path);
    try {
      expect((await second.views.list()).map((v) => v.name)).toEqual([
        "Inbox",
        "Starred",
        "Attachments",
      ]);
    } finally {
      second.close();
    }
  });
});
