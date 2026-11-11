import type { CachedFile, MailConnection, MessageLocation, StoredAccount } from "@matters/core";
import {
  isMessageKey,
  isPartId,
  planSweep,
  RECEIVED_MAX_AGE_MS,
  RECEIVED_MAX_BYTES,
  ReceivedDownloads,
  receivedId,
  removeAccount,
  sweepReceived,
  syncAccount,
  toAccount,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  FakeMailAttachments,
  FakeMailConnector,
  FakeMailError,
  FakeMailSync,
  InMemoryCredentialStore,
  InMemoryReceivedFiles,
  makeDocument,
  makeLocation,
} from "../src/index.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const pdf = (partId: string, name = "a.pdf", size = 3) => ({
  partId,
  name,
  mimeType: "application/pdf",
  size,
  inline: false,
});

/** A stored message with one place on the fake server and its files, ready to be asked for. */
async function setup(options: { perAccount?: number } = {}) {
  const storage = createInMemoryStorage();
  const server = new FakeMailAttachments();
  const files = new InMemoryReceivedFiles();
  const progress: [number, string, number, number][] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  let fail: unknown = null;
  const downloads = new ReceivedDownloads(
    {
      store: storage.store,
      files,
      async open(accountId) {
        opened.push(accountId);
        if (fail) throw fail;
        return {
          attachments: server,
          close: async () => {
            closed.push(accountId);
          },
        } satisfies Pick<MailConnection, "attachments" | "close">;
      },
    },
    {
      ...(options.perAccount === undefined ? {} : { perAccount: options.perAccount }),
      onProgress: (key, partId, got, total) => progress.push([key, partId, got, total]),
    },
  );
  async function message(uid: number, attached: ReturnType<typeof pdf>[], over = {}) {
    const doc = makeDocument({ providerId: `m${uid}`, hasAttachments: true, ...over });
    const [key] = (await storage.store.upsertMessages([doc.message])).keys;
    const location = makeLocation(uid, "INBOX", "1", doc.message.accountId);
    await storage.store.addLocations([{ key: key as number, location }]);
    await storage.store.setAttachments([{ location, attachments: attached }]);
    return { key: key as number, location };
  }
  return {
    storage,
    server,
    files,
    downloads,
    progress,
    opened,
    closed,
    message,
    failWith: (error: unknown) => {
      fail = error;
    },
  };
}

