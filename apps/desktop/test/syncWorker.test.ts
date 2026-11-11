// The sync worker is a real worker thread here (same runtime as the app, scripted mail source),
// supervised by the same SyncHost the router uses.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { RpcPort } from "@matters/adapter-secrets";
import { createSqliteReader } from "@matters/adapter-sqlite";
import type { SyncStatus } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialRelay } from "../src/backend/credentialRelay.ts";
import { handle } from "../src/backend/handler.ts";
import { RemoteAccounts } from "../src/backend/remoteAccounts.ts";
import { SyncHost, WorkerCommandError, WorkerUnavailableError } from "../src/backend/syncHost.ts";
import type { CrashWorkerConfig } from "./support/crashWorker.ts";

const ACCOUNT = "acc-crash";
const BATCHES = 6;
const SIZE = 50;
const STALL_BATCH = 3;
const TOTAL = BATCHES * SIZE;
const workerUrl = new URL("./support/crashWorker.ts", import.meta.url);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function rig(stallFirstWorker: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "matters-worker-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "matters.db");
  const workers: Worker[] = [];
  const state = {
    stalled: false,
    crashes: [] as string[],
    restarts: 0,
    committed: 0,
    statuses: [] as SyncStatus[],
    synced: 0,
  };
  const host = new SyncHost({
    spawn() {
      const config: CrashWorkerConfig = {
        dbPath,
        accountId: ACCOUNT,
        batches: BATCHES,
        batchSize: SIZE,
        stallBatch: stallFirstWorker && workers.length === 0 ? STALL_BATCH : null,
      };
      const worker = new Worker(workerUrl, { workerData: config });
      worker.on("message", (m: { type?: string }) => {
        if (m.type === "test:inUnit") state.stalled = true;
      });
      workers.push(worker);
      return worker;
    },
    handlers: {
      onStatus: (_id, status) => state.statuses.push(status),
      onCommitted: () => state.committed++,
      onOutbox: () => {},
      onMoves: () => {},
      onAgent: () => {},
      onMoveRefused: () => {},
      onAttachments: () => {},
      onAttachmentProgress: () => {},
      onSendProgress: () => {},
      onReceivedProgress: () => {},
      onAgentTalkStep: () => {},
      onCaptured: () => {},
      onSynced: () => state.synced++,
      onCredentials(data, reply) {
        const { id, op } = data as { id: number; op: string };
        const value =
          op === "availability"
            ? { available: true }
            : { kind: "password", username: "crash", password: "test-only" };
        reply({ id, ok: true, value });
      },
      onCrash: (reason) => state.crashes.push(reason),
      onRestarted: () => state.restarts++,
    },
    backoffBaseMs: 20,
    backoffCapMs: 100,
  });
  cleanups.push(() => host.stop(1000));
  return { dbPath, workers, state, host };
}

/** What a second, independent connection finds in the file: the invariants of a clean store. */
function inspect(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const cursor = db.prepare("SELECT cursor_json AS c FROM cursors").get() as
      | { c: string }
      | undefined;
    return {
      messages: n("SELECT count(*) AS n FROM messages"),
      distinctKeys: n("SELECT count(DISTINCT key) AS n FROM messages"),
      locations: n("SELECT count(*) AS n FROM message_locations"),
      bodies: n("SELECT count(*) AS n FROM body_index"),
      indexed: n("SELECT count(*) AS n FROM message_fts"),
      labels: n("SELECT count(DISTINCT message_key) AS n FROM message_labels"),
      lastUid: cursor ? Number((JSON.parse(cursor.c) as { lastUid: string }).lastUid) : 0,
      integrity: (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    };
  } finally {
    db.close();
  }
}

