// Runs against the Dovecot container: `npm run test:imap` starts it and sets the variables.
// The whole path of ADR 0018 through the backend API: add an account, initial sync, IDLE,
// removal, typed failures. Real SQLite, real IMAP adapter, real clock; only the vault is fake.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImapConnector } from "@matters/adapter-imap";
import { PostalMimeParser } from "@matters/adapter-mime";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import type { BackendEvent, BackendResponse } from "@matters/contracts";
import { type ClockPort, RejectedPasswords, SyncScheduler } from "@matters/core";
import { FakeComposeRenderer, InMemoryCredentialStore } from "@matters/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../../../../packages/adapter-imap/test/support/admin.ts";
import { mail } from "../../../../packages/adapter-imap/test/support/mail.ts";
import { AccountService } from "../../src/backend/accounts.ts";
import { handle } from "../../src/backend/handler.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "../support/noSend.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};
const clock: ClockPort = {
  now: () => Date.now(),
  setTimeout(run, ms) {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  },
  random: () => Math.random(),
};

const SERVER = {
  host: credentials.host,
  port: credentials.port,
  security: "none" as const,
  username: credentials.user,
};

interface Rig {
  readonly storage: SqliteStorage;
  readonly vault: InMemoryCredentialStore;
  readonly scheduler: SyncScheduler;
  readonly rejected: RejectedPasswords;
  readonly events: BackendEvent[];
  readonly dbPath: string;
  call(request: object): Promise<BackendResponse>;
  add(over?: { password?: string; imap?: object }): Promise<BackendResponse>;
}

