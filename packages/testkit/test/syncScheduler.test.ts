import type { StoredAccount, SyncStatus } from "@matters/core";
import { backoffDelay, SYNC_INTERVAL_MS, SyncScheduler } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  FakeMailConnector,
  FakeMailError,
  FakeMailSync,
  InMemoryCredentialStore,
  ManualClock,
  settle,
} from "../src/index.ts";

const account: StoredAccount = {
  id: "acc1",
  address: "me@example.com",
  displayName: "Me",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me@example.com" },
  createdAtMs: 1,
};

async function setup() {
  const storage = createInMemoryStorage();
  const server = new FakeMailSync(["INBOX", "Archive"]);
  const connector = new FakeMailConnector(server);
  const credentials = new InMemoryCredentialStore();
  await credentials.set(account.id, { kind: "password", username: "me", password: "pw" });
  const clock = new ManualClock();
  const statuses: SyncStatus[] = [];
  const batches: string[] = [];
  const scheduler = new SyncScheduler({
    connector,
    accounts: storage.accounts,
    credentials,
    sync: storage,
    clock,
    onStatus: (_id, s) => statuses.push(s),
    onBatchApplied: (id) => batches.push(id),
  });
  const subjects = async () =>
    (await storage.store.listNewest({ limit: 100 })).map((m) => m.subject).sort();
  return { storage, server, connector, credentials, clock, statuses, batches, scheduler, subjects };
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

describe("backoffDelay", () => {
  it("doubles from the base, caps at five minutes and jitters into [50%, 100%)", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, 0))).toEqual([500, 1000, 2000, 4000]);
    expect([0, 1, 2].map((n) => backoffDelay(n, 0.999999))).toEqual([999, 1999, 3999]);
    expect(backoffDelay(30, 0.999999)).toBeLessThan(300_000);
    expect(backoffDelay(30, 0)).toBe(150_000);
    expect(backoffDelay(1000, 0.5)).toBe(225_000);
  });
});

