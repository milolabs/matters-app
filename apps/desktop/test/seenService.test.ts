import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { MessageLocation, SeenIntent, StoredAccount } from "@matters/core";
import { SEEN_BACKOFF_CAP_MS } from "@matters/core";
import {
  createInMemoryStorage,
  FakeMailConnector,
  FakeMailError,
  FakeMailSync,
  InMemoryCredentialStore,
  ManualClock,
  makeLocation,
  makeMessage,
  settle,
} from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { FlagRunner } from "../src/backend/flagRunner.ts";
import { SeenService } from "../src/backend/seenService.ts";

const account: StoredAccount = {
  id: "acc1",
  address: "me@example.com",
  displayName: "Me",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
  createdAtMs: 1,
};

type Storage = ReturnType<typeof createInMemoryStorage>;

async function build(storage: Storage, options: { password?: boolean } = {}) {
  const clock = new ManualClock();
  const server = new FakeMailSync(["INBOX", "Archive"]);
  const connector = new FakeMailConnector(server);
  const credentials = new InMemoryCredentialStore();
  if (options.password !== false) {
    await credentials.set("acc1", { kind: "password", username: "me", password: "pw" });
  }
  if (!(await storage.accounts.get("acc1"))) await storage.accounts.add(account);
  const changed = { count: 0 };
  const errors: string[] = [];
  const service = new SeenService({
    store: storage.store,
    flagOps: storage.flagOps,
    accounts: storage.accounts,
    credentials,
    connector,
    uow: storage.uow,
    clock,
    onChanged: () => changed.count++,
    onError: (e) => errors.push((e as Error).message),
  });
  const runner = new FlagRunner({
    clock,
    process: () => service.process(),
    nextDueMs: () => service.nextDueMs(),
    onError: (e) => errors.push(`runner:${(e as Error).message}`),
  });
  service.attach(runner);
  /** Marks, then lets the runner look at the clock: the timer is set a few promises later. */
  const mark = async (keys: readonly number[], seen: boolean) => {
    const result = await service.setSeen(keys, seen);
    await settle();
    return result;
  };
  return { storage, clock, connector, credentials, changed, errors, service, runner, mark };
}

/** A stored message with a copy in INBOX and, if asked, in Archive. */
async function addMessage(
  storage: Storage,
  n: number,
  copies: readonly MessageLocation[] = [makeLocation(n)],
  seen = false,
) {
  const m = makeMessage({
    providerId: `p${n}`,
    dateMs: Date.UTC(2024, 0, n),
    flags: { seen, flagged: false, answered: false, draft: false },
  });
  const { keys } = await storage.store.upsertMessages([m]);
  const key = keys[0] as number;
  if (copies.length > 0)
    await storage.store.addLocations(copies.map((location) => ({ key, location })));
  return key;
}

const seenOf = async (storage: Storage, key: number) =>
  (await storage.store.getByKeys([key]))[0]?.flags.seen;

