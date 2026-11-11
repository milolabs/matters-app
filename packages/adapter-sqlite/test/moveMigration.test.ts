import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAILBOX_BIT, parseQuery } from "@matters/core";
import { makeDocument, makeLocation } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  NEWEST_VISIBLE_SQL,
  openDatabase,
  SELECT_VISIBLE_THREAD_SQL,
  schemaVersion,
} from "../src/index.ts";
import { buildSql, type Param, planQuery, VISIBLE_SQL } from "../src/searchPlan.ts";
import { upsertOnOldSchema } from "./oldSchema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A database at schema 20 holding mail from folders that the app has not listed yet. */
async function versionTwenty() {
  const dir = mkdtempSync(join(tmpdir(), "matters-v20-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  const old = new DatabaseSync(path);
  old.exec("PRAGMA journal_mode = WAL");
  old.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= 20)) {
    old.exec(m.sql);
    m.run?.(old);
    old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
  }
  const mail = [
    ["in", ["INBOX"]],
    ["gmail", ["inbox", "Praca"]],
    ["sent", ["Sent"]],
    ["wysl", ["Wysłane"]],
    ["bin", ["Trash"]],
    ["ad", ["Spam"]],
    ["clients", ["Clients"]],
    ["none", []],
  ] as const;
  const docs = mail.map(([id, labelIds], i) =>
    makeDocument(
      {
        providerId: id,
        threadId: `t-${id}`,
        dateMs: Date.UTC(2024, 0, i + 1),
        labelIds: [...labelIds],
      },
      `mail ${id}`,
    ),
  );
  await upsertOnOldSchema(
    old,
    docs.map((d) => d.message),
  );
  docs.forEach((d, i) => {
    old
      .prepare("INSERT INTO message_locations VALUES ('acc1', ?, '1', ?, ?)")
      .run(d.message.labelIds[0] ?? "INBOX", i + 1, d.message.key);
  });
  // Views the person made themselves, one of them in the first place.
  old.prepare("INSERT INTO saved_views VALUES ('own-1', 'Mine', 'from:anna', 0, 1, 1)").run();
  expect(schemaVersion(old)).toBe(20);
  old.close();
  return { path, docs };
}

