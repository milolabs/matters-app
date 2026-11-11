// Runs against the Dovecot container: `npm run test:imap` starts it and sets the variables.
// Marking read (ADR 0039) through the sync runtime: the local flag at once, the server a second
// later, a sync that cannot undo what is not pushed, and a quit before the push. Real SQLite and
// IMAP adapter; only the vault is fake.
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

describe.skipIf(!enabled)("marking read against Dovecot (ADR 0039)", () => {
  let admin: Admin;
  let dbPath: string;
  let vault: InMemoryCredentialStore;
  let uid: number;

  beforeEach(async () => {
    admin = await Admin.connect(credentials);
    await admin.reset();
    cleanups.push(() => admin.close());
    const dir = mkdtempSync(join(tmpdir(), "matters-seen-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = join(dir, "matters.db");
    vault = new InMemoryCredentialStore();
    uid = await admin.append("INBOX", mail({ id: "seen-1", subject: "Do przeczytania" }));
  });

  const serverFlags = async () => (await admin.messages("INBOX")).find((m) => m.uid === uid)?.flags;

  async function start(): Promise<{ rt: Running; key: number }> {
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
      async () => expect(await rt.storage.store.listNewest({ limit: 10 })).toHaveLength(1),
      { timeout: 15_000 },
    );
    const [first] = await rt.storage.store.listNewest({ limit: 1 });
    return { rt, key: (first as NonNullable<typeof first>).key };
  }

  const localSeen = async (rt: Running, key: number) =>
    (await rt.storage.store.getByKeys([key]))[0]?.flags.seen;

  it("sets the flag locally at once, and on the server about a second later", async () => {
    const { rt, key } = await start();
    expect(await serverFlags()).not.toContain("\\Seen");

    const result = await rt.call({ name: "setSeen", keys: [key], seen: true });
    expect(result.changedKeys).toEqual([key]);
    expect(await localSeen(rt, key)).toBe(true);
    expect(await rt.storage.flagOps.listPending()).toHaveLength(1);
    expect(await serverFlags()).not.toContain("\\Seen");

    await vi.waitFor(async () => expect(await serverFlags()).toContain("\\Seen"), {
      timeout: 8000,
      interval: 100,
    });
    await vi.waitFor(async () => expect(await rt.storage.flagOps.listPending()).toEqual([]), {
      timeout: 5000,
    });

    // And back: the unread state travels the same way.
    await rt.call({ name: "setSeen", keys: [key], seen: false });
    await vi.waitFor(async () => expect(await serverFlags()).not.toContain("\\Seen"), {
      timeout: 8000,
      interval: 100,
    });
  });

  it("a sync from the server's older state does not undo a change that was not pushed", async () => {
    const { rt, key } = await start();
    const [account] = await rt.storage.accounts.list();
    // The server's flags change (another device flagged it), so the next sync carries flags
    // for this message: with the old read state in them.
    await admin.flagAdd("INBOX", uid, ["\\Flagged"]);
    await rt.call({ name: "setSeen", keys: [key], seen: true });
    await rt.call({ name: "syncNow", accountId: (account as NonNullable<typeof account>).id });

    await vi.waitFor(
      async () => {
        const m = (await rt.storage.store.getByKeys([key]))[0];
        expect(m?.flags.flagged).toBe(true);
        expect(m?.flags.seen).toBe(true);
      },
      { timeout: 8000, interval: 100 },
    );
    await vi.waitFor(async () => expect(await serverFlags()).toContain("\\Seen"), {
      timeout: 8000,
      interval: 100,
    });
    expect(await serverFlags()).toContain("\\Flagged");
  });

  it("finds the request again when the app quit before it was pushed", async () => {
    const first = await start();
    await first.rt.call({ name: "setSeen", keys: [first.key], seen: true });
    expect(await first.rt.storage.flagOps.listPending()).toHaveLength(1);
    // Stopping closes the database, as quitting the app does.
    await first.rt.stop();
    expect(await serverFlags()).not.toContain("\\Seen");

    const second = await start();
    expect(await localSeen(second.rt, second.key)).toBe(true);
    await vi.waitFor(async () => expect(await serverFlags()).toContain("\\Seen"), {
      timeout: 8000,
      interval: 100,
    });
  });
});