describe("marking read: the push to the server (ADR 0039)", () => {
  it("writes the flag at once and tells the server a second later, once for a burst", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);

    await t.mark([key], true);
    expect(await seenOf(t.storage, key)).toBe(true);
    expect(t.changed.count).toBe(1);
    expect(t.connector.connects).toBe(0);

    // The reader toggles twice more inside the second: the request moves, nothing is sent.
    await t.clock.advance(600);
    await t.mark([key], false);
    await t.clock.advance(600);
    await t.mark([key], true);
    await t.clock.advance(999);
    expect(t.connector.flags.calls).toEqual([]);

    await t.clock.advance(1);
    expect(t.connector.flags.calls).toHaveLength(1);
    expect(t.connector.flags.calls[0]).toMatchObject({ seen: true });
    expect(t.connector.flags.calls[0]?.locations).toEqual([makeLocation(1)]);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.connector.open).toBe(0);
    expect(await seenOf(t.storage, key)).toBe(true);
  });

  it("keeps the request when the vault cannot answer, and pushes once it can", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    const get = t.credentials.get.bind(t.credentials);
    t.credentials.get = () => Promise.reject(new Error("vault did not answer"));

    await t.mark([key], true);
    await t.clock.advance(1000);
    expect(t.connector.connects).toBe(0);
    expect(await t.storage.flagOps.listPending()).toHaveLength(1);
    expect(t.errors.length).toBeGreaterThan(0);

    t.credentials.get = get;
    await t.clock.advance(SEEN_BACKOFF_CAP_MS);
    expect(t.connector.flags.calls).toHaveLength(1);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
  });

  it("sets every copy of the message, and a thread in one call per state", async () => {
    const t = await build(createInMemoryStorage());
    const a = await addMessage(t.storage, 1, [makeLocation(1), makeLocation(7, "Archive")]);
    const b = await addMessage(t.storage, 2);
    const c = await addMessage(t.storage, 3, [makeLocation(3)], true);

    await t.mark([a, b], true);
    await t.mark([c], false);
    await t.clock.advance(1000);

    expect(t.connector.flags.calls.map((x) => [x.seen, x.locations.length])).toEqual([
      [true, 3],
      [false, 1],
    ]);
    expect(t.connector.flags.has(makeLocation(7, "Archive"))).toBe(true);
    expect(t.connector.flags.has(makeLocation(3))).toBe(false);
    // One connection for the account, not one per state.
    expect(t.connector.connects).toBe(1);
  });

  it("keeps the request when the server cannot be reached, and backs off to a cap of five minutes", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    t.connector.connectErrors.push(new FakeMailError("unreachable"));
    await t.mark([key], true);
    await t.clock.advance(1000);

    const first = (await t.storage.flagOps.listPending())[0] as SeenIntent;
    expect(first).toMatchObject({ attempts: 1, seen: true });
    expect(first.nextAttemptMs).toBeGreaterThan(1000);
    expect(await seenOf(t.storage, key)).toBe(true);

    // Offline for a long time: each wait grows, none beyond the cap, and the attempts never stop.
    let last = first.nextAttemptMs;
    for (let i = 0; i < 12; i++) {
      t.connector.connectErrors.push(new FakeMailError("unreachable"));
      await t.clock.advance(last - t.clock.now());
      const now = (await t.storage.flagOps.listPending())[0] as SeenIntent;
      expect(now.attempts).toBe(i + 2);
      expect(now.nextAttemptMs - t.clock.now()).toBeLessThanOrEqual(SEEN_BACKOFF_CAP_MS);
      last = now.nextAttemptMs;
    }
    expect(last - t.clock.now()).toBeGreaterThan(SEEN_BACKOFF_CAP_MS / 2);

    // The server is back: the very same request goes through.
    await t.clock.advance(last - t.clock.now());
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.connector.flags.has(makeLocation(1))).toBe(true);
  });

  it("treats an error in the middle of the push like being offline", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    t.connector.flags.failures.push(new FakeMailError("unreachable"));
    await t.mark([key], true);
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([
      expect.objectContaining({ attempts: 1 }),
    ]);
    expect(t.connector.open).toBe(0);
    expect(t.errors.join()).not.toContain("pw");
  });

  it("lets the server win when it refuses for good: the old state comes back and is announced", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    t.connector.flags.rejectFolders.add("INBOX");
    const before = (await t.storage.store.changesSince(0)).changeSeq;

    await t.mark([key], true);
    t.changed.count = 0;
    await t.clock.advance(1000);

    expect(await seenOf(t.storage, key)).toBe(false);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.changed.count).toBe(1);
    // The restore is a change of its own, after the one the reader made.
    expect((await t.storage.store.changesSince(before)).changedKeys).toEqual([key]);
    expect((await t.storage.store.changesSince(0)).changeSeq).toBeGreaterThan(before + 1);
    // A refused push is not tried again.
    await t.clock.advance(10 * 60_000);
    expect(t.connector.flags.calls).toHaveLength(1);
  });

  it("does not lose a toggle that arrives while the push is on the wire", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    await t.mark([key], true);

    // The push is held at the server while the reader marks the message unread again.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = t.connector.flags.setSeen.bind(t.connector.flags);
    t.connector.flags.setSeen = async (locations, seen) => {
      await gate;
      return inner(locations, seen);
    };
    await t.clock.advance(1000);
    await settle();
    expect(t.connector.open).toBe(1);

    await t.mark([key], false);
    release();
    await settle();

    // The first push finished but did not delete the newer request, which goes out in its turn.
    expect(await t.storage.flagOps.listPending()).toEqual([
      expect.objectContaining({ seen: false, rev: 2 }),
    ]);
    expect(await seenOf(t.storage, key)).toBe(false);
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.connector.flags.has(makeLocation(1))).toBe(false);
    expect(t.connector.flags.calls.map((c) => c.seen)).toEqual([true, false]);
  });

  it("drops the request of a message with no copy on the server, keeping the local state", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1, []);
    await t.mark([key], true);
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.connector.connects).toBe(0);
    expect(await seenOf(t.storage, key)).toBe(true);
  });

  it("drops the request quietly when the account has no password, as the demo mail does", async () => {
    const t = await build(createInMemoryStorage(), { password: false });
    const key = await addMessage(t.storage, 1);
    await t.mark([key], true);
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.connector.connects).toBe(0);
    expect(t.errors).toEqual([]);
    expect(await seenOf(t.storage, key)).toBe(true);
    // And no loop: the next due time is empty.
    expect(await t.service.nextDueMs()).toBeNull();
  });

  it("drops the request when the account is gone", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    await t.mark([key], true);
    await t.storage.accounts.remove("acc1");
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  it("forgets the copy of a folder that was rebuilt, and lets sync say what is there", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1);
    t.connector.flags.uidValidity.set("INBOX", "2");
    await t.mark([key], true);
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(t.connector.flags.has(makeLocation(1))).toBe(false);
    expect(await seenOf(t.storage, key)).toBe(true);
  });

  it("counts a message as done when one copy took the flag and another refused", async () => {
    const t = await build(createInMemoryStorage());
    const key = await addMessage(t.storage, 1, [makeLocation(1), makeLocation(2, "Archive")]);
    t.connector.flags.rejectFolders.add("Archive");
    await t.mark([key], true);
    await t.clock.advance(1000);
    expect(await t.storage.flagOps.listPending()).toEqual([]);
    expect(await seenOf(t.storage, key)).toBe(true);
  });
});

describe("marking read: surviving a quit", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("finds a request an earlier run left behind and pushes it when the worker starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-seen-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    // First run: the reader marks a message, and the app quits before the second is over.
    const first = createSqliteStorage(path, { reader: false });
    const one = await build(first as unknown as Storage);
    const key = await addMessage(first as unknown as Storage, 1);
    await one.mark([key], true);
    expect(await first.flagOps.listPending()).toHaveLength(1);
    await one.runner.stop();
    first.close();

    // Second run: a new worker over the same file, with the clock past the request's time.
    const second = createSqliteStorage(path, { reader: false });
    try {
      const two = await build(second as unknown as Storage);
      two.clock.advance(5000);
      await two.runner.runNow();
      expect(two.connector.flags.calls).toHaveLength(1);
      expect(two.connector.flags.has(makeLocation(1))).toBe(true);
      expect(await second.flagOps.listPending()).toEqual([]);
      expect((await second.store.getByKeys([key]))[0]?.flags.seen).toBe(true);
    } finally {
      second.close();
    }
  });
});