describe("upgrade from schema 20 (ADR 0044)", () => {
  it("sets the mailboxes from the labels, hiding nothing that was not named Trash or Spam", async () => {
    const { path, docs } = await versionTwenty();
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const bits = new Map(
      (
        db.prepare("SELECT provider_id AS id, mailboxes AS bits FROM messages").all() as {
          id: string;
          bits: number;
        }[]
      ).map((r) => [r.id, r.bits]),
    );
    db.close();
    expect(Object.fromEntries(bits)).toEqual({
      in: MAILBOX_BIT.inbox,
      gmail: MAILBOX_BIT.inbox | MAILBOX_BIT.other,
      sent: MAILBOX_BIT.sent,
      // Until the first sync has listed the folders, a name that is not a system label is `other`.
      wysl: MAILBOX_BIT.other,
      bin: MAILBOX_BIT.trash,
      ad: MAILBOX_BIT.spam,
      clients: MAILBOX_BIT.other,
      none: 0,
    });

    const storage = createSqliteStorage(path);
    try {
      // All mail shows everything but what is named Trash or Spam; nothing else is hidden.
      const all = await storage.read.store.listNewest({ limit: 50 });
      expect(all.map((m) => m.providerId).sort()).toEqual(
        ["clients", "gmail", "in", "none", "sent", "wysl"].sort(),
      );
      expect(all).toHaveLength(docs.length - 2);
      // In the first sync the real roles arrive: the mail follows, and is announced.
      const seq = (await storage.store.changesSince(0)).changeSeq;
      const changed = await storage.store.setFolders("acc1", [
        { id: "INBOX", accountId: "acc1", name: "INBOX", role: "inbox", exclusive: true },
        { id: "Wysłane", accountId: "acc1", name: "Wysłane", role: "sent", exclusive: true },
        { id: "Clients", accountId: "acc1", name: "Clients", role: "trash", exclusive: true },
      ]);
      expect(changed).toHaveLength(2);
      expect([...(await storage.store.changesSince(seq)).changedKeys].sort()).toEqual(
        [...changed].sort(),
      );
      const after = await storage.read.store.listNewest({ limit: 50 });
      expect(after.map((m) => m.providerId)).not.toContain("clients");
      expect(after.find((m) => m.providerId === "wysl")?.mailboxes).toBe(MAILBOX_BIT.sent);
      expect((await storage.read.index.search(parseQuery("in:trash"), { limit: 10 })).length).toBe(
        2,
      );
    } finally {
      storage.close();
    }
  });

  it("adds the Inbox tab first, moves the others down, and a tab that is deleted stays deleted", async () => {
    const { path } = await versionTwenty();
    const first = createSqliteStorage(path);
    const list = await first.views.list();
    expect(list.map((v) => [v.name, v.query, v.position])).toEqual([
      ["Inbox", "in:inbox", 0],
      ["Mine", "from:anna", 1],
      ["Unread", "is:unread", 1],
      ["Starred", "is:starred", 2],
      ["Attachments", "has:attachment", 3],
    ]);
    expect(list[0]?.id).toBe("starter-inbox");
    await first.views.remove("starter-inbox");
    first.close();
    const second = createSqliteStorage(path);
    try {
      expect((await second.views.list()).map((v) => v.name)).toEqual([
        "Mine",
        "Unread",
        "Starred",
        "Attachments",
      ]);
    } finally {
      second.close();
    }
  });

  it("adds the tables empty, and leaves the mail, its locations and its index as they were", async () => {
    const { path, docs } = await versionTwenty();
    const storage = createSqliteStorage(path);
    try {
      expect(await storage.moveOps.listPending()).toEqual([]);
      expect(await storage.moveOps.nextDueMs()).toBeNull();
      expect(await storage.store.listFolders()).toEqual([]);
      const key = docs[0]?.message.key as number;
      expect(await storage.store.getLocations(key)).toEqual([makeLocation(1, "INBOX")]);
      expect((await storage.read.store.getByKeys([key]))[0]?.labelIds).toEqual(["INBOX"]);
    } finally {
      storage.close();
    }
  });
});

describe("the plans of ADR 0044 (rule 2 and ADR 0025)", () => {
  const db = openDatabase(":memory:");
  const explain = (sql: string, ...params: readonly (Param | null)[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as Param[])) as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");

  it("walks All mail down the index of visible mail, in order, with no sort", () => {
    const text = explain(NEWEST_VISIBLE_SQL, Number.MAX_SAFE_INTEGER, 200);
    expect(text).toContain("messages_visible");
    expect(text).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    expect(text).not.toMatch(/SCAN m\b(?! USING)/);
  });

  it("answers a thread without deleted mail by the thread index, with no sort", () => {
    const text = explain(SELECT_VISIBLE_THREAD_SQL, "t");
    expect(text).toContain("messages_thread");
    expect(text).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });

  it("keeps a search as it was: the same index, no new sort, one more lookup by key", () => {
    const run = (q: string, visibleOnly: boolean) => {
      const parsed = parseQuery(q);
      if (parsed.root === null) throw new Error("empty");
      const plan = { ...planQuery(parsed.root), visibleOnly };
      const route = { driver: undefined, heavy: false };
      const { sql, params, named } = buildSql(plan, route, { lower: 0, upper: 1e18, limit: 50 });
      return explain(sql.replace(/:lo|:hi/g, "?"), ...params, ...Object.values(named));
    };
    for (const q of ["alpha", "alpha is:unread", "is:unread", "in:inbox", "label:inbox"]) {
      const before = run(q, false);
      const now = run(q, true);
      expect(now, q).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
      expect(before, q).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
      // The same driving index as before; what is new is a lookup by primary key at most.
      const scans = (t: string) =>
        t
          .split("\n")
          .filter(
            (l) => /SCAN|SEARCH/.test(l) && !l.includes("m USING INTEGER PRIMARY KEY (rowid=?)"),
          );
      expect(
        scans(now).map((l) => l.replace(/messages_visible/, "messages")),
        q,
      ).toEqual(expect.arrayContaining(scans(before).slice(0, 1)));
    }
    expect(VISIBLE_SQL).toBe("m.mailboxes & 24 = 0");
  });
});
