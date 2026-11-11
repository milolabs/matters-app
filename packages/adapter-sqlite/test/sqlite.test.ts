import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySyncBatch, ingestDocuments, parseQuery } from "@matters/core";
import {
  asStored,
  makeDocument,
  makeLocation,
  makeMessage,
  makeSyncBatch,
  syncedDoc,
} from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCK_LIMIT_BYTES,
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  type SqliteStorage,
  schemaVersion,
} from "../src/index.ts";

const open: SqliteStorage[] = [];
const dirs: string[] = [];

function memory(): SqliteStorage {
  const s = createSqliteStorage(":memory:");
  open.push(s);
  return s;
}

afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migrations", () => {
  it("builds the schema from an empty database", () => {
    const db = openDatabase(":memory:");
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of [
      "messages",
      "message_labels",
      "message_fts",
      "cursors",
      "send_operations",
      "drafts",
      "accounts",
    ]) {
      expect(names).toContain(t);
    }
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  it("re-opens an existing file without re-running migrations and keeps data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const m = makeMessage({ subject: "persisted" });

    const first = createSqliteStorage(path);
    await first.store.upsertMessages([m]);
    await first.index.indexMessages([{ message: m, bodyText: "zażółć" }]);
    first.close();

    const db = openDatabase(path);
    const versions = db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number };
    expect(versions.n).toBe(LATEST_SCHEMA_VERSION);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    db.close();

    const second = createSqliteStorage(path);
    open.push(second);
    expect(await second.store.getByKeys([m.key])).toEqual([asStored(m)]);
    expect(await second.index.search(parseQuery("zazolc"), { limit: 5 })).toEqual([m.key]);
    const next = await second.store.upsertMessages([makeMessage({ dateMs: m.dateMs + 1000 })]);
    expect(next.changeSeq).toBe(2);
  });

  it("refuses a database from a newer build", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const db = openDatabase(path);
    db.prepare("INSERT INTO schema_version (version, applied_at_ms) VALUES (?, 0)").run(
      LATEST_SCHEMA_VERSION + 1,
    );
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer/);
  });
});

describe("cursor store", () => {
  it("round-trips and overwrites per account and folder", async () => {
    const { cursors } = memory();
    expect(await cursors.get("a", "inbox")).toBeNull();
    await cursors.set("a", "inbox", { uidValidity: 7, lastUid: 42, note: null, ok: true });
    await cursors.set("a", "sent", { uidValidity: 1 });
    expect(await cursors.get("a", "inbox")).toEqual({
      uidValidity: 7,
      lastUid: 42,
      note: null,
      ok: true,
    });
    await cursors.set("a", "inbox", { uidValidity: 8, lastUid: 1 });
    expect(await cursors.get("a", "inbox")).toEqual({ uidValidity: 8, lastUid: 1 });
    expect(await cursors.get("a", "sent")).toEqual({ uidValidity: 1 });
    expect(await cursors.get("b", "inbox")).toBeNull();
  });

  it("forgets all cursors of one account", async () => {
    const { cursors } = memory();
    await cursors.set("a", "inbox", { uidValidity: 1 });
    await cursors.set("a", "sent", { uidValidity: 1 });
    await cursors.set("b", "inbox", { uidValidity: 1 });
    await cursors.deleteAccount("a");
    expect(await cursors.get("a", "inbox")).toBeNull();
    expect(await cursors.get("a", "sent")).toBeNull();
    expect(await cursors.get("b", "inbox")).not.toBeNull();
  });
});

describe("hostile queries", () => {
  const inputs = [
    "NEAR(a b)",
    '"',
    "*",
    "-x",
    "a OR b",
    "col:x",
    "subject:(a OR b)",
    "(",
    ")",
    "((a))",
    "a AND NOT b",
    "sender:x body:y",
    "x".repeat(100_000),
    `${"word ".repeat(5_000)}"`,
  ];

  it.each(inputs.map((i) => [i.slice(0, 20), i]))("does not throw on %j", async (_n, input) => {
    const s = memory();
    const doc = makeDocument({ subject: "near a b or col x" }, "body text");
    await s.store.upsertMessages([doc.message]);
    await s.index.indexMessages([doc]);
    const keys = await s.index.search(parseQuery(input as string), { limit: 10 });
    expect(Array.isArray(keys)).toBe(true);
  });

  it("reads uppercase OR as an operator and everything else as words", async () => {
    const s = memory();
    const doc = makeDocument({ subject: "near alpha or beta" });
    await s.store.upsertMessages([doc.message]);
    await s.index.indexMessages([doc]);
    const find = (q: string) => s.index.search(parseQuery(q), { limit: 10 });
    expect(await find("alpha OR gamma")).toEqual([doc.message.key]);
    expect(await find("gamma OR delta")).toEqual([]);
    expect(await find("alpha or gamma")).toEqual([]);
    expect(await find("alpha or beta")).toEqual([doc.message.key]);
    expect(await find("NEAR(alpha beta)")).toEqual([doc.message.key]);
  });
});

