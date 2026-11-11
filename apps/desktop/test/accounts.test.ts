import type { BackendEvent, BackendResponse } from "@matters/contracts";
import type { DiscoveredServers, ServerDiscoveryPort } from "@matters/core";
import { SyncScheduler } from "@matters/core";
import {
  createInMemoryStorage,
  FakeComposeRenderer,
  FakeMailConnector,
  FakeMailError,
  FakeMailSync,
  InMemoryCredentialStore,
  ManualClock,
  settle,
} from "@matters/testkit";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { AccountService } from "../src/backend/accounts.ts";
import { handle } from "../src/backend/handler.ts";
import { ChangePublisher } from "../src/backend/publisher.ts";
import { accountMarks } from "../src/renderer/accountMarks.ts";
import { createAccountsStore } from "../src/renderer/accounts.ts";
import type { Backend } from "../src/renderer/client.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const PASSWORD = "s3cret-Pa$$w0rd";
const IMAP = { host: "imap.example.com", port: 993, security: "tls" as const, username: "me" };

function setup() {
  const storage = createInMemoryStorage();
  const server = new FakeMailSync(["INBOX"]);
  const connector = new FakeMailConnector(server);
  const credentials = new InMemoryCredentialStore();
  const clock = new ManualClock();
  const events: BackendEvent[] = [];
  const asked: string[] = [];
  const found: DiscoveredServers = {
    source: "ispdb",
    imap: {
      host: "imap.example.com",
      port: 993,
      security: "tls",
      usernameTemplate: "%EMAILADDRESS%",
      auth: ["password"],
    },
  };
  const discovery: ServerDiscoveryPort = {
    discover: async (domain) => {
      asked.push(domain);
      return domain === "example.com" ? found : null;
    },
  };
  const scheduler = new SyncScheduler({
    connector,
    accounts: storage.accounts,
    credentials,
    sync: storage,
    clock,
    onStatus: (accountId, status) => events.push({ type: "syncStatus", accountId, status }),
  });
  let n = 0;
  const accounts = new AccountService({
    accounts: storage.accounts,
    add: {
      accounts: storage.accounts,
      credentials,
      connector,
      outgoing: { verify: async () => ({ ok: true }) },
      newId: () => `acc${++n}`,
      now: () => 1000,
    },
    remove: { ...storage, credentials },
    discovery,
    scheduler,
    onChanged: () => events.push({ type: "accountsChanged" }),
  });
  const deps = {
    ...storage,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    accounts,
  };
  const call = (request: object) => handle(deps, { requestId: "r", ...request });
  const add = (over: object = {}) =>
    call({
      type: "addAccount",
      address: "me@example.com",
      password: PASSWORD,
      imap: IMAP,
      ...over,
    });
  return { storage, server, connector, credentials, scheduler, events, asked, call, add };
}

const noPassword = (value: unknown) => expect(JSON.stringify(value)).not.toContain(PASSWORD);

