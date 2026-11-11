// The view requests (ADR 0027): validation in the router's handler, and the whole write path
// from a request through the sync runtime's writer to the router's read-only connection.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteReader, createSqliteStorage } from "@matters/adapter-sqlite";
import type { BackendResponse } from "@matters/contracts";
import type { MailConnectorPort, SearchIndexPort } from "@matters/core";
import { countMatches, parseQuery } from "@matters/core";
import {
  createInMemoryStorage,
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailSubmit,
  FakeMessageComposer,
} from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import type {
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../src/backend/protocol.ts";
import { RemoteCounts } from "../src/backend/remoteCounts.ts";
import { RemoteViews } from "../src/backend/remoteViews.ts";
import { seedIfEmpty } from "../src/backend/seed.ts";
import type { SyncHost } from "../src/backend/syncHost.ts";
import { startSyncRuntime } from "../src/backend/syncRuntime.ts";
import { ViewService } from "../src/backend/viewService.ts";
import { imageDeps, noSend } from "./support/noSend.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function inMemory() {
  const storage = createInMemoryStorage();
  let n = 0;
  const deps: BackendDeps = {
    ...storage,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    accounts: {
      discover: async () => null,
      list: async () => [],
      add: async () => {
        throw new Error("not used");
      },
      remove: async () => false,
      syncNow: async () => false,
      changePassword: async () => null,
    },
    savedViews: storage.views,
    ...imageDeps,
    // The worker's side of a count: its own index, not the one the router reads with.
    counts: {
      count: (query, cap, beforeKey) =>
        countMatches({ index: storage.index, accounts: storage.accounts }, query, {
          cap,
          ...(beforeKey === undefined ? {} : { beforeKey }),
        }),
    },
    viewWrites: new ViewService({
      views: storage.views,
      newId: () => `v${++n}`,
      now: () => 1000 + n,
    }),
  };
  const ask = (request: object) => handle(deps, { requestId: "r", ...request });
  return { storage, deps, ask };
}

const error = (r: BackendResponse) => {
  if (r.type !== "error") throw new Error(`expected an error, got ${r.type}`);
  return r;
};

