import type { AddAccountDeps, StoredAccount } from "@matters/core";
import {
  addAccount,
  InvalidAccountError,
  OutgoingServerError,
  removeAccount,
  syncAccount,
  toAccount,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  FakeMailConnector,
  FakeMailError,
  FakeMailSubmit,
  FakeMailSync,
  InMemoryCredentialStore,
} from "../src/index.ts";

function setup() {
  const storage = createInMemoryStorage();
  const server = new FakeMailSync(["INBOX", "Archive"]);
  const connector = new FakeMailConnector(server);
  const credentials = new InMemoryCredentialStore();
  const outgoing = new FakeMailSubmit();
  let n = 0;
  const deps: { -readonly [K in keyof AddAccountDeps]: AddAccountDeps[K] } = {
    accounts: storage.accounts,
    credentials,
    connector,
    outgoing,
    newId: () => `acc${++n}`,
    now: () => 1000 + n,
  };
  const input = {
    address: "me@example.com",
    displayName: "",
    password: "s3cret-pw",
    imap: { host: "imap.example.com", port: 993, security: "tls" as const, username: "me" },
  };
  return { storage, server, connector, credentials, deps, input };
}

describe("addAccount", () => {
  it("logs in, lists folders, then stores the account and the password", async () => {
    const t = setup();
    const result = await addAccount(t.deps, t.input);

    expect(result.folderCount).toBe(2);
    expect(result.account).toMatchObject({
      id: "acc1",
      address: "me@example.com",
      displayName: "me@example.com",
    });
    expect(await t.storage.accounts.list()).toEqual([result.account]);
    expect(await t.credentials.get("acc1")).toEqual({
      kind: "password",
      username: "me",
      password: "s3cret-pw",
    });
    expect(t.connector.open).toBe(0);
  });

  it("stores nothing when the login fails, and the error does not contain the password", async () => {
    const t = setup();
    t.connector.connectErrors.push(new FakeMailError("auth", "refused s3cret-pw for me"));

    const error = await addAccount(t.deps, t.input).catch((e: unknown) => e as Error);

    expect(error).toMatchObject({ kind: "auth" });
    expect((error as Error).message).not.toContain("s3cret-pw");
    expect(await t.storage.accounts.list()).toEqual([]);
    expect(await t.credentials.get("acc1")).toBeNull();
  });

  it("logs in to the outgoing server before saving, and saves nothing when that fails", async () => {
    const t = setup();
    const smtp = {
      host: "smtp.example.com",
      port: 465,
      security: "tls" as const,
      username: "me@example.com",
    };
    t.deps.outgoing = new FakeMailSubmit();
    const outgoing = t.deps.outgoing as FakeMailSubmit;
    outgoing.outgoing = {
      ok: false,
      kind: "auth",
      reason: `535 bad login for ${t.input.password}`,
    };

    const failure = await addAccount(t.deps, { ...t.input, smtp }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OutgoingServerError);
    expect((failure as OutgoingServerError).kind).toBe("auth");
    expect((failure as Error).message).not.toContain(t.input.password);
    expect(await t.storage.accounts.list()).toEqual([]);

    outgoing.outgoing = { ok: true };
    await addAccount(t.deps, { ...t.input, smtp });
    expect(outgoing.verified.at(-1)?.server.host).toBe("smtp.example.com");
    expect(await t.storage.accounts.list()).toHaveLength(1);
  });

  it("adds an account with no outgoing server without testing one", async () => {
    const t = setup();
    const outgoing = new FakeMailSubmit();
    t.deps.outgoing = outgoing;
    await addAccount(t.deps, t.input);
    expect(outgoing.verified).toEqual([]);
  });

  it("refuses before any connection when the vault cannot protect the password", async () => {
    const t = setup();
    t.credentials.unavailableReason = "No keyring is available";

    await expect(addAccount(t.deps, t.input)).rejects.toMatchObject({
      kind: "credentials",
      message: "No keyring is available",
    });
    expect(t.connector.connects).toBe(0);
  });

  it("rejects bad input and a second account for the same address", async () => {
    const t = setup();
    await expect(addAccount(t.deps, { ...t.input, address: "nope" })).rejects.toBeInstanceOf(
      InvalidAccountError,
    );
    await expect(addAccount(t.deps, { ...t.input, password: "" })).rejects.toBeInstanceOf(
      InvalidAccountError,
    );
    await expect(
      addAccount(t.deps, { ...t.input, imap: { ...t.input.imap, port: 0 } }),
    ).rejects.toBeInstanceOf(InvalidAccountError);

    await addAccount(t.deps, t.input);
    await expect(addAccount(t.deps, { ...t.input, address: "ME@example.com" })).rejects.toThrow(
      /already exists/,
    );
    expect(await t.credentials.get("acc2")).toBeNull();
  });
});

describe("removeAccount", () => {
  it("deletes messages, locations, bodies, index entries, cursors, the account and its password", async () => {
    const t = setup();
    const { account } = await addAccount(t.deps, t.input);
    const other: StoredAccount = { ...account, id: "other", address: "x@example.com" };
    await t.storage.accounts.add(other);
    t.server.add("INBOX", "a");
    t.server.add("Archive", "b");
    await syncAccount({ ...t.storage, sync: t.server }, toAccount(account));
    await syncAccount({ ...t.storage, sync: new FakeMailSync(["INBOX"]) }, toAccount(other));
    const keys = (await t.storage.store.listNewest({ limit: 10 })).map((m) => m.key);
    expect(keys).toHaveLength(2);

    const existed = await removeAccount({ ...t.storage, credentials: t.credentials }, account.id);

    expect(existed).toBe(true);
    expect(await t.storage.store.listNewest({ limit: 10 })).toEqual([]);
    for (const key of keys) {
      expect(await t.storage.store.getLocations(key)).toEqual([]);
    }
    expect((await t.storage.bodies.getBodies(keys)).size).toBe(0);
    expect(await t.storage.cursors.get(account.id, "INBOX")).toBeNull();
    expect(await t.storage.cursors.get("other", "INBOX")).not.toBeNull();
    expect(await t.storage.accounts.get(account.id)).toBeNull();
    expect(await t.storage.accounts.get("other")).not.toBeNull();
    expect(await t.credentials.get(account.id)).toBeNull();
    const changes = await t.storage.store.changesSince(0);
    expect([...changes.removedKeys].sort()).toEqual([...keys].sort());
  });

  it("rolls everything back when a step fails", async () => {
    const t = setup();
    const { account } = await addAccount(t.deps, t.input);
    t.server.add("INBOX", "a");
    await syncAccount({ ...t.storage, sync: t.server }, toAccount(account));
    const failing = {
      ...t.storage,
      cursors: {
        ...t.storage.cursors,
        get: t.storage.cursors.get.bind(t.storage.cursors),
        set: t.storage.cursors.set.bind(t.storage.cursors),
        deleteAccount: async () => {
          throw new Error("disk full");
        },
      },
      credentials: t.credentials,
    };

    await expect(removeAccount(failing, account.id)).rejects.toThrow("disk full");

    expect(await t.storage.store.listNewest({ limit: 10 })).toHaveLength(1);
    expect(await t.storage.accounts.get(account.id)).not.toBeNull();
    expect(await t.credentials.get(account.id)).not.toBeNull();
  });
});