describe("account requests", () => {
  it("discovers servers from the domain alone", async () => {
    const t = setup();
    const r = await t.call({ type: "discoverServers", domain: "example.com" });
    expect(r).toMatchObject({ type: "discoverServers", ok: true, found: { source: "ispdb" } });
    expect(t.asked).toEqual(["example.com"]);
    expect(await t.call({ type: "discoverServers", domain: "nobody.example" })).toMatchObject({
      ok: true,
      found: null,
    });
    expect(await t.call({ type: "discoverServers", domain: 5 })).toMatchObject({
      code: "invalidRequest",
    });
  });

  it("adds an account: logs in, keeps the password in the vault only, starts the sync", async () => {
    const t = setup();
    t.server.add("INBOX", "first");

    const r = await t.add();

    expect(r).toMatchObject({
      type: "addAccount",
      ok: true,
      folderCount: 1,
      account: { id: "acc1", address: "me@example.com", host: "imap.example.com" },
    });
    noPassword(r);
    expect(await t.credentials.get("acc1")).toMatchObject({ password: PASSWORD });
    expect(t.events).toContainEqual({ type: "accountsChanged" });

    await settle();
    expect((await t.storage.store.listNewest({ limit: 5 })).map((m) => m.subject)).toEqual([
      "first",
    ]);
    const listed = await t.call({ type: "listAccounts" });
    expect(listed).toMatchObject({
      ok: true,
      accounts: [{ id: "acc1", status: { state: "idle" } }],
    });
    noPassword(listed);
    await t.scheduler.stop();
  });

  it("answers a wrong password with authFailed, stores nothing and leaks nothing", async () => {
    const t = setup();
    t.connector.acceptedPasswords.add("another");
    const r = await t.add();
    expect(r).toMatchObject({ type: "error", ok: false, code: "authFailed" });
    noPassword(r);
    expect(await t.storage.accounts.list()).toEqual([]);
    expect(await t.credentials.get("acc1")).toBeNull();
  });

  it("maps connection failures to the codes the setup screen shows", async () => {
    for (const [kind, code] of [
      ["tls", "tlsFailed"],
      ["unreachable", "unreachable"],
      ["insecure", "insecureTransport"],
    ] as const) {
      const t = setup();
      t.connector.connectErrors.push(new FakeMailError(kind, `${kind} problem with ${PASSWORD}`));
      const r = await t.add();
      expect(r).toMatchObject({ type: "error", code });
      noPassword(r);
    }
  });

  it("refuses to save when the vault cannot protect the password", async () => {
    const t = setup();
    t.credentials.unavailableReason = "No keyring is available";
    const r = await t.add();
    expect(r).toMatchObject({
      type: "error",
      code: "credentialsUnavailable",
      message: "No keyring is available",
    });
    expect(t.connector.connects).toBe(0);
  });

  it("rejects bad input, a duplicate and malformed requests", async () => {
    const t = setup();
    expect(await t.add({ address: "nope" })).toMatchObject({ code: "invalidAccount" });
    expect(await t.add({ password: "" })).toMatchObject({ code: "invalidAccount" });
    expect(await t.add({ imap: { ...IMAP, security: "ssl" } })).toMatchObject({
      code: "invalidRequest",
    });
    expect(await t.add({ password: 7 })).toMatchObject({ code: "invalidRequest" });
    expect(await t.add()).toMatchObject({ ok: true });
    expect(await t.add({ address: "ME@example.com" })).toMatchObject({ code: "accountExists" });
    await t.scheduler.stop();
  });

  it("removes an account with all its data and its password, asks for no second removal", async () => {
    const t = setup();
    t.server.add("INBOX", "a");
    await t.add();
    await settle();
    const [mail] = await t.storage.store.listNewest({ limit: 5 });
    expect(mail).toBeDefined();
    const sender = (mail as NonNullable<typeof mail>).from.address.toLowerCase();
    const people = async () => {
      const r = await t.call({ type: "suggestPeople", prefix: sender.split("@")[0], limit: 5 });
      return r.type === "suggestPeople" ? r.people.map((p) => p.address) : [];
    };
    expect(await people()).toContain(sender);

    expect(await t.call({ type: "removeAccount", accountId: "acc1" })).toMatchObject({
      type: "removeAccount",
      ok: true,
    });
    // ADR 0028: the people of the removed mail are no longer suggested.
    expect(await people()).toEqual([]);

    expect(await t.storage.store.listNewest({ limit: 5 })).toEqual([]);
    expect(await t.storage.accounts.list()).toEqual([]);
    expect(await t.storage.cursors.get("acc1", "INBOX")).toBeNull();
    expect(await t.credentials.get("acc1")).toBeNull();
    expect(t.scheduler.status("acc1")).toBeNull();
    expect(t.connector.watchesOpen).toBe(0);
    expect(await t.call({ type: "removeAccount", accountId: "acc1" })).toMatchObject({
      code: "notFound",
    });
  });

  it("syncs now on request and refuses an unknown account", async () => {
    const t = setup();
    await t.add();
    await settle();
    t.server.add("INBOX", "later");
    expect(await t.call({ type: "syncNow", accountId: "acc1" })).toMatchObject({ ok: true });
    await settle();
    expect(await t.storage.store.listNewest({ limit: 5 })).toHaveLength(1);
    expect(await t.call({ type: "syncNow", accountId: "nope" })).toMatchObject({
      code: "notFound",
    });
    await t.scheduler.stop();
  });

  it("returns messages by key, in the order asked", async () => {
    const t = setup();
    t.server.add("INBOX", "a");
    t.server.add("INBOX", "b");
    await t.add();
    await settle();
    const list = await t.storage.store.listNewest({ limit: 5 });
    const keys = list.map((m) => m.key).reverse();
    const r = await t.call({ type: "getMessages", keys });
    expect(r).toMatchObject({ type: "getMessages", ok: true });
    expect(
      (r as Extract<BackendResponse, { type: "getMessages" }>).messages.map((m) => m.key),
    ).toEqual(keys);
    expect(await t.call({ type: "getMessages", keys: "x" })).toMatchObject({
      code: "invalidRequest",
    });
    await t.scheduler.stop();
  });
});

