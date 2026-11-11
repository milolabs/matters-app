// Runs against the Dovecot container: `npm run test:imap` starts it and sets the variables.
// Moving mail (ADR 0044) through the sync runtime: archive, delete, spam and a folder with a real
// MOVE, the new copy swapped in without a download, a folder made when it is missing, Delete
// forever, and a read-state push on a copy that has just moved. Real SQLite and IMAP adapter;
// only the vault is fake. The Dovecot here has no OBJECTID: a message is known by its fingerprint.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { ImapConnector } from "@matters/adapter-imap";
import { PostalMimeParser } from "@matters/adapter-mime";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { type RpcPort, serveCredentials } from "@matters/adapter-secrets";
import { NodemailerComposer, NodemailerSubmit } from "@matters/adapter-smtp";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import { MAILBOX_BIT, parseQuery } from "@matters/core";
import { FakeFileWork, InMemoryCredentialStore } from "@matters/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../../../../packages/adapter-imap/test/support/admin.ts";
import { mail } from "../../../../packages/adapter-imap/test/support/mail.ts";
import type {
  CommandResult,
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../../src/backend/protocol.ts";
import { type SyncRuntime, startSyncRuntime, systemClock } from "../../src/backend/syncRuntime.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

interface Running {
  readonly storage: SqliteStorage;
  readonly runtime: SyncRuntime;
  readonly messages: FromWorker[];
  call<C extends WorkerCommand>(command: C): Promise<CommandResult<C>>;
  stop(): Promise<void>;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The sync runtime over an in-process channel, as the worker thread would host it. */
async function openRuntime(dbPath: string, vault: InMemoryCredentialStore): Promise<Running> {
  const storage = createSqliteStorage(dbPath, { reader: false });
  const handlers: ((m: ToWorker) => void)[] = [];
  const messages: FromWorker[] = [];
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let nextId = 0;
  let vaultHandler: (data: unknown) => void = () => {};
  const rpc: RpcPort = {
    postMessage: (data) => {
      for (const h of handlers) h({ type: "credentials", data });
    },
    onMessage: (h) => (vaultHandler = h),
  };
  serveCredentials(rpc, vault);
  const channel: WorkerChannel = {
    post(message) {
      messages.push(message);
      if (message.type === "credentials") vaultHandler(message.data);
      if (message.type === "result") {
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) w?.ok(message.value);
        else w?.fail(new Error(`${message.error.name}: ${message.error.message}`));
      }
    },
    onMessage: (h) => handlers.push(h),
  };
  const runtime = await startSyncRuntime({
    storage,
    connector: new ImapConnector({ parser: new PostalMimeParser(), allowInsecure: true }),
    channel,
    discovery: { discover: async () => null },
    registrableDomain,
    clock: systemClock,
    undoWindowMs: 300,
    files: new FakeFileWork(),
    sending: {
      renderer: new MarkdownComposeRenderer(),
      composer: new NodemailerComposer(),
      submit: new NodemailerSubmit({ allowInsecure: true }),
      sha256: (text) => text,
    },
  });
  const running: Running = {
    storage,
    runtime,
    messages,
    call: <C extends WorkerCommand>(command: C) =>
      new Promise<CommandResult<C>>((ok, fail) => {
        const id = ++nextId;
        waiting.set(id, { ok: ok as (v: unknown) => void, fail });
        for (const h of handlers) h({ type: "command", id, command });
      }),
    async stop() {
      await runtime.stop().catch(() => {});
    },
  };
  cleanups.push(() => running.stop());
  return running;
}

describe.skipIf(!enabled)("moving mail against Dovecot (ADR 0044)", () => {
  let admin: Admin;
  let dbPath: string;
  let vault: InMemoryCredentialStore;

  beforeEach(async () => {
    admin = await Admin.connect(credentials);
    await admin.reset();
    cleanups.push(() => admin.close());
    const dir = mkdtempSync(join(tmpdir(), "matters-moves-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = join(dir, "matters.db");
    vault = new InMemoryCredentialStore();
  });

  async function start(count: number): Promise<Running> {
    const rt = await openRuntime(dbPath, vault);
    if ((await rt.storage.accounts.list()).length === 0) {
      await rt.call({
        name: "addAccount",
        address: credentials.user,
        displayName: "Test",
        password: credentials.pass,
        imap: {
          host: credentials.host,
          port: credentials.port,
          security: "none",
          username: credentials.user,
        },
      });
    }
    await vi.waitFor(
      async () => expect((await rt.storage.store.changesSince(0)).changedKeys).toHaveLength(count),
      { timeout: 15_000 },
    );
    // The folders arrive with the first sync (rule 1).
    await vi.waitFor(async () => expect(await rt.storage.store.listFolders()).not.toEqual([]), {
      timeout: 5000,
    });
    return rt;
  }

  const all = async (rt: Running) =>
    rt.storage.store.getByKeys((await rt.storage.store.changesSince(0)).changedKeys);
  const bySubject = async (rt: Running, subject: string) => {
    const found = (await all(rt)).filter((m) => m.subject === subject);
    if (found.length !== 1) throw new Error(`expected one "${subject}", got ${found.length}`);
    return found[0] as NonNullable<(typeof found)[number]>;
  };
  const folders = async (rt: Running, key: number) =>
    (await rt.storage.store.getLocations(key)).map((l) => l.folderId).sort();
  const downloads = (rt: Running) =>
    rt.messages
      .filter((m) => m.type === "synced")
      .reduce((n, m) => n + (m.type === "synced" ? m.documents : 0), 0);
  const settled = (rt: Running) => async () =>
    expect(await rt.storage.moveOps.listPending()).toEqual([]);

  it("archives with a real MOVE: the copy is swapped in, and the message keeps its key, body and index entry", async () => {
    await admin.createFolder("Archive");
    const uid = await admin.append("INBOX", mail({ id: "mv-1", subject: "Do archiwum" }));
    const rt = await start(1);
    const before = await bySubject(rt, "Do archiwum");
    const downloaded = downloads(rt);
    expect(downloaded).toBe(1);

    const { operationId, keys } = await rt.call({
      name: "moveThread",
      threadId: before.threadId,
      action: "archive",
    });
    expect(keys).toEqual([before.key]);
    expect(operationId).not.toBeNull();
    // Local at once; the server is still as it was until the window is over.
    expect((await bySubject(rt, "Do archiwum")).labelIds).toEqual(["Archive"]);

    await vi.waitFor(settled(rt), { timeout: 8000, interval: 100 });
    expect((await admin.messages("INBOX")).map((m) => m.uid)).not.toContain(uid);
    expect(await admin.messages("Archive")).toHaveLength(1);

    // The new place replaced the old one in the same unit: nothing was deleted or fetched again.
    const after = await bySubject(rt, "Do archiwum");
    expect(after.key).toBe(before.key);
    expect(await folders(rt, after.key)).toEqual(["Archive"]);
    expect(after.mailboxes).toBe(MAILBOX_BIT.archive);
    expect((await rt.storage.bodies.getBodies([after.key])).get(after.key)).toContain("Treść");
    expect(await rt.storage.index.search(parseQuery("archiwum"), { limit: 5 })).toEqual([
      after.key,
    ]);

    // And a full sync agrees with it, without a download either.
    const [account] = await rt.storage.accounts.list();
    const syncs = rt.messages.filter((m) => m.type === "synced").length;
    await rt.call({ name: "syncNow", accountId: (account as NonNullable<typeof account>).id });
    await vi.waitFor(
      () => expect(rt.messages.filter((m) => m.type === "synced").length).toBeGreaterThan(syncs),
      { timeout: 8000 },
    );
    expect(downloads(rt)).toBe(downloaded);
    const synced = await bySubject(rt, "Do archiwum");
    expect(synced.key).toBe(before.key);
    expect(await folders(rt, synced.key)).toEqual(["Archive"]);
    expect((await rt.storage.bodies.getBodies([synced.key])).size).toBe(1);
  });

  it("makes the Archive, Trash and Junk folders when the account has none (rule 14)", async () => {
    await admin.append("INBOX", mail({ id: "mk-1", subject: "Jeden" }));
    await admin.append("INBOX", mail({ id: "mk-2", subject: "Dwa" }));
    await admin.append("INBOX", mail({ id: "mk-3", subject: "Trzy" }));
    const rt = await start(3);
    for (const [subject, action] of [
      ["Jeden", "archive"],
      ["Dwa", "delete"],
      ["Trzy", "spam"],
    ] as const) {
      const m = await bySubject(rt, subject);
      await rt.call({ name: "moveThread", threadId: m.threadId, action });
    }
    await vi.waitFor(settled(rt), { timeout: 10_000, interval: 100 });
    expect((await admin.messages("Archive")).length).toBe(1);
    expect((await admin.messages("Trash")).length).toBe(1);
    expect((await admin.messages("Junk")).length).toBe(1);
    expect(await admin.messages("INBOX")).toHaveLength(0);
    // The next sync learns the folders; the mail is where the roles say.
    expect((await bySubject(rt, "Dwa")).mailboxes).toBe(MAILBOX_BIT.trash);
    const [account] = await rt.storage.accounts.list();
    await rt.call({ name: "syncNow", accountId: (account as NonNullable<typeof account>).id });
    await vi.waitFor(
      async () => {
        const roles = (await rt.storage.store.listFolders()).map((f) => `${f.id}:${f.role}`);
        expect(roles).toEqual(
          expect.arrayContaining(["Archive:archive", "Trash:trash", "Junk:spam"]),
        );
      },
      { timeout: 8000 },
    );
    expect((await rt.storage.read.store.listNewest({ limit: 10 })).map((m) => m.subject)).toEqual([
      "Jeden",
    ]);
  });

  it("undoes inside the window: the server never hears of it", async () => {
    await admin.append("INBOX", mail({ id: "un-1", subject: "Cofnięty" }));
    const rt = await start(1);
    const m = await bySubject(rt, "Cofnięty");
    // A window long enough for the test to take the move back in time.
    const { operationId } = await rt.call({
      name: "moveThread",
      threadId: m.threadId,
      action: "delete",
    });
    const undone = await rt.call({ name: "undoMove", operationId: operationId as string });
    expect(undone.kind).toBe("undone");
    expect(await bySubject(rt, "Cofnięty")).toEqual(m);
    await new Promise((r) => setTimeout(r, 700));
    expect(await admin.messages("INBOX")).toHaveLength(1);
    expect(await rt.storage.moveOps.listPending()).toEqual([]);
  });

  it("moves to a folder, and out of Trash back to the inbox", async () => {
    await admin.createFolder("Clients");
    await admin.createFolder("Trash");
    await admin.append("INBOX", mail({ id: "fo-1", subject: "Do klienta" }));
    await admin.append("Trash", mail({ id: "fo-2", subject: "Z kosza" }));
    const rt = await start(2);
    const a = await bySubject(rt, "Do klienta");
    await rt.call({
      name: "moveThread",
      threadId: a.threadId,
      action: "move",
      target: { folderId: "Clients" },
    });
    const b = await bySubject(rt, "Z kosza");
    expect(b.mailboxes).toBe(MAILBOX_BIT.trash);
    await rt.call({
      name: "moveThread",
      threadId: b.threadId,
      action: "move",
      target: { role: "inbox" },
      hidden: true,
    });
    await vi.waitFor(settled(rt), { timeout: 8000, interval: 100 });
    expect(await admin.messages("Clients")).toHaveLength(1);
    expect((await admin.messages("INBOX")).length).toBe(1);
    expect(await admin.messages("Trash")).toHaveLength(0);
    expect(await folders(rt, a.key)).toEqual(["Clients"]);
    expect(await folders(rt, b.key)).toEqual(["INBOX"]);
    expect((await bySubject(rt, "Z kosza")).key).toBe(b.key);
  });

  it("settles a move whose copy is already gone: stale, no loss, no duplicate", async () => {
    await admin.createFolder("Archive");
    const uid = await admin.append("INBOX", mail({ id: "st-1", subject: "Już przeniesiony" }));
    const rt = await start(1);
    const m = await bySubject(rt, "Już przeniesiony");
    await rt.call({ name: "moveThread", threadId: m.threadId, action: "archive" });
    // The server did it on its own before the push: the app went down between move and settling.
    await admin.move("INBOX", uid, "Archive");
    await vi.waitFor(settled(rt), { timeout: 8000, interval: 100 });
    expect(await admin.messages("Archive")).toHaveLength(1);
    expect(await admin.messages("INBOX")).toHaveLength(0);
    // The old location waits for the sync that the push asked for.
    await vi.waitFor(async () => expect(await folders(rt, m.key)).toEqual(["Archive"]), {
      timeout: 10_000,
      interval: 100,
    });
    expect(await all(rt)).toHaveLength(1);
    expect((await bySubject(rt, "Już przeniesiony")).key).toBe(m.key);
  });

  it("deletes for good only in Trash, and the message leaves the store when the server did it", async () => {
    await admin.createFolder("Trash");
    await admin.createFolder("Clients");
    await admin.append("INBOX", mail({ id: "df-1", subject: "W skrzynce" }));
    await admin.append("Trash", mail({ id: "df-2", subject: "W koszu" }));
    await admin.append("Clients", mail({ id: "df-3", subject: "U klienta" }));
    const rt = await start(3);
    const inbox = await bySubject(rt, "W skrzynce");
    const bin = await bySubject(rt, "W koszu");
    const clients = await bySubject(rt, "U klienta");

    // The core refuses the others whatever asked.
    const refused = await rt.call({ name: "deleteForever", keys: [inbox.key, clients.key] });
    expect(refused).toMatchObject({ queued: [], removed: [] });
    expect([...refused.refused].sort()).toEqual([inbox.key, clients.key].sort());

    const result = await rt.call({ name: "deleteForever", keys: [bin.key, inbox.key] });
    expect(result.queued).toEqual([bin.key]);
    await vi.waitFor(settled(rt), { timeout: 8000, interval: 100 });
    expect(await admin.messages("Trash")).toHaveLength(0);
    expect(await rt.storage.store.getByKeys([bin.key])).toEqual([]);
    expect((await rt.storage.bodies.getBodies([bin.key])).size).toBe(0);
    expect(await rt.storage.index.search(parseQuery("in:trash"), { limit: 5 })).toEqual([]);
    // The rest is where it was, on the server and here.
    expect(await admin.messages("INBOX")).toHaveLength(1);
    expect(await admin.messages("Clients")).toHaveLength(1);
    expect(await rt.storage.store.getByKeys([inbox.key, clients.key])).toHaveLength(2);
  });

  it("drops a read-state push on a copy that has just moved, and corrupts nothing (ADR 0039)", async () => {
    await admin.createFolder("Archive");
    const uid = await admin.append("INBOX", mail({ id: "rs-1", subject: "Przeczytany po ruchu" }));
    const rt = await start(1);
    const m = await bySubject(rt, "Przeczytany po ruchu");
    // The server moved it, and the app has not heard: its location is the old one.
    await admin.move("INBOX", uid, "Archive");
    await rt.call({ name: "setSeen", keys: [m.key], seen: true });
    await vi.waitFor(async () => expect(await rt.storage.flagOps.listPending()).toEqual([]), {
      timeout: 8000,
      interval: 100,
    });
    // The UID is gone from the inbox: nothing was flagged anywhere, and nothing complained.
    expect((await admin.messages("Archive"))[0]?.flags).not.toContain("\\Seen");
    expect(await admin.messages("INBOX")).toHaveLength(0);
    // Sync finds the message where it is now: one message, in the Archive, never two.
    const [account] = await rt.storage.accounts.list();
    await rt.call({ name: "syncNow", accountId: (account as NonNullable<typeof account>).id });
    await vi.waitFor(
      async () => {
        const mine = (await all(rt)).filter((x) => x.subject === "Przeczytany po ruchu");
        expect(mine).toHaveLength(1);
        expect(await folders(rt, (mine[0] as NonNullable<(typeof mine)[number]>).key)).toEqual([
          "Archive",
        ]);
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it("finds a move that a quit left behind and does it at the next start", async () => {
    await admin.createFolder("Archive");
    const uid = await admin.append("INBOX", mail({ id: "qq-1", subject: "Zostawiony" }));
    const first = await start(1);
    const m = await bySubject(first, "Zostawiony");
    // Stopped before the window ended and before the push could go.
    await first.call({ name: "moveThread", threadId: m.threadId, action: "archive" });
    await first.stop();
    expect((await admin.messages("INBOX")).map((x) => x.uid)).toContain(uid);

    const second = await start(1);
    await vi.waitFor(settled(second), { timeout: 8000, interval: 100 });
    expect(await admin.messages("INBOX")).toHaveLength(0);
    expect(await admin.messages("Archive")).toHaveLength(1);
    expect((await bySubject(second, "Zostawiony")).key).toBe(m.key);
  });
});