describe("ReceivedDownloads (ADR 0043, rules 6, 7 and 9)", () => {
  it("downloads the part into the cache and says it is done", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1, 2), bytes(3));

    expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "done" });

    expect(t.files.content(key, "2")).toEqual(bytes(1, 2, 3));
    expect(t.server.requests).toEqual([{ location, partId: "2" }]);
    expect(t.closed).toEqual(["acc1"]);
  });

  it("reports the true bytes as they arrive, with the size it expects", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2", "a.pdf", 10)]);
    t.server.put(location, "2", bytes(1, 2, 3), bytes(4, 5, 6, 7));

    await t.downloads.fetch(key, "2");

    expect(t.progress).toEqual([
      [key, "2", 3, 10],
      [key, "2", 7, 10],
    ]);
  });

  it("never reports less than it has written, even when the estimate was low", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2", "a.pdf", 2)]);
    t.server.put(location, "2", bytes(1, 2, 3, 4));
    await t.downloads.fetch(key, "2");
    expect(t.progress.at(-1)).toEqual([key, "2", 4, 4]);
  });

  describe("asking for the same part twice", () => {
    it("joins the download that is running: one connection, one fetch, one answer", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      t.server.put(location, "2", bytes(1), bytes(2));
      let release!: () => void;
      t.server.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = t.downloads.fetch(key, "2");
      const second = t.downloads.fetch(key, "2");
      expect(second).toBe(first);
      expect(t.downloads.inUse()).toEqual(new Set([receivedId(key, "2")]));
      release();

      expect(await first).toEqual({ kind: "done" });
      expect(t.server.requests).toHaveLength(1);
      expect(t.opened).toEqual(["acc1"]);
      expect(t.downloads.inUse().size).toBe(0);
    });

    it("downloads again after the first ended", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      t.server.put(location, "2", bytes(1));
      await t.downloads.fetch(key, "2");
      // The copy is here, so the second ask is answered without a connection.
      expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "done" });
      expect(t.server.requests).toHaveLength(1);
      expect(t.opened).toHaveLength(1);
    });

    it("lets different parts of one message run side by side", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2"), pdf("3")]);
      t.server.put(location, "2", bytes(1));
      t.server.put(location, "3", bytes(2));
      const both = await Promise.all([t.downloads.fetch(key, "2"), t.downloads.fetch(key, "3")]);
      expect(both).toEqual([{ kind: "done" }, { kind: "done" }]);
      expect(t.server.requests).toHaveLength(2);
    });
  });

  describe("two at a time per account", () => {
    it("runs at most two and starts the next as one ends", async () => {
      const t = await setup();
      const parts = ["2", "3", "4", "5"];
      const { key, location } = await t.message(
        1,
        parts.map((p) => pdf(p)),
      );
      for (const p of parts) t.server.put(location, p, bytes(Number(p)));
      let release!: () => void;
      t.server.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const all = parts.map((p) => t.downloads.fetch(key, p));
      // Let the first two reach the server and stand at the gate.
      await new Promise((r) => setTimeout(r, 20));
      expect(t.server.active).toBe(2);
      expect(t.server.requests).toHaveLength(2);

      release();
      expect(await Promise.all(all)).toEqual(parts.map(() => ({ kind: "done" })));
      expect(t.server.peak).toBe(2);
      expect(t.server.requests).toHaveLength(4);
    });

    it("counts each account apart", async () => {
      const t = await setup();
      const a = await t.message(1, [pdf("2"), pdf("3")]);
      const b = await t.message(2, [pdf("2"), pdf("3")], { accountId: "acc2" });
      for (const m of [a, b]) for (const p of ["2", "3"]) t.server.put(m.location, p, bytes(1));
      let release!: () => void;
      t.server.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const all = [
        t.downloads.fetch(a.key, "2"),
        t.downloads.fetch(a.key, "3"),
        t.downloads.fetch(b.key, "2"),
        t.downloads.fetch(b.key, "3"),
      ];
      await new Promise((r) => setTimeout(r, 20));
      expect(t.server.active).toBe(4);
      release();
      await Promise.all(all);
    });

    it("lets go of its place when a download fails", async () => {
      const t = await setup({ perAccount: 1 });
      const { key, location } = await t.message(1, [pdf("2"), pdf("3")]);
      t.server.put(location, "3", bytes(9));
      t.server.errors.push(new FakeMailError("unreachable"));
      const [first, second] = await Promise.all([
        t.downloads.fetch(key, "2"),
        t.downloads.fetch(key, "3"),
      ]);
      expect(first.kind).toBe("offline");
      expect(second).toEqual({ kind: "done" });
    });
  });

  describe("answers (rule 9)", () => {
    it("says gone, without a connection, for a part the message does not have", async () => {
      const t = await setup();
      const { key } = await t.message(1, [pdf("2")]);
      expect(await t.downloads.fetch(key, "9")).toEqual({ kind: "gone" });
      expect(await t.downloads.fetch(key + 12345, "2")).toEqual({ kind: "gone" });
      expect(t.opened).toEqual([]);
    });

    it("says gone, definitely, when the server no longer has the message", async () => {
      const t = await setup();
      const { key } = await t.message(1, [pdf("2")]);
      // Nothing was put on the fake server for this part: the UID is stale.
      expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "gone" });
      expect(t.files.size).toBe(0);
      expect(t.closed).toEqual(["acc1"]);
    });

    it("tries the other folders of a message before giving up", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      // The first place in order (Archive) lost the message; INBOX still has it.
      const stale: MessageLocation = { ...location, folderId: "Archive", uid: 40 };
      await t.storage.store.addLocations([{ key, location: stale }]);
      t.server.put(location, "2", bytes(7));
      expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "done" });
      expect(t.server.requests.map((r) => r.location.folderId)).toEqual(["Archive", "INBOX"]);
    });

    it("says gone when the account itself is gone", async () => {
      const storage = createInMemoryStorage();
      const files = new InMemoryReceivedFiles();
      const downloads = new ReceivedDownloads({
        store: storage.store,
        files,
        open: async () => null,
      });
      const doc = makeDocument({ hasAttachments: true });
      const [key] = (await storage.store.upsertMessages([doc.message])).keys;
      const location = makeLocation(1);
      await storage.store.addLocations([{ key: key as number, location }]);
      await storage.store.setAttachments([{ location, attachments: [pdf("2")] }]);
      expect(await downloads.fetch(key as number, "2")).toEqual({ kind: "gone" });
    });

    it("says offline when the server cannot be reached, and a retry can work", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      t.server.put(location, "2", bytes(1));
      t.failWith(new FakeMailError("unreachable", "no network"));
      expect(await t.downloads.fetch(key, "2")).toEqual({
        kind: "offline",
        message: "no network",
      });
      expect(t.files.size).toBe(0);

      t.failWith(null);
      expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "done" });
    });

    it("says offline for a failure of the connection in the middle of the part", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      t.server.put(location, "2", bytes(1));
      t.server.errors.push(new FakeMailError("tls", "handshake"));
      expect((await t.downloads.fetch(key, "2")).kind).toBe("offline");
    });

    it("says failed, with the reason for the log, for trouble that waiting will not fix", async () => {
      const t = await setup();
      const { key } = await t.message(1, [pdf("2")]);
      t.failWith(new FakeMailError("auth", "password refused"));
      expect(await t.downloads.fetch(key, "2")).toEqual({
        kind: "failed",
        message: "password refused",
      });
    });

    it("leaves no half file in the cache when a download breaks off", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      t.server.put(location, "2", bytes(1), bytes(2));
      t.files.crashAfterChunks = 1;
      expect((await t.downloads.fetch(key, "2")).kind).toBe("failed");
      // The fake leaves a partial like a crash would; it is not a finished copy...
      expect(t.files.has(key, "2")).toBe(false);
      // ...and the next ask downloads it again from the start.
      t.files.crashAfterChunks = null;
      expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "done" });
      expect(t.files.content(key, "2")).toEqual(bytes(1, 2));
    });

    it("lets the second ask through after a failure, with the connection closed each time", async () => {
      const t = await setup();
      const { key, location } = await t.message(1, [pdf("2")]);
      t.server.put(location, "2", bytes(1));
      t.server.errors.push(new FakeMailError("unreachable"));
      await t.downloads.fetch(key, "2");
      await t.downloads.fetch(key, "2");
      expect(t.closed).toEqual(["acc1", "acc1"]);
    });
  });

  describe("a copy that is already here (offline once opened)", () => {
    it("answers done without a connection and marks it as used", async () => {
      const t = await setup();
      const { key } = await t.message(1, [pdf("2")]);
      t.files.setNow(5);
      await t.files.write(key, "2", "a.pdf", (async function* () {})(), () => {});
      t.files.setNow(99);
      expect(await t.downloads.fetch(key, "2")).toEqual({ kind: "done" });
      expect(t.opened).toEqual([]);
      const [entry] = await t.files.list();
      expect(entry?.usedMs).toBe(99);
    });
  });

  it("cuts every download short on quit and leaves nothing partial", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1), bytes(2), bytes(3));
    let release!: () => void;
    t.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = t.downloads.fetch(key, "2");
    await new Promise((r) => setTimeout(r, 10));
    t.downloads.abortAll();
    release();
    expect((await running).kind).toBe("failed");
    expect(t.files.has(key, "2")).toBe(false);
  });
});