describe("view requests", () => {
  it("creates, lists in order, renames, updates, moves and deletes", async () => {
    const { ask } = inMemory();
    const a = await ask({ type: "saveView", name: "Invoices", query: "faktura" });
    const b = await ask({ type: "saveView", name: "Unread", query: "is:unread" });
    expect(a).toMatchObject({
      type: "saveView",
      ok: true,
      view: { name: "Invoices", position: 0 },
    });
    if (a.type !== "saveView" || b.type !== "saveView") throw new Error("unexpected");

    expect(await ask({ type: "saveView", id: a.view.id, name: "Bills" })).toMatchObject({
      view: { name: "Bills", query: "faktura" },
    });
    expect(
      await ask({ type: "saveView", id: a.view.id, query: "faktura has:attachment" }),
    ).toMatchObject({
      view: { name: "Bills", query: "faktura has:attachment" },
    });
    expect(await ask({ type: "moveView", id: b.view.id, toIndex: 0 })).toMatchObject({ ok: true });
    const list = await ask({ type: "listViews" });
    if (list.type !== "listViews") throw new Error("unexpected");
    expect(list.views.map((v) => v.name)).toEqual(["Unread", "Bills"]);

    expect(await ask({ type: "deleteView", id: a.view.id })).toMatchObject({
      type: "deleteView",
      ok: true,
    });
    // Deleting twice is not an error: the view is gone either way.
    expect(await ask({ type: "deleteView", id: a.view.id })).toMatchObject({ ok: true });
    const after = await ask({ type: "listViews" });
    if (after.type !== "listViews") throw new Error("unexpected");
    expect(after.views.map((v) => v.name)).toEqual(["Unread"]);
  });

  it("answers a refused view with a message the UI can show", async () => {
    const { ask } = inMemory();
    await ask({ type: "saveView", name: "Invoices", query: "faktura" });
    const dup = error(await ask({ type: "saveView", name: "invoices", query: "x" }));
    expect(dup).toMatchObject({
      code: "invalidView",
      message: 'A view named "invoices" already exists.',
    });
    expect(error(await ask({ type: "saveView", name: " ", query: "x" }))).toMatchObject({
      code: "invalidView",
      message: "Give the view a name.",
    });
    expect(error(await ask({ type: "saveView", name: "A", query: " " }))).toMatchObject({
      code: "invalidView",
    });
    expect(error(await ask({ type: "saveView", id: "nope", query: "x" }))).toMatchObject({
      code: "notFound",
    });
    expect(error(await ask({ type: "moveView", id: "nope", toIndex: 0 }))).toMatchObject({
      code: "notFound",
    });
  });

  it("checks every field of the request", async () => {
    const { ask } = inMemory();
    const bad: object[] = [
      { type: "saveView" },
      { type: "saveView", name: "A" },
      { type: "saveView", query: "x" },
      { type: "saveView", name: 1, query: "x" },
      { type: "saveView", name: "A", query: "x".repeat(10_001) },
      { type: "saveView", id: 5, name: "A" },
      { type: "saveView", id: "v1" },
      { type: "saveView", id: "v1", name: "A", query: "x" },
      { type: "deleteView" },
      { type: "deleteView", id: 3 },
      { type: "moveView", id: "v1" },
      { type: "moveView", id: "v1", toIndex: 1.5 },
      { type: "moveView", id: "v1", toIndex: "1" },
      { type: "moveView", toIndex: 1 },
      { type: "countMatches", query: "x" },
      { type: "countMatches", cap: 99 },
      { type: "countMatches", query: "x", cap: 1.5 },
      { type: "countMatches", query: 3, cap: 99 },
      { type: "countMatches", query: "x".repeat(10_001), cap: 99 },
      { type: "countMatches", query: "x", cap: 99, beforeKey: "1" },
    ];
    for (const request of bad) {
      expect(error(await ask(request)), JSON.stringify(request).slice(0, 80)).toMatchObject({
        code: "invalidRequest",
      });
    }
  });

  it("counts unread matches, one window at a time, and never loads messages", async () => {
    const { ask, storage } = inMemory();
    await seedIfEmpty(storage, { messages: 400, threads: 100 });
    const getByKeys = storage.store.getByKeys.bind(storage.store);
    let loaded = 0;
    storage.store.getByKeys = async (keys) => {
      loaded++;
      return getByKeys(keys);
    };

    const count = async (query: string, cap: number) => {
      const r = await ask({ type: "countMatches", query, cap });
      if (r.type !== "countMatches") throw new Error(`unexpected ${r.type}`);
      return r;
    };
    expect(await count("", 99)).toEqual({
      type: "countMatches",
      requestId: "r",
      ok: true,
      count: 0,
    });
    expect((await count("from:", 99)).count).toBe(0);

    // Following the cursors gives what search finds with is:unread added.
    let total = 0;
    let before: number | undefined;
    for (;;) {
      const r = await ask({
        type: "countMatches",
        query: "zazolc",
        cap: 7,
        ...(before === undefined ? {} : { beforeKey: before }),
      });
      if (r.type !== "countMatches") throw new Error("unexpected");
      expect(r.count).toBeLessThanOrEqual(7);
      total += r.count;
      if (r.nextBeforeKey === undefined) break;
      before = r.nextBeforeKey;
    }
    const search = await ask({ type: "search", query: "zazolc is:unread", limit: 500 });
    if (search.type !== "search") throw new Error("unexpected");
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(search.messages.length);
    // The search above loaded messages, counting did not.
    expect(loaded).toBe(1);
  });
});

/** An index that fails the test if the router asks it for anything. */
const forbiddenIndex: Pick<SearchIndexPort, "searchChunk" | "matchesAmong"> = {
  searchChunk: async () => {
    throw new Error("the router's index was used");
  },
  matchesAmong: async () => {
    throw new Error("the router's index was used");
  },
};

describe("counts and the router's index", () => {
  it("countMatches never reaches the router's index; the injected API answers", async () => {
    const { deps } = inMemory();
    const calls: unknown[][] = [];
    const guarded: BackendDeps = {
      ...deps,
      index: forbiddenIndex,
      counts: {
        count: async (...args) => {
          calls.push(args);
          return { count: 7, nextBeforeKey: 3 };
        },
      },
    };
    const r = await handle(guarded, {
      type: "countMatches",
      requestId: "c",
      query: "faktura",
      cap: 99,
      beforeKey: 40,
    });
    expect(r).toEqual({
      type: "countMatches",
      requestId: "c",
      ok: true,
      count: 7,
      nextBeforeKey: 3,
    });
    expect(calls).toEqual([["faktura", 99, 40]]);
    // A failure of the count comes back as an error response, not a hang or a throw.
    const failing: BackendDeps = {
      ...guarded,
      counts: {
        count: async () => {
          throw new Error("The sync process is restarting; try again in a moment");
        },
      },
    };
    expect(
      await handle(failing, { type: "countMatches", requestId: "c", query: "x", cap: 9 }),
    ).toMatchObject({
      type: "error",
      ok: false,
    });
    // Search still uses the router's index.
    const s = await handle(guarded, { type: "search", requestId: "s", query: "x", limit: 5 });
    expect(s).toMatchObject({ type: "error" });
  });
});