function rig(connectorOptions: { allowInsecure?: boolean } = { allowInsecure: true }): Rig {
  const dir = mkdtempSync(join(tmpdir(), "matters-accounts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "matters.db");
  const storage = createSqliteStorage(dbPath);
  cleanups.push(() => storage.close());
  const vault = new InMemoryCredentialStore();
  const connector = new ImapConnector({ parser: new PostalMimeParser(), ...connectorOptions });
  const events: BackendEvent[] = [];
  const rejected = new RejectedPasswords();
  const scheduler = new SyncScheduler({
    connector,
    accounts: storage.accounts,
    credentials: vault,
    sync: { ...storage },
    clock,
    onStatus: (accountId, status) => {
      rejected.note(accountId, status);
      events.push({ type: "syncStatus", accountId, status });
    },
  });
  cleanups.unshift(() => scheduler.stop());
  let n = 0;
  const accounts = new AccountService({
    accounts: storage.read.accounts,
    add: {
      accounts: storage.accounts,
      credentials: vault,
      connector,
      outgoing: { verify: async () => ({ ok: true }) },
      newId: () => `acc${++n}`,
      now: () => Date.now(),
    },
    remove: { ...storage, credentials: vault },
    discovery: { discover: async () => null },
    scheduler,
    rejected,
    onChanged: () => {},
  });
  const deps = {
    ...storage.read,
    accountStore: storage.read.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    accounts,
  };
  const call = (request: object) => handle(deps, { requestId: "r", ...request });
  return {
    storage,
    vault,
    scheduler,
    rejected,
    events,
    dbPath,
    call,
    add: (over = {}) =>
      call({
        type: "addAccount",
        address: credentials.user,
        password: over.password ?? credentials.pass,
        imap: over.imap ?? SERVER,
      }),
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe.skipIf(!enabled)("accounts against the Dovecot test server", () => {
  let admin: Admin;
  beforeEach(async () => {
    admin = await Admin.connect(credentials);
    await admin.reset();
    cleanups.push(() => admin.close());
  });

  const stored = (r: Rig) => r.storage.store.listNewest({ limit: 1000 });

  it("adds an account, runs the initial sync and delivers new mail through IDLE within 3 s", async () => {
    for (let i = 1; i <= 30; i++) {
      await admin.append("INBOX", mail({ id: `m${i}`, subject: `Wiadomość ${i}` }));
    }
    const r = rig();

    const added = await r.add();
    expect(added).toMatchObject({ type: "addAccount", ok: true, account: { id: "acc1" } });
    expect(JSON.stringify(added)).not.toContain(credentials.pass);

    await vi.waitFor(async () => expect(await stored(r)).toHaveLength(30), { timeout: 15_000 });
    await vi.waitFor(() => expect(r.scheduler.status("acc1")?.state).toBe("idle"), {
      timeout: 5000,
    });
    expect(r.events.some((e) => e.type === "syncStatus" && e.status.state === "syncing")).toBe(
      true,
    );
    // the watch is up: give IDLE a moment to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    const sentAt = performance.now();
    await admin.append("INBOX", mail({ id: "fresh", subject: "Świeża poczta" }));
    await vi.waitFor(
      async () => expect((await stored(r)).some((m) => m.subject === "Świeża poczta")).toBe(true),
      { timeout: 3000, interval: 25 },
    );
    const latency = Math.round(performance.now() - sentAt);
    console.log(`IDLE delivery: new mail stored ${latency} ms after the append`);
    expect(latency).toBeLessThan(3000);
    expect(await stored(r)).toHaveLength(31);
  }, 40_000);

  it("answers a wrong password with authFailed and stores nothing", async () => {
    const r = rig();
    const failed = await r.add({ password: "definitely-wrong-password" });
    expect(failed).toMatchObject({ type: "error", code: "authFailed" });
    expect(JSON.stringify(failed)).not.toContain("definitely-wrong-password");
    expect(await r.storage.accounts.list()).toEqual([]);
    expect(await r.vault.get("acc1")).toBeNull();
  });

  it("mends a password the server stopped taking, keeping the old one until a new one works", async () => {
    await admin.append("INBOX", mail({ id: "kept", subject: "Zostaje" }));
    const r = rig();
    await r.add();
    await vi.waitFor(async () => expect(await stored(r)).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(() => expect(r.scheduler.status("acc1")?.state).toBe("idle"), {
      timeout: 5000,
    });

    // The server now refuses what is saved, as after a revoked app password.
    const revoked = "revoked-app-password";
    await r.vault.set("acc1", { kind: "password", username: credentials.user, password: revoked });
    expect(await r.call({ type: "syncNow", accountId: "acc1" })).toMatchObject({ ok: true });
    await vi.waitFor(
      () =>
        expect(r.scheduler.status("acc1")).toMatchObject({
          state: "error",
          kind: "auth",
          detail: { refusal: "credentials" },
        }),
      { timeout: 5000 },
    );
    expect(JSON.stringify(r.events)).not.toContain(revoked);
    expect(r.rejected.has("acc1")).toBe(true);

    const wrong = await r.call({
      type: "changePassword",
      accountId: "acc1",
      password: "still-wrong",
    });
    expect(wrong).toMatchObject({
      type: "error",
      code: "authFailed",
      detail: { refusal: "credentials" },
    });
    expect(JSON.stringify(wrong)).not.toContain("still-wrong");
    expect(await r.vault.get("acc1")).toMatchObject({ password: revoked });
    expect(r.rejected.has("acc1")).toBe(true);

    const right = await r.call({
      type: "changePassword",
      accountId: "acc1",
      password: credentials.pass,
    });
    expect(right).toMatchObject({ type: "changePassword", ok: true, outgoing: "none" });
    expect(JSON.stringify(right)).not.toContain(credentials.pass);
    expect(r.rejected.has("acc1")).toBe(false);
    await vi.waitFor(() => expect(r.scheduler.status("acc1")?.state).toBe("idle"), {
      timeout: 10_000,
    });
    // Nothing local was lost, and mail that came meanwhile arrives.
    await admin.append("INBOX", mail({ id: "after", subject: "Po zmianie" }));
    await vi.waitFor(async () => expect(await stored(r)).toHaveLength(2), { timeout: 5000 });
  }, 40_000);

  it("refuses plaintext without the opt-in and names TLS and unreachable hosts", async () => {
    const strict = rig({ allowInsecure: false });
    expect(await strict.add()).toMatchObject({ type: "error", code: "insecureTransport" });

    const r = rig();
    expect(await r.add({ imap: { ...SERVER, security: "tls" } })).toMatchObject({
      type: "error",
      code: "tlsFailed",
    });
    expect(await r.add({ imap: { ...SERVER, port: 1 } })).toMatchObject({
      type: "error",
      code: "unreachable",
    });
    expect(await r.storage.accounts.list()).toEqual([]);
  });

  it("removes the account and every trace of its data", async () => {
    for (let i = 1; i <= 12; i++) {
      await admin.append("INBOX", mail({ id: `r${i}`, subject: `Do usunięcia ${i}` }));
    }
    const r = rig();
    await r.add();
    await vi.waitFor(async () => expect(await stored(r)).toHaveLength(12), { timeout: 15_000 });
    expect(await r.vault.get("acc1")).not.toBeNull();

    expect(await r.call({ type: "removeAccount", accountId: "acc1" })).toMatchObject({ ok: true });

    expect(await r.vault.get("acc1")).toBeNull();
    expect(r.scheduler.status("acc1")).toBeNull();
    const db = new DatabaseSync(r.dbPath, { readOnly: true });
    try {
      for (const table of [
        "accounts",
        "messages",
        "message_labels",
        "message_locations",
        "body_index",
        "body_blocks",
        "cursors",
      ]) {
        const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n, table).toBe(0);
      }
      // contentless FTS table: rows are counted through its docsize shadow table
      const fts = db.prepare("SELECT count(*) AS n FROM message_fts_docsize").get() as {
        n: number;
      };
      expect(fts.n).toBe(0);
    } finally {
      db.close();
    }
    const search = await r.call({ type: "search", query: "usunięcia", limit: 10 });
    expect(search).toMatchObject({ ok: true, messages: [] });

    // A mail arriving after removal finds nobody to sync it.
    await admin.append("INBOX", mail({ id: "after", subject: "Po usunięciu" }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await stored(r)).toEqual([]);
  }, 40_000);
});