describe("sync worker thread", () => {
  it("killed while a batch is open: no half batch, reads never fail, the sync resumes", async () => {
    const { dbPath, workers, state, host } = rig(true);
    await host.start();

    const reader = createSqliteReader(dbPath);
    cleanups.push(() => reader.close());
    const counts: number[] = [];
    let reads = 0;
    const failures: unknown[] = [];
    let polling = true;
    // The router's reads, as fast as the event loop allows, for the whole run.
    const poll = (async () => {
      while (polling) {
        try {
          // Two snapshots: the list first, so a commit in between can only add to the changes.
          const newest = await reader.read.store.listNewest({ limit: 20 });
          const { changedKeys } = await reader.read.store.changesSince(0);
          await reader.read.accounts.list();
          counts.push(changedKeys.length);
          if (newest.length > changedKeys.length) throw new Error("list shows more than changes");
          reads++;
        } catch (error) {
          failures.push(error);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    // Batches 1 and 2 are committed; batch 3 is written but its transaction is still open.
    await until(() => state.stalled, "the worker to hold batch 3 open");
    expect(inspect(dbPath)).toMatchObject({ messages: 2 * SIZE, lastUid: 2 * SIZE });
    expect((await reader.read.store.listNewest({ limit: 1000 })).length).toBe(2 * SIZE);

    await workers[0]?.terminate();
    await until(() => state.crashes.length > 0, "the host to notice the crash");
    expect(host.running).toBe(false);
    await expect(host.command({ name: "syncNow", accountId: ACCOUNT })).rejects.toBeInstanceOf(
      WorkerUnavailableError,
    );

    // Nothing of batch 3 survived, and everything else is consistent.
    const afterCrash = inspect(dbPath);
    expect(afterCrash).toEqual({
      messages: 2 * SIZE,
      distinctKeys: 2 * SIZE,
      locations: 2 * SIZE,
      bodies: 2 * SIZE,
      indexed: 2 * SIZE,
      labels: 2 * SIZE,
      lastUid: 2 * SIZE,
      integrity: "ok",
    });
    expect((await reader.read.store.listNewest({ limit: 1000 })).length).toBe(2 * SIZE);

    // A new worker starts by itself and finishes from the cursor, without duplicates.
    await until(() => state.restarts === 1, "the replacement worker");
    await until(() => inspect(dbPath).messages === TOTAL, "the resumed sync to finish");
    await until(() => state.synced > 0, "the sync to report completion");
    polling = false;
    await poll;

    expect(inspect(dbPath)).toEqual({
      messages: TOTAL,
      distinctKeys: TOTAL,
      locations: TOTAL,
      bodies: TOTAL,
      indexed: TOTAL,
      labels: TOTAL,
      lastUid: TOTAL,
      integrity: "ok",
    });
    expect(failures).toEqual([]);
    expect(reads).toBeGreaterThan(20);
    // The reader only ever saw whole batches, and never fewer than before.
    expect(counts.every((c) => c % SIZE === 0)).toBe(true);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts.at(-1)).toBe(TOTAL);
    expect(state.crashes).toHaveLength(1);
  }, 60_000);

  it("runs commands in the worker and answers unknown accounts with false", async () => {
    const { state, host, dbPath } = rig(false);
    await host.start();
    await until(() => state.synced > 0, "the first sync");
    expect(await host.command({ name: "syncNow", accountId: ACCOUNT })).toBe(true);
    expect(await host.command({ name: "syncNow", accountId: "nobody" })).toBe(false);
    expect(await host.command({ name: "removeAccount", accountId: "nobody" })).toBe(false);
    expect(inspect(dbPath).messages).toBe(TOTAL);

    // A failing command keeps its name and kind, so the router can classify it again.
    const bad = await host
      .command({
        name: "addAccount",
        address: "crash@example.com",
        displayName: "",
        password: "test-only",
        imap: { host: "127.0.0.1", port: 1, security: "none", username: "crash" },
      })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(WorkerCommandError);
    expect((bad as Error).name).toBe("AccountExistsError");
  }, 30_000);

  it("writes image rules in the worker, and the reader connection sees them (ADR 0037)", async () => {
    const { host, dbPath } = rig(false);
    await host.start();
    const rule = await host.command({
      name: "setImageRule",
      scope: "domain",
      value: "shop.example",
      decision: "allow",
    });
    expect(rule).toMatchObject({ scope: "domain", value: "shop.example", decision: "allow" });
    expect(
      await host.command({ name: "importImageAddresses", addresses: ["a@shop.example", "x"] }),
    ).toBe(1);
    await host.command({ name: "setGeneralImages", general: "always" });
    await host.command({ name: "stopImages", address: "a@shop.example", source: "address-allow" });

    const reader = createSqliteReader(dbPath);
    try {
      expect(
        (await reader.read.imageRules.list())
          .map((r) => `${r.scope}:${r.value}:${r.decision}`)
          .sort(),
      ).toEqual(["address:a@shop.example:deny", "domain:shop.example:allow"]);
      expect(await reader.read.imageRules.getGeneral()).toBe("always");
    } finally {
      reader.close();
    }
    // A refused rule keeps its name, so the router answers it as a bad request.
    const bad = await host
      .command({ name: "setImageRule", scope: "domain", value: "co.uk", decision: "allow" })
      .catch((e: unknown) => e);
    expect((bad as Error).name).toBe("InvalidImageRuleError");
  }, 30_000);

  it("stops cleanly: the writer is closed and the file holds whole batches only", async () => {
    const { state, host, dbPath, workers } = rig(false);
    await host.start();
    await until(() => state.committed > 0, "a first commit");
    await host.stop(3000);
    await until(() => workers[0]?.threadId === -1, "the thread to end");
    const after = inspect(dbPath);
    expect(after.messages % SIZE).toBe(0);
    expect(after).toMatchObject({
      integrity: "ok",
      locations: after.messages,
      indexed: after.messages,
    });
    expect(state.crashes).toEqual([]);
  }, 30_000);
});

describe("CredentialRelay", () => {
  it("renumbers requests so a restarted worker never receives its predecessor's answer", async () => {
    const toMain: unknown[] = [];
    let fromMain: (data: unknown) => void = () => {};
    const port: RpcPort = {
      postMessage: (m) => toMain.push(m),
      onMessage: (h) => {
        fromMain = h;
      },
    };
    const relay = new CredentialRelay(Promise.resolve(port));
    await Promise.resolve();
    const oldWorker: unknown[] = [];
    const newWorker: unknown[] = [];

    relay.fromWorker({ id: 1, op: "get", accountId: "a" }, (d) => oldWorker.push(d));
    await Promise.resolve();
    // The old worker died; its replacement counts from 1 again.
    relay.fromWorker({ id: 1, op: "get", accountId: "b" }, (d) => newWorker.push(d));
    await Promise.resolve();

    const ids = toMain.map((m) => (m as { id: number }).id);
    expect(new Set(ids).size).toBe(2);
    fromMain({ id: ids[1], ok: true, value: "for-b" });
    fromMain({ id: ids[0], ok: true, value: "for-a" });
    expect(newWorker).toEqual([{ id: 1, ok: true, value: "for-b" }]);
    expect(oldWorker).toEqual([{ id: 1, ok: true, value: "for-a" }]);
    // An answer nobody waits for is dropped.
    fromMain({ id: 999, ok: true });
    expect(newWorker).toHaveLength(1);
  });
});

describe("RemoteAccounts", () => {
  const stored = {
    id: "a1",
    address: "me@example.com",
    displayName: "Me",
    imap: { host: "imap.example.com", port: 993, security: "tls" as const, username: "me" },
    createdAtMs: 1,
  };

  function accountsOver(command: (c: unknown) => Promise<unknown>) {
    const statuses = new Map<string, SyncStatus>();
    const events: string[] = [];
    const accounts = new RemoteAccounts({
      accounts: { list: async () => [stored] },
      discovery: { discover: async () => null },
      host: { command } as unknown as SyncHost,
      statuses,
      onChanged: () => events.push("changed"),
    });
    return { accounts, statuses, events, call: (r: object) => handle(deps(accounts), r) };
  }
  const deps = (accounts: RemoteAccounts) =>
    ({
      store: {},
      index: {},
      bodies: {},
      accounts,
    }) as unknown as Parameters<typeof handle>[0];

  it("lists from the reader with the status the worker last reported", async () => {
    const t = accountsOver(async () => true);
    expect((await t.accounts.list())[0]?.status).toEqual({ state: "idle" });
    t.statuses.set("a1", { state: "syncing", folder: "INBOX", done: 5 });
    expect((await t.accounts.list())[0]?.status).toMatchObject({ state: "syncing", done: 5 });
  });

  it("answers worker failures with the same codes as before the split", async () => {
    const exists = accountsOver(async () => {
      throw new WorkerCommandError({ name: "AccountExistsError", message: "exists" });
    });
    const request = {
      requestId: "r",
      type: "addAccount",
      address: "me@example.com",
      password: "pw",
      imap: { host: "h", port: 993, security: "tls", username: "me" },
    };
    expect(await exists.call(request)).toMatchObject({ ok: false, code: "accountExists" });

    const auth = accountsOver(async () => {
      throw new WorkerCommandError({ name: "ImapError", message: "no", kind: "auth" });
    });
    expect(await auth.call(request)).toMatchObject({ ok: false, code: "authFailed" });

    const down = accountsOver(async () => {
      throw new WorkerUnavailableError();
    });
    expect(await down.call(request)).toMatchObject({ ok: false, code: "internal" });
    expect(await down.call({ requestId: "r", type: "syncNow", accountId: "a1" })).toMatchObject({
      ok: false,
    });
    expect(down.events).toEqual([]);
  });

  it("announces added and removed accounts and forgets the status of a removed one", async () => {
    const t = accountsOver(async (c) =>
      (c as { name: string }).name === "removeAccount"
        ? true
        : { account: { id: "a2", status: { state: "idle" } }, folderCount: 1 },
    );
    await t.accounts.add({ address: "x@y.z", displayName: "", password: "p", imap: stored.imap });
    expect(t.statuses.has("a2")).toBe(true);
    expect(await t.accounts.remove("a2")).toBe(true);
    expect(t.statuses.has("a2")).toBe(false);
    expect(t.events).toEqual(["changed", "changed"]);
  });
});