describe("planSweep (ADR 0043, rule 8)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const file = (key: number, over: Partial<CachedFile> = {}): CachedFile => ({
    messageKey: key,
    partId: "2",
    name: "f",
    bytes: 100,
    usedMs: now - DAY,
    partial: false,
    ...over,
  });
  const plan = (files: CachedFile[], over = {}) =>
    planSweep(files, {
      nowMs: now,
      maxAgeMs: RECEIVED_MAX_AGE_MS,
      maxBytes: RECEIVED_MAX_BYTES,
      inUse: new Set(),
      ...over,
    });

  it("keeps recent files and removes those unused for more than seven days", () => {
    const old = file(1, { usedMs: now - 8 * DAY });
    const edge = file(2, { usedMs: now - 7 * DAY });
    const fresh = file(3);
    expect(plan([old, edge, fresh])).toEqual([old]);
  });

  it("removes the oldest first until no more than the limit remain", () => {
    const a = file(1, { bytes: 400, usedMs: now - 3 * DAY });
    const b = file(2, { bytes: 400, usedMs: now - 2 * DAY });
    const c = file(3, { bytes: 400, usedMs: now - 1 * DAY });
    expect(plan([c, a, b], { maxBytes: 800 })).toEqual([a]);
    expect(plan([c, a, b], { maxBytes: 400 })).toEqual([a, b]);
    expect(plan([c, a, b], { maxBytes: 0 })).toEqual([a, b, c]);
    expect(plan([c, a, b], { maxBytes: 1200 })).toEqual([]);
  });

  it("counts the files that age removes before it measures what remains", () => {
    const ancient = file(1, { bytes: 900, usedMs: now - 30 * DAY });
    const a = file(2, { bytes: 400, usedMs: now - 2 * DAY });
    const b = file(3, { bytes: 400, usedMs: now - 1 * DAY });
    // Without the ancient one 800 bytes remain: within the limit, so nothing else goes.
    expect(plan([ancient, a, b], { maxBytes: 800 })).toEqual([ancient]);
  });

  it("never removes a file that is in use, however old or large", () => {
    const busy = file(1, { bytes: 5000, usedMs: now - 50 * DAY });
    const quiet = file(2, { bytes: 100, usedMs: now - 60 * DAY });
    const result = plan([busy, quiet], {
      maxBytes: 0,
      inUse: new Set([receivedId(1, "2")]),
    });
    expect(result).toEqual([quiet]);
  });

  it("passes over a busy file and takes the next oldest when it must cut back", () => {
    const busy = file(1, { bytes: 500, usedMs: now - 5 * DAY });
    const next = file(2, { bytes: 500, usedMs: now - 4 * DAY });
    const newest = file(3, { bytes: 500, usedMs: now - 1 * DAY });
    const result = plan([busy, next, newest], {
      maxBytes: 1000,
      inUse: new Set([receivedId(1, "2")]),
    });
    expect(result).toEqual([next]);
  });

  it("removes partial files nothing is writing, whatever their age or the size", () => {
    const leftover = file(1, { partial: true, usedMs: now - 1000 });
    const writing = file(2, { partial: true });
    expect(plan([leftover, writing], { inUse: new Set([receivedId(2, "2")]) })).toEqual([leftover]);
  });

  it("does not count a partial file toward the size limit", () => {
    const partial = file(1, { partial: true, bytes: 10_000 });
    const whole = file(2, { bytes: 100 });
    expect(plan([partial, whole], { maxBytes: 100 })).toEqual([partial]);
  });

  it("removes nothing from an empty cache", () => {
    expect(plan([])).toEqual([]);
  });

  it("uses a week and two gigabytes unless told otherwise", () => {
    expect(RECEIVED_MAX_AGE_MS).toBe(7 * DAY);
    expect(RECEIVED_MAX_BYTES).toBe(2_000_000_000);
  });
});