describe("the write path", () => {
  it("goes through the worker's writer; the router's reader sees the committed views", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-views-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "matters.db");

    // The worker side: the real runtime on the writer connection.
    const storage = createSqliteStorage(dbPath, { reader: false });
    await seedIfEmpty(storage, { messages: 400, threads: 100 });
    // This test counts its own views; the starter views have their own (ADR 0029).
    for (const view of await storage.views.list()) await storage.views.remove(view.id);
    const handlers: ((m: ToWorker) => void)[] = [];
    const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
    const channel: WorkerChannel = {
      post(message: FromWorker) {
        if (message.type !== "result") return;
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) w?.ok(message.value);
        else w?.fail(Object.assign(new Error(message.error.message), { name: message.error.name }));
      },
      onMessage: (h) => handlers.push(h),
    };
    const connector: MailConnectorPort = {
      connect: async () => {
        throw new Error("no accounts");
      },
      watchInbox: async () => ({ close: async () => {} }),
    };
    const runtime = await startSyncRuntime({
      storage,
      connector,
      channel,
      discovery: { discover: async () => null },
      registrableDomain: imageDeps.registrableDomain,
      files: new FakeFileWork(),
      sending: {
        renderer: new FakeComposeRenderer(),
        composer: new FakeMessageComposer(),
        submit: new FakeMailSubmit(),
        sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
      },
    });
    cleanups.push(() => runtime.stop());

    // The router side: only a reader, and the commands it would post to the worker.
    const reader = createSqliteReader(dbPath);
    cleanups.push(() => reader.close());
    let nextId = 0;
    const commands: WorkerCommand["name"][] = [];
    const host = {
      command: (command: WorkerCommand) =>
        new Promise((ok, fail) => {
          const id = ++nextId;
          commands.push(command.name);
          waiting.set(id, { ok, fail });
          for (const h of handlers) h({ type: "command", id, command });
        }),
    } as unknown as SyncHost;
    const deps: BackendDeps = {
      ...reader.read,
      accountStore: reader.read.accounts,
      renderer: new FakeComposeRenderer(),
      send: noSend,
      accounts: {
        discover: async () => null,
        list: async () => [],
        add: async () => {
          throw new Error("not used");
        },
        remove: async () => false,
        syncNow: async () => false,
        changePassword: async () => null,
      },
      savedViews: reader.read.views,
      ...imageDeps,
      counts: new RemoteCounts(host),
      viewWrites: new RemoteViews(host),
    };
    const ask = (request: object) => handle(deps, { requestId: "r", ...request });

    const a = await ask({ type: "saveView", name: "Invoices", query: "faktura" });
    await ask({ type: "saveView", name: "Unread", query: "is:unread" });
    if (a.type !== "saveView") throw new Error("unexpected");
    await ask({ type: "moveView", id: a.view.id, toIndex: 1 });
    await ask({ type: "saveView", id: a.view.id, name: "Bills" });
    const dup = await ask({ type: "saveView", name: "UNREAD", query: "x" });
    expect(dup).toMatchObject({ type: "error", code: "invalidView" });

    const list = await ask({ type: "listViews" });
    if (list.type !== "listViews") throw new Error("unexpected");
    expect(list.views.map((v) => [v.name, v.query, v.position])).toEqual([
      ["Unread", "is:unread", 0],
      ["Bills", "faktura", 1],
    ]);
    expect(commands).toEqual(["createView", "createView", "moveView", "renameView", "createView"]);

    await ask({ type: "deleteView", id: a.view.id });
    expect((await reader.read.views.list()).map((v) => v.name)).toEqual(["Unread"]);

    // A count is a command too: it runs in the worker, and the reader's index stays unused.
    const searched: unknown[] = [];
    const readerIndex = reader.read.index;
    const counted = await handle(
      {
        ...deps,
        index: {
          searchChunk: async (...args) => {
            searched.push(args);
            return readerIndex.searchChunk(...args);
          },
          matchesAmong: (...args) => readerIndex.matchesAmong(...args),
        },
      },
      { type: "countMatches", requestId: "c", query: "zazolc", cap: 500 },
    );
    if (counted.type !== "countMatches") throw new Error(`unexpected ${counted.type}`);
    const expected = await readerIndex.searchChunk(
      { ...parseQuery("zazolc is:unread") },
      { limit: 500 },
    );
    expect(counted.count).toBe(expected.keys.length);
    expect(counted.count).toBeGreaterThan(0);
    expect(commands.at(-1)).toBe("countMatches");
    expect(searched).toEqual([]);
  });
});