describe("SyncScheduler", () => {
  it("syncs every folder at start, publishes progress and settles on idle", async () => {
    const t = await setup();
    t.server.add("INBOX", "a");
    t.server.add("Archive", "b");
    await t.storage.accounts.add(account);

    await t.scheduler.start();
    await settle();

    expect(await t.subjects()).toEqual(["a", "b"]);
    expect(t.statuses[0]).toMatchObject({ state: "syncing" });
    expect(t.statuses.some((s) => s.state === "syncing" && s.folder === "INBOX")).toBe(true);
    expect(last(t.statuses)).toEqual({ state: "idle", lastSyncMs: 0 });
    expect(t.batches.length).toBeGreaterThan(0);
    expect(t.connector.open).toBe(0);
    expect(t.connector.watchesOpen).toBe(1);
    await t.scheduler.stop();
  });

  it("syncs only the inbox when the watch reports a change", async () => {
    const t = await setup();
    t.scheduler.add(account);
    await settle();
    t.server.add("INBOX", "new in inbox");
    t.server.add("Archive", "new in archive");

    t.connector.change();
    await settle();

    expect(await t.subjects()).toEqual(["new in inbox"]);
    await t.clock.advance(SYNC_INTERVAL_MS);
    expect(await t.subjects()).toEqual(["new in archive", "new in inbox"]);
    await t.scheduler.stop();
  });

  it("runs one sync per account at a time and merges triggers that arrive meanwhile", async () => {
    const t = await setup();
    let release = () => {};
    t.connector.gate = new Promise<void>((r) => {
      release = r;
    });
    let peak = 0;
    const open = t.connector.connect.bind(t.connector);
    t.connector.connect = async (target) => {
      const c = await open(target);
      peak = Math.max(peak, t.connector.open);
      return c;
    };
    t.scheduler.add(account);
    await settle();
    for (let i = 0; i < 5; i++) t.connector.change();
    t.scheduler.syncNow(account.id);
    t.server.add("INBOX", "late");
    t.connector.gate = null;
    release();
    await settle();

    expect(peak).toBe(1);
    // the first run plus one more for everything that was requested while it ran
    expect(t.connector.connects).toBe(2);
    expect(await t.subjects()).toEqual(["late"]);
    await t.scheduler.stop();
  });

  it("repeats the full sync every 15 minutes, counted from the end of the last one", async () => {
    const t = await setup();
    t.scheduler.add(account);
    await settle();
    expect(t.connector.connects).toBe(1);

    await t.clock.advance(SYNC_INTERVAL_MS - 1);
    expect(t.connector.connects).toBe(1);
    await t.clock.advance(1);
    expect(t.connector.connects).toBe(2);
    await t.clock.advance(SYNC_INTERVAL_MS);
    expect(t.connector.connects).toBe(3);
    await t.scheduler.stop();
  });

  it("retries a failed sync with growing, jittered delays and recovers", async () => {
    const t = await setup();
    t.connector.connectErrors.push(
      new FakeMailError("unreachable", "host down"),
      new FakeMailError("unreachable", "host down"),
      new FakeMailError("tls", "bad certificate"),
    );
    t.scheduler.add(account);
    await settle();

    expect(last(t.statuses)).toEqual({ state: "error", kind: "unreachable", message: "host down" });
    // random 0.5 scales every delay to 75%
    expect(t.clock.pendingDelays()).toContain(750);
    await t.clock.advance(750);
    expect(t.clock.pendingDelays()).toContain(1500);
    await t.clock.advance(1500);
    expect(last(t.statuses)).toMatchObject({ state: "error", kind: "tls" });
    expect(t.clock.pendingDelays()).toContain(3000);

    t.server.add("INBOX", "finally");
    await t.clock.advance(3000);
    expect(await t.subjects()).toEqual(["finally"]);
    expect(last(t.statuses)?.state).toBe("idle");
    // the next failure starts from the base delay again
    t.connector.connectErrors.push(new FakeMailError("unreachable"));
    await t.clock.advance(SYNC_INTERVAL_MS);
    expect(t.clock.pendingDelays()).toContain(750);
    await t.scheduler.stop();
  });

  it("never waits longer than five minutes between retries", async () => {
    const t = await setup();
    t.clock.randomValue = 0.999999;
    for (let i = 0; i < 20; i++) t.connector.connectErrors.push(new FakeMailError("unreachable"));
    t.scheduler.add(account);
    await settle();
    let longest = 0;
    for (let i = 0; i < 12; i++) {
      const [next] = t.clock.pendingDelays();
      longest = Math.max(longest, next ?? 0);
      await t.clock.advance(next ?? 0);
    }
    expect(longest).toBeLessThan(300_000);
    expect(longest).toBeGreaterThan(200_000);
    await t.scheduler.stop();
  });

  it("does not retry a refused password; Sync now tries again", async () => {
    const t = await setup();
    t.connector.acceptedPasswords.add("other");
    t.scheduler.add(account);
    await settle();
    expect(last(t.statuses)).toMatchObject({ state: "error", kind: "auth" });
    await t.clock.advance(60 * 60_000);
    expect(t.connector.connects).toBe(1);

    await t.credentials.set(account.id, { kind: "password", username: "me", password: "other" });
    t.scheduler.syncNow(account.id);
    await settle();
    expect(last(t.statuses)?.state).toBe("idle");
    await t.scheduler.stop();
  });

  it("does not retry a refusal only the person can end, whatever its reason", async () => {
    for (const refusal of ["imapOff", "webLogin", "appPassword", "browserOnly"] as const) {
      const t = await setup();
      t.connector.acceptedPasswords.add("other");
      t.connector.refusal = { refusal, serverText: "said so" };
      t.scheduler.add(account);
      await settle();
      expect(last(t.statuses)).toMatchObject({
        state: "error",
        kind: "auth",
        detail: { refusal, serverText: "said so" },
      });
      expect(t.clock.pendingDelays()).toEqual([]);
      await t.scheduler.stop();
    }
  });

  it("retries a refusal the server says is temporary on a slow schedule, one login at a time", async () => {
    for (const refusal of ["throttled", "unavailable"] as const) {
      const t = await setup();
      t.connector.acceptedPasswords.add("other");
      t.connector.refusal = { refusal };
      t.scheduler.add(account);
      await settle();
      expect(last(t.statuses)).toMatchObject({ state: "error", kind: "auth", detail: { refusal } });
      // One timer: the sync's. The watch waits for a sync that gets in instead of retrying too.
      // random 0.5 scales every delay to 75%: 1, 2, 4, 8, 16, then 30 minutes at most.
      const seen: number[] = [];
      for (let i = 0; i < 7; i++) {
        const delays = t.clock.pendingDelays();
        expect(delays).toHaveLength(1);
        seen.push(delays[0] ?? 0);
        await t.clock.advance(delays[0] ?? 0);
      }
      expect(seen).toEqual([45_000, 90_000, 180_000, 360_000, 720_000, 1_350_000, 1_350_000]);
      expect(t.connector.connects).toBe(8);
      expect(t.connector.watchesOpened).toBe(0);

      // The server lets the sign-in in again: the sync gets in and opens the watch.
      t.connector.acceptedPasswords.add("pw");
      await t.clock.advance(t.clock.pendingDelays()[0] ?? 0);
      expect(t.connector.watchesOpened).toBe(1);
      expect(last(t.statuses)?.state).toBe("idle");
      await t.scheduler.stop();
    }
  });

  it("opens a watch turned away for now with the next sync that gets in", async () => {
    const t = await setup();
    const busy = () => new FakeMailError("auth", "too many connections", { refusal: "throttled" });
    // Turned away beside the first sync, then once more when that sync, done, tries it again.
    t.connector.watchErrors.push(busy(), busy());
    t.scheduler.add(account);
    await settle();
    expect(last(t.statuses)).toMatchObject({ state: "error", detail: { refusal: "throttled" } });
    // Only the 15-minute sync is waiting; it brings the watch back.
    expect(t.clock.pendingDelays()).toEqual([SYNC_INTERVAL_MS]);
    await t.clock.advance(SYNC_INTERVAL_MS);
    expect(t.connector.watchesOpened).toBe(1);
    expect(last(t.statuses)?.state).toBe("idle");
    await t.scheduler.stop();
  });

  it("reconnects a dropped watch with backoff and syncs what it missed", async () => {
    const t = await setup();
    t.scheduler.add(account);
    await settle();
    expect(t.connector.watchesOpened).toBe(1);
    t.server.add("INBOX", "while away");

    t.connector.dropWatch(new FakeMailError("unreachable", "connection reset"));
    await settle();
    expect(last(t.statuses)).toMatchObject({ state: "error", kind: "unreachable" });
    expect(t.connector.hasWatch()).toBe(false);

    await t.clock.advance(750);
    expect(t.connector.watchesOpened).toBe(2);
    expect(await t.subjects()).toEqual(["while away"]);
    expect(last(t.statuses)?.state).toBe("idle");
    await t.scheduler.stop();
  });

  it("stop closes the watch and waits for a running sync before returning", async () => {
    const t = await setup();
    t.scheduler.add(account);
    await settle();
    await t.scheduler.stop();
    expect(t.connector.watchesOpen).toBe(0);
    expect(t.connector.open).toBe(0);
    await t.clock.advance(SYNC_INTERVAL_MS * 2);
    expect(t.connector.connects).toBe(1);

    const u = await setup();
    let release = () => {};
    u.connector.gate = new Promise<void>((r) => {
      release = r;
    });
    u.scheduler.add(account);
    await settle();
    let stopped = false;
    const stopping = u.scheduler.stop().then(() => {
      stopped = true;
    });
    await settle();
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(u.connector.open).toBe(0);
    expect(u.connector.watchesOpen).toBe(0);
  });

  it("remove stops one account and leaves its timers and connections behind no more", async () => {
    const t = await setup();
    t.scheduler.add(account);
    await settle();
    await t.scheduler.remove(account.id);
    expect(t.scheduler.status(account.id)).toBeNull();
    expect(t.connector.watchesOpen).toBe(0);
    expect(t.clock.pendingDelays()).toEqual([]);
  });

  it("remove cuts a download in flight instead of waiting for it", async () => {
    const t = await setup();
    let cut: (error: Error) => void = () => {};
    const stuck = new Promise<never>((_, reject) => {
      cut = reject;
    });
    const open = t.connector.connect.bind(t.connector);
    t.connector.connect = async (target) => {
      const c = await open(target);
      return {
        ...c,
        sync: { ...c.sync, capabilities: c.sync.capabilities, listFolders: () => stuck },
        abort: () => {
          c.abort();
          cut(new Error("socket closed"));
        },
      };
    };
    t.scheduler.add(account);
    await settle();

    await t.scheduler.remove(account.id);

    expect(t.connector.aborts).toBe(1);
    expect(t.connector.open).toBe(0);
    expect(t.scheduler.status(account.id)).toBeNull();
    expect(t.clock.pendingDelays()).toEqual([]);
  });

  it("reports a missing password as a credentials error without retrying", async () => {
    const t = await setup();
    await t.credentials.delete(account.id);
    t.scheduler.add(account);
    await settle();
    expect(last(t.statuses)).toMatchObject({ state: "error", kind: "credentials" });
    expect(t.connector.connects).toBe(0);
    await t.scheduler.stop();
  });
});