describe("sweepReceived", () => {
  it("deletes what the plan names and reports how many", async () => {
    const files = new InMemoryReceivedFiles();
    const DAY = 24 * 60 * 60 * 1000;
    files.seed(1, "2", 100, 0);
    files.seed(2, "2", 100, 99 * DAY);
    files.seed(3, "2", 100, 99 * DAY, true);
    const removed = await sweepReceived({ files, nowMs: 100 * DAY, inUse: new Set() });
    expect(removed).toBe(2);
    expect((await files.list()).map((f) => f.messageKey)).toEqual([2]);
  });

  it("leaves a file a download is writing", async () => {
    const files = new InMemoryReceivedFiles();
    files.seed(1, "2", 100, 0, true);
    const removed = await sweepReceived({
      files,
      nowMs: 10_000_000_000,
      inUse: new Set([receivedId(1, "2")]),
    });
    expect(removed).toBe(0);
  });

  it("does nothing at all for a cache that is fine", async () => {
    const files = new InMemoryReceivedFiles();
    files.seed(1, "2", 100, 1000);
    expect(await sweepReceived({ files, nowMs: 2000, inUse: new Set() })).toBe(0);
    expect(files.size).toBe(1);
  });

  it("honours the age and size it is given", async () => {
    const files = new InMemoryReceivedFiles();
    files.seed(1, "2", 100, 10);
    files.seed(2, "2", 100, 20);
    expect(
      await sweepReceived({ files, nowMs: 30, inUse: new Set(), maxAgeMs: 15, maxBytes: 1000 }),
    ).toBe(1);
    expect(
      await sweepReceived({ files, nowMs: 30, inUse: new Set(), maxAgeMs: 1000, maxBytes: 50 }),
    ).toBe(1);
  });
});