describe("ChangePublisher", () => {
  it("announces what changed since the last event, and merges bursts", async () => {
    const t = setup();
    const sent: Extract<BackendEvent, { type: "changes" }>[] = [];
    const publisher = new ChangePublisher(t.storage.store, (e) => sent.push(e), 20);
    await publisher.init();

    t.server.add("INBOX", "a");
    await t.add();
    await settle();
    publisher.touch();
    await publisher.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.changedKeys).toHaveLength(1);

    publisher.touch();
    await publisher.idle();
    expect(sent).toHaveLength(1);

    t.server.add("INBOX", "b");
    t.scheduler.syncNow("acc1");
    await settle();
    publisher.touch();
    publisher.touch();
    publisher.touch();
    await new Promise((r) => setTimeout(r, 60));
    await publisher.idle();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.changedKeys).toHaveLength(1);

    await t.call({ type: "removeAccount", accountId: "acc1" });
    publisher.touch();
    await new Promise((r) => setTimeout(r, 60));
    await publisher.idle();
    expect(sent.at(-1)?.removedKeys).toHaveLength(2);
    publisher.stop();
  });
});

describe("accounts store colours", () => {
  const info = (id: string) =>
    ({
      id,
      address: `${id}@${id}.com`,
      status: { state: "idle" },
    }) as never;

  function rig(initial: string[]) {
    let ids = initial;
    const backend = {
      listAccounts: async () => ({ accounts: ids.map(info) }),
      removeAccount: async (id: string) => {
        ids = ids.filter((x) => x !== id);
      },
      onEvent: () => () => {},
    } as unknown as Backend;
    return createRoot(() => createAccountsStore(backend));
  }
  // Under node solid-js is its server build, where a memo is computed once: marks are derived
  // here from the same two signals the store's memo reads.
  const marksOf = (store: ReturnType<typeof rig>) => accountMarks(store.accounts(), store.colors());
  const colorOf = (store: ReturnType<typeof rig>, id: string) => marksOf(store).get(id)?.color;

  it("gives each account a colour once accounts have loaded", async () => {
    const store = rig(["a", "b"]);
    expect(store.colors()).toEqual({});
    await store.refresh();
    expect([colorOf(store, "a"), colorOf(store, "b")]).toEqual(["blue", "ochre"]);
  });

  it("setColor updates the marks", async () => {
    const store = rig(["a", "b"]);
    await store.refresh();
    store.setColor("b", "teal");
    expect(colorOf(store, "b")).toBe("teal");
    expect(marksOf(store).get("b")?.dot).toBe("var(--acct-teal)");
    expect(colorOf(store, "a")).toBe("blue");
  });

  it("setColor keeps a chosen hex, lower-cased", async () => {
    const store = rig(["a"]);
    await store.refresh();
    store.setColor("a", "#AABBCC");
    expect(colorOf(store, "a")).toBe("#aabbcc");
    expect(marksOf(store).get("a")?.dot).toBe("#aabbcc");
  });

  it("does not shift the other colours when an account is removed", async () => {
    const store = rig(["a", "b", "c"]);
    await store.refresh();
    await store.remove("a");
    expect([colorOf(store, "b"), colorOf(store, "c")]).toEqual(["ochre", "green"]);
    expect(marksOf(store).has("a")).toBe(false);
  });
});