describe("store specifics", () => {
  it("matches label: terms against folded label ids", async () => {
    const s = memory();
    const doc = makeDocument({ subject: "hello", labelIds: ["Żółć"] });
    await s.store.upsertMessages([doc.message]);
    await s.index.indexMessages([doc]);
    expect(await s.index.search(parseQuery("label:zolc"), { limit: 5 })).toEqual([doc.message.key]);
    expect(await s.index.search(parseQuery("hello label:zolc"), { limit: 5 })).toEqual([
      doc.message.key,
    ]);
    expect(await s.index.search(parseQuery("hello label:other"), { limit: 5 })).toEqual([]);
  });

  it("replaces labels on update and keeps their order", async () => {
    const s = memory();
    const m = makeMessage({ labelIds: ["z", "a", "m"] });
    await s.store.upsertMessages([m]);
    await s.store.upsertMessages([{ ...m, labelIds: ["b", "a"] }]);
    const [got] = await s.store.getByKeys([m.key]);
    expect(got?.labelIds).toEqual(["b", "a"]);
    expect(await s.store.listNewest({ labelId: "z", limit: 5 })).toEqual([]);
  });
});

describe("body store", () => {
  const put = (key: number, threadId: string, text: string) => ({ key, threadId, text });

  it("stores one block per thread and splits past the block limit", async () => {
    const s = memory();
    const chunk = "ż".repeat(BLOCK_LIMIT_BYTES / 4); // 2 bytes each: a quarter of the limit
    await s.bodies.putBodies([put(1, "small", "a"), put(2, "small", "b")]);
    expect(s.bodyStats().blocks).toBe(1);

    for (let k = 10; k < 16; k++) await s.bodies.putBodies([put(k, "big", chunk)]);
    // 6 chunks of 128 KiB: two per block.
    expect(s.bodyStats().blocks).toBe(1 + 3);
    const got = await s.bodies.getBodies([10, 15, 2]);
    expect(got.get(10)).toBe(chunk);
    expect(got.get(15)).toBe(chunk);
    expect(got.get(2)).toBe("b");
  });

  it("compresses a quoting thread well below its raw size", async () => {
    const s = memory();
    let quoted = "";
    const batch = [];
    for (let k = 1; k <= 10; k++) {
      const fresh = `Odpowiedź numer ${k}: zażółć gęślą jaźń, dziękuję za wiadomość.\n`;
      quoted = `${fresh}\n${quoted
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`;
      batch.push(put(k, "t", quoted));
    }
    await s.bodies.putBodies(batch);
    const { rawBytes, compressedBytes } = s.bodyStats();
    expect(compressedBytes * 4).toBeLessThan(rawBytes);
  });

  it("moves a message to its new thread and drops emptied blocks", async () => {
    const s = memory();
    await s.bodies.putBodies([put(1, "a", "one"), put(2, "b", "two")]);
    await s.bodies.putBodies([put(1, "b", "one again")]);
    expect(s.bodyStats()).toMatchObject({ blocks: 1, messages: 2 });
    const got = await s.bodies.getBodies([1, 2]);
    expect(got.get(1)).toBe("one again");
    expect(got.get(2)).toBe("two");
  });

  it("persists across reopen and rolls back a failing batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const first = createSqliteStorage(path);
    await first.bodies.putBodies([put(1, "t", "zażółć")]);
    // A non-string body throws mid-batch, after the first entry was already staged.
    await expect(
      first.bodies.putBodies([put(2, "t", "x"), put(3, "t", null as unknown as string)]),
    ).rejects.toThrow();
    first.close();

    const second = createSqliteStorage(path);
    open.push(second);
    const got = await second.bodies.getBodies([1, 2, 3]);
    expect([...got.entries()]).toEqual([[1, "zażółć"]]);
  });
});