describe("keys that name a directory of the cache", () => {
  it("accepts a positive integer message key and a dotted part number", () => {
    expect(isMessageKey(1)).toBe(true);
    expect(isMessageKey(1_730_000_000_000 * 1024)).toBe(true);
    expect(isPartId("2")).toBe(true);
    expect(isPartId("1.2.10")).toBe(true);
  });

  it("refuses anything that could climb out of it or is not a key at all", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
      null,
      undefined,
      2 ** 60,
    ]) {
      expect(isMessageKey(bad), String(bad)).toBe(false);
    }
    for (const bad of [
      "",
      ".",
      "..",
      "1.",
      ".1",
      "1..2",
      "1/2",
      "..\\1",
      "../1",
      "1 ",
      "a",
      "1.a",
      "-1",
      "٣",
      "1\n",
      "2".repeat(100),
      1,
      null,
    ]) {
      expect(isPartId(bad), String(bad)).toBe(false);
    }
  });
});

describe("the files go with the account (ADR 0043, rule 8)", () => {
  it("removes the copies of every message of the account, after the unit", async () => {
    const storage = createInMemoryStorage();
    const server = new FakeMailSync(["INBOX"]);
    const credentials = new InMemoryCredentialStore();
    const account: StoredAccount = {
      id: "acc1",
      address: "me@example.com",
      displayName: "",
      imap: { host: "h", port: 993, security: "tls", username: "me" },
      createdAtMs: 1,
    };
    await storage.accounts.add(account);
    server.add("INBOX", "a");
    server.add("INBOX", "b");
    await syncAccount({ ...storage, sync: server }, toAccount(account));
    const keys = (await storage.store.listNewest({ limit: 10 })).map((m) => m.key);
    const files = new InMemoryReceivedFiles();
    for (const key of keys) files.seed(key, "2", 10, 0);
    files.seed(777, "2", 10, 0);

    await removeAccount({ ...storage, credentials, received: files }, "acc1");

    expect((await files.list()).map((f) => f.messageKey)).toEqual([777]);
  });

  it("does not fail the removal when the files cannot be deleted", async () => {
    const storage = createInMemoryStorage();
    const credentials = new InMemoryCredentialStore();
    await storage.accounts.add({
      id: "acc1",
      address: "me@example.com",
      displayName: "",
      imap: { host: "h", port: 993, security: "tls", username: "me" },
      createdAtMs: 1,
    });
    const received = {
      removeMessages: async () => {
        throw new Error("read-only volume");
      },
    };
    await expect(removeAccount({ ...storage, credentials, received }, "acc1")).resolves.toBe(true);
  });
});

// The connector's attachment port is the same object on every connection, as the fake does it.
describe("FakeMailConnector", () => {
  it("hands out the attachment fake on each connection", async () => {
    const connector = new FakeMailConnector(new FakeMailSync(["INBOX"]));
    const connection = await connector.connect({
      server: { host: "h", port: 993, security: "tls", username: "me" },
      credential: { kind: "password", username: "me", password: "x" },
    });
    expect(connection.attachments).toBe(connector.attachments);
  });
});

describe("ReceivedDownloads shared between askers (ADR 0045, rule 6)", () => {
  /** Holds the download open until the returned function is called. */
  function holdServer(t: Awaited<ReturnType<typeof setup>>) {
    let release!: () => void;
    t.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  const settleTicks = () => new Promise((r) => setTimeout(r, 10));

  it("tells every asker the bytes, each in its own callback", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2", "a.pdf", 10)]);
    t.server.put(location, "2", bytes(1, 2, 3), bytes(4, 5));
    const a: number[] = [];
    const b: number[] = [];
    const first = t.downloads.fetch(key, "2", { onBytes: (n) => a.push(n) });
    const second = t.downloads.fetch(key, "2", { onBytes: (n, total) => b.push(n, total) });
    expect(await Promise.all([first, second])).toEqual([{ kind: "done" }, { kind: "done" }]);
    expect(a).toEqual([3, 5]);
    expect(b).toEqual([3, 10, 5, 10]);
    expect(t.server.requests).toHaveLength(1);
  });

  it("stops a download when its only asker gives up, and says cancelled", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1), bytes(2), bytes(3));
    const release = holdServer(t);
    const gone = new AbortController();
    const running = t.downloads.fetch(key, "2", { signal: gone.signal });
    await settleTicks();
    gone.abort();
    expect(await running).toEqual({ kind: "cancelled" });
    release();
    await settleTicks();
    expect(t.files.has(key, "2")).toBe(false);
    expect(t.downloads.inUse().size).toBe(0);
  });

  it("keeps downloading while an asker without a signal is waiting", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1), bytes(2));
    const release = holdServer(t);
    const gone = new AbortController();
    const forward = t.downloads.fetch(key, "2", { signal: gone.signal });
    const reader = t.downloads.fetch(key, "2");
    await settleTicks();
    gone.abort();
    expect(await forward).toEqual({ kind: "cancelled" });
    release();
    expect(await reader).toEqual({ kind: "done" });
    expect(t.files.content(key, "2")).toEqual(bytes(1, 2));
  });

  it("keeps downloading until every asker with a signal has given up", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1), bytes(2));
    const release = holdServer(t);
    const [one, two] = [new AbortController(), new AbortController()];
    const a = t.downloads.fetch(key, "2", { signal: one.signal });
    const b = t.downloads.fetch(key, "2", { signal: two.signal });
    await settleTicks();
    one.abort();
    expect(await a).toEqual({ kind: "cancelled" });
    release();
    expect(await b).toEqual({ kind: "done" });
  });

  it("answers cancelled at once for a signal that is already aborted, and starts nothing", async () => {
    const t = await setup();
    const { key } = await t.message(1, [pdf("2")]);
    expect(await t.downloads.fetch(key, "2", { signal: AbortSignal.abort() })).toEqual({
      kind: "cancelled",
    });
    expect(t.opened).toEqual([]);
  });

  it("an asker that comes after the others gave up starts a fresh download", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1), bytes(2));
    const release = holdServer(t);
    const gone = new AbortController();
    const first = t.downloads.fetch(key, "2", { signal: gone.signal });
    await settleTicks();
    gone.abort();
    await first;
    const later = t.downloads.fetch(key, "2");
    release();
    expect(await later).toEqual({ kind: "done" });
    expect(t.files.content(key, "2")).toEqual(bytes(1, 2));
  });

  it("a quit is still a failure, and says it was a quit", async () => {
    const t = await setup();
    const { key, location } = await t.message(1, [pdf("2")]);
    t.server.put(location, "2", bytes(1), bytes(2));
    const release = holdServer(t);
    const running = t.downloads.fetch(key, "2", { signal: new AbortController().signal });
    await settleTicks();
    expect(t.downloads.stopped).toBe(false);
    t.downloads.abortAll();
    release();
    expect((await running).kind).toBe("failed");
    expect(t.downloads.stopped).toBe(true);
  });
});

describe("InMemoryReceivedFiles.locate", () => {
  it("names a finished copy and nothing else", async () => {
    const files = new InMemoryReceivedFiles();
    expect(await files.locate(1, "2")).toBeNull();
    files.seed(1, "2", 3, 0, true);
    expect(await files.locate(1, "2")).toBeNull();
    files.seed(1, "2", 3, 0);
    expect(await files.locate(1, "2")).toBe("cache/1/2");
  });
});