describe("unit of work", () => {
  function fileStorage(): { storage: SqliteStorage; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "matters-uow-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const storage = createSqliteStorage(path);
    open.push(storage);
    return { storage, path };
  }
  const gate = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  it("keeps a separate reader blind to uncommitted writes and shows them after commit", async () => {
    const { storage } = fileStorage();
    const doc = makeDocument({ subject: "visible later" }, "later");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: () => void;
    const wroteAll = new Promise<void>((resolve) => {
      written = resolve;
    });

    const unit = storage.uow.run(async () => {
      await ingestDocuments(storage, [doc]);
      // The writer sees its own rows; the reader must not.
      expect(await storage.store.getByKeys([doc.message.key])).toHaveLength(1);
      written();
      await hold;
    });
    await wroteAll;
    const { read } = storage;
    expect(await read.store.getByKeys([doc.message.key])).toEqual([]);
    expect(await read.store.listNewest({ limit: 5 })).toEqual([]);
    expect(await read.index.search(parseQuery("later"), { limit: 5 })).toEqual([]);
    expect((await read.bodies.getBodies([doc.message.key])).size).toBe(0);
    expect(await read.store.getThread(doc.message.threadId)).toBeNull();
    expect((await read.store.changesSince(0)).changedKeys).toEqual([]);

    release();
    await unit;
    expect(await read.store.getByKeys([doc.message.key])).toEqual([asStored(doc.message)]);
    expect(await read.index.search(parseQuery("later"), { limit: 5 })).toEqual([doc.message.key]);
    expect((await read.bodies.getBodies([doc.message.key])).get(doc.message.key)).toBe("later");
    expect((await read.store.changesSince(0)).changedKeys).toEqual([doc.message.key]);
  });

  it("sees every committed write straight away, one write at a time", async () => {
    const { storage } = fileStorage();
    for (let i = 0; i < 20; i++) {
      const doc = makeDocument({ dateMs: Date.UTC(2024, 0, 1) + i * 60_000 }, `w${i}`);
      await ingestDocuments(storage, [doc]);
      expect((await storage.read.store.listNewest({ limit: 1 }))[0]?.key).toBe(doc.message.key);
      expect((await storage.read.bodies.getBodies([doc.message.key])).get(doc.message.key)).toBe(
        `w${i}`,
      );
    }
  });

  it("leaves nothing in a reopened file after a rolled-back batch", async () => {
    const { storage, path } = fileStorage();
    const kept = makeDocument({ subject: "kept", labelIds: ["INBOX"] }, "kept");
    await applySyncBatch(storage, {
      accountId: "acc1",
      folderId: "INBOX",
      batch: makeSyncBatch({ documents: [syncedDoc(kept, 1)], cursor: { uid: 1 } }),
    });
    const lost = makeDocument({ subject: "lost" }, "lost");
    const failing = Object.create(storage.cursors, {
      set: {
        value: async () => {
          throw new Error("crash before the cursor");
        },
      },
    });
    await expect(
      applySyncBatch(
        { ...storage, cursors: failing },
        {
          accountId: "acc1",
          folderId: "INBOX",
          batch: makeSyncBatch({
            documents: [syncedDoc(lost, 2)],
            removedLocations: [makeLocation(1)],
            cursor: { uid: 2 },
          }),
        },
      ),
    ).rejects.toThrow("crash");
    storage.close();

    const reopened = createSqliteStorage(path);
    open.push(reopened);
    expect(await reopened.store.getByKeys([kept.message.key, lost.message.key])).toEqual([
      asStored(kept.message),
    ]);
    expect(await reopened.index.search(parseQuery("lost"), { limit: 5 })).toEqual([]);
    expect(await reopened.index.search(parseQuery("kept"), { limit: 5 })).toEqual([
      kept.message.key,
    ]);
    expect((await reopened.bodies.getBodies([kept.message.key, lost.message.key])).size).toBe(1);
    expect(await reopened.cursors.get("acc1", "INBOX")).toEqual({ uid: 1 });
    expect(reopened.bodyStats().messages).toBe(1);
    const db = openDatabase(path);
    expect(db.prepare("SELECT COUNT(*) AS n FROM removed_messages").get()).toEqual({ n: 0 });
    db.close();
  });

  it("makes a plain write from another call chain wait for an open unit instead of joining it", async () => {
    const { storage } = fileStorage();
    const inside = makeMessage({ subject: "inside" });
    const outside = makeMessage({ subject: "outside" });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: () => void;
    const wroteInside = new Promise<void>((resolve) => {
      written = resolve;
    });

    const unit = storage.uow.run(async () => {
      await storage.store.upsertMessages([inside]);
      written();
      await hold;
      throw new Error("roll back the unit");
    });
    await wroteInside;
    let outsideDone = false;
    const plain = storage.store.upsertMessages([outside]).then(() => {
      outsideDone = true;
    });
    await gate();
    expect(outsideDone).toBe(false);

    release();
    await expect(unit).rejects.toThrow("roll back");
    await plain;
    // The plain write ran after the rollback, on its own, and committed.
    expect(await storage.read.store.getByKeys([inside.key, outside.key])).toEqual([
      asStored(outside),
    ]);
  });

  it("keeps each write method atomic inside a unit, even when the unit catches its error", async () => {
    const { storage } = fileStorage();
    await storage.uow.run(async () => {
      await storage.bodies.putBodies([{ key: 1, threadId: "t", text: "kept" }]);
      await expect(
        storage.bodies.putBodies([
          { key: 2, threadId: "t", text: "staged" },
          { key: 3, threadId: "t", text: null as unknown as string },
        ]),
      ).rejects.toThrow();
    });
    const got = await storage.read.bodies.getBodies([1, 2, 3]);
    expect([...got.entries()]).toEqual([[1, "kept"]]);
  });

  it("closes the reader together with the writer", () => {
    const { storage } = fileStorage();
    storage.close();
    return expect(storage.read.store.listNewest({ limit: 1 })).rejects.toThrow();
  });
});
