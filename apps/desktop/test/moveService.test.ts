import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { Label, LabelRole, StoredAccount } from "@matters/core";
import { MAILBOX_BIT, MOVE_UNDO_WINDOW_MS, removeAccount } from "@matters/core";
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
import { MoveService } from "../src/backend/moveService.ts";

const account: StoredAccount = {
  id: "acc1",
  address: "me@example.com",
  displayName: "Me",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
  createdAtMs: 1,
};

const folder = (id: string, role: LabelRole, exclusive = true): Label => ({
  id,
  accountId: "acc1",
  name: id,
  role,
  exclusive,
});
const FOLDERS = [
  folder("INBOX", "inbox"),
  folder("Archive", "archive"),
  folder("Trash", "trash"),
  folder("Junk", "spam"),
  folder("Sent", "sent"),
  folder("Clients", "other"),
];

type Storage = ReturnType<typeof createInMemoryStorage>;

async function build(storage: Storage, options: { password?: boolean } = {}) {
  const clock = new ManualClock();
  const server = new FakeMailSync(["INBOX", "Archive", "Trash", "Junk", "Sent", "Clients"]);
  const connector = new FakeMailConnector(server);
  const credentials = new InMemoryCredentialStore();
  if (options.password !== false) {
    await credentials.set("acc1", { kind: "password", username: "me", password: "pw" });
  }
  if (!(await storage.accounts.get("acc1"))) await storage.accounts.add(account);
  await storage.store.setFolders("acc1", FOLDERS);
  const seen = { changed: 0, moves: 0, syncs: [] as string[], refused: [] as string[] };
  const errors: string[] = [];
  let ids = 0;
  const service = new MoveService({
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    moveOps: storage.moveOps,
    accounts: storage.accounts,
    credentials,
    connector,
    uow: storage.uow,
    clock,
    newId: () => `op${++ids}`,
    onChanged: () => seen.changed++,
    onMoves: () => seen.moves++,
    onRefused: (action, count) => seen.refused.push(`${action}:${count}`),
    requestSync: (accountId) => seen.syncs.push(accountId),
    onError: (e) => errors.push((e as Error).message),
  });
  const runner = new FlagRunner({
    clock,
    process: () => service.process(),
    nextDueMs: () => service.nextDueMs(),
    onError: (e) => errors.push(`runner:${(e as Error).message}`),
  });
  service.attach(runner);
  /** Moves, then lets the runner look at the clock: the timer is set a few promises later. */
  const move = async (...args: Parameters<MoveService["moveThread"]>) => {
    const result = await service.moveThread(...args);
    await settle();
    return result;
  };
  return { storage, clock, connector, credentials, seen, errors, service, runner, move };
}

/** A stored message with a copy in the folder; its thread is `t<n>` unless told. */
async function addMessage(
  storage: Storage,
  n: number,
  where: string | readonly string[] = "INBOX",
  over: Parameters<typeof makeMessage>[0] = {},
) {
  const folders = typeof where === "string" ? [where] : where;
  const m = makeMessage({
    providerId: `p${n}`,
    threadId: `t${n}`,
    dateMs: Date.UTC(2024, 0, n),
    labelIds: [...folders],
    ...over,
  });
  const { keys } = await storage.store.upsertMessages([m]);
  const key = keys[0] as number;
  await storage.index.indexMessages([{ message: { ...m, key }, bodyText: `body ${n}` }]);
  await storage.bodies.putBodies([{ key, threadId: m.threadId, text: `body ${n}` }]);
  if (folders.length > 0) {
    await storage.store.addLocations(
      folders.map((f, i) => ({ key, location: makeLocation(n + i * 100, f) })),
    );
  }
  return key;
}

const get = async (storage: Storage, key: number) => (await storage.store.getByKeys([key]))[0];
const WINDOW = MOVE_UNDO_WINDOW_MS;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function sqlite(): Storage {
  const dir = mkdtempSync(join(tmpdir(), "matters-moves-"));
  dirs.push(dir);
  return createSqliteStorage(join(dir, "mail.db"), { reader: false }) as unknown as Storage;
}

describe.each([
  ["in memory", () => createInMemoryStorage()],
  ["sqlite", sqlite],
] as const)("moving mail: the push to the server (ADR 0044), %s", (_name, make) => {
  it("moves at once locally, waits for the undo window, then moves on the server and swaps the copy", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);

    const result = await t.move({ threadId: "t1", action: "archive" });
    expect(result.keys).toEqual([key]);
    expect((await get(t.storage, key))?.labelIds).toEqual(["Archive"]);
    expect(t.seen.changed).toBe(1);
    expect(t.connector.connects).toBe(0);

    await t.clock.advance(WINDOW - 1);
    expect(t.connector.moves.moveCalls).toEqual([]);
    await t.clock.advance(1);

    expect(t.connector.moves.moveCalls).toHaveLength(1);
    expect(t.connector.moves.moveCalls[0]).toMatchObject({
      action: "archive",
      target: { role: "archive" },
      locations: [makeLocation(1)],
    });
    // The new copy replaced the old one: the message was never without a place, nor deleted.
    const copies = await t.storage.store.getLocations(key);
    expect(copies).toEqual([expect.objectContaining({ folderId: "Archive", uidValidity: "1" })]);
    expect((await get(t.storage, key))?.key).toBe(key);
    expect((await t.storage.bodies.getBodies([key])).get(key)).toBe("body 1");
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.connector.open).toBe(0);
    // Nothing to sync for: the server said where the copy went.
    expect(t.seen.syncs).toEqual([]);
  });

  it("keeps the old location when the server cannot say where the copy went, and asks for a sync", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    t.connector.moves.uidMap = false;
    await t.move({ threadId: "t1", action: "delete" });
    await t.clock.advance(WINDOW);

    expect(await t.storage.moveOps.listPending()).toEqual([]);
    // Removing the only location would delete the message: it stays until sync has seen both.
    expect(await t.storage.store.getLocations(key)).toEqual([makeLocation(1)]);
    expect((await get(t.storage, key))?.mailboxes).toBe(MAILBOX_BIT.trash);
    expect(t.seen.syncs).toEqual(["acc1"]);
  });

  it("settles a move whose copy is already gone, as after a crash between the server and the store", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    await t.move({ threadId: "t1", action: "archive" });
    // The server did it, and the app went down before it could write the answer.
    t.connector.moves.expunged.add([makeLocation(1).accountId, "INBOX", "1", 1].join("\u0000"));
    await t.clock.advance(WINDOW);

    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.seen.refused).toEqual([]);
    // Neither lost nor duplicated: the message keeps its key and its place, sync will reconcile.
    expect((await get(t.storage, key))?.labelIds).toEqual(["Archive"]);
    expect(await t.storage.store.getLocations(key)).toHaveLength(1);
    expect(t.seen.syncs).toEqual(["acc1"]);
    expect(t.errors).toEqual([]);
  });

  it("finds a move that a quit left behind and does it at the next start", async () => {
    const storage = make();
    const first = await build(storage);
    const key = await addMessage(storage, 1);
    await first.move({ threadId: "t1", action: "spam" });
    await first.runner.stop();

    // A new worker over the same data, long after the window.
    const second = await build(storage);
    second.clock.advance(WINDOW + 5000);
    await second.runner.runNow();
    expect(second.connector.moves.moveCalls).toHaveLength(1);
    expect(second.connector.moves.moveCalls[0]).toMatchObject({ action: "spam" });
    expect(await storage.moveOps.listPending()).toEqual([]);
    expect((await get(storage, key))?.mailboxes).toBe(MAILBOX_BIT.spam);
  });

  it("takes a move back inside the window: nothing leaves, and the labels are exactly as they were", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, ["INBOX", "Clients"]);
    const before = await get(t.storage, key);
    await t.move({ threadId: "t1", action: "delete" });
    await t.clock.advance(WINDOW - 1000);

    const result = await t.service.undoMove("op1");
    expect(result).toMatchObject({ kind: "undone", keys: [key] });
    expect(await get(t.storage, key)).toEqual(before);
    expect(t.seen.changed).toBe(2);
    await t.clock.advance(60_000);
    expect(t.connector.connects).toBe(0);
    expect(await t.storage.moveOps.listPending()).toEqual([]);
  });

  it("says it is too late once the window is over, and a push that has begun is not disturbed", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    await t.move({ threadId: "t1", action: "archive" });

    // The push is held at the server while the reader presses Undo.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = t.connector.moves.move.bind(t.connector.moves);
    t.connector.moves.move = async (...args) => {
      await gate;
      return inner(...args);
    };
    await t.clock.advance(WINDOW);
    await settle();
    expect(t.connector.open).toBe(1);

    expect(await t.service.undoMove("op1")).toEqual({ kind: "tooLate" });
    expect((await get(t.storage, key))?.labelIds).toEqual(["Archive"]);
    release();
    await settle();
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect((await get(t.storage, key))?.labelIds).toEqual(["Archive"]);
    expect(await t.storage.store.getLocations(key)).toEqual([
      expect.objectContaining({ folderId: "Archive" }),
    ]);
    expect(await t.service.undoMove("op1")).toEqual({ kind: "gone" });
  });

  it("goes back to what the server has when archive is followed by delete and then undone", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    const before = await get(t.storage, key);
    await t.move({ threadId: "t1", action: "archive" });
    await t.clock.advance(3000);
    await t.move({ threadId: "t1", action: "delete" });
    expect(await t.storage.moveOps.listPending()).toHaveLength(1);

    await t.service.undoMove("op2");
    expect(await get(t.storage, key)).toEqual(before);
    await t.clock.advance(60_000);
    expect(t.connector.moves.moveCalls).toEqual([]);
  });

  it("lets the server win when it refuses: the message is back as it was, and the tray is told", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    const before = await get(t.storage, key);
    t.connector.moves.rejectFolders.add("Archive");
    await t.move({ threadId: "t1", action: "archive" });
    t.seen.changed = 0;
    await t.clock.advance(WINDOW);

    expect(await get(t.storage, key)).toEqual(before);
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.seen.refused).toEqual(["archive:1"]);
    expect(t.seen.changed).toBeGreaterThan(0);
    // A refused move is not tried again.
    await t.clock.advance(10 * 60_000);
    expect(t.connector.moves.moveCalls).toHaveLength(1);
  });

  it("waits and tries again when the server cannot be reached", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    t.connector.connectErrors.push(new FakeMailError("unreachable"));
    await t.move({ threadId: "t1", action: "archive" });
    await t.clock.advance(WINDOW);

    const [row] = await t.storage.moveOps.listPending();
    expect(row).toMatchObject({ attempts: 1 });
    expect((await get(t.storage, key))?.labelIds).toEqual(["Archive"]);
    expect(t.seen.refused).toEqual([]);
    // Once it is back, the same row goes through.
    await t.clock.advance((row?.nextAttemptMs ?? 0) - t.clock.now());
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.connector.moves.moveCalls).toHaveLength(1);
    // And while the row waits for a retry it can no longer be taken back.
  });

  it("does not offer an undo for a row that is waiting for a retry", async () => {
    const t = await build(make());
    await addMessage(t.storage, 1);
    t.connector.connectErrors.push(new FakeMailError("unreachable"));
    await t.move({ threadId: "t1", action: "archive" });
    await t.clock.advance(WINDOW);
    expect(await t.service.undoMove("op1")).toEqual({ kind: "tooLate" });
  });

  it("treats a folder rebuilt on the server (UIDVALIDITY) as stale and leaves the rest to sync", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1);
    t.connector.moves.uidValidity.set("INBOX", "2");
    await t.move({ threadId: "t1", action: "archive" });
    await t.clock.advance(WINDOW);

    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.seen.refused).toEqual([]);
    expect(await t.storage.store.getLocations(key)).toEqual([makeLocation(1)]);
    expect((await get(t.storage, key))?.labelIds).toEqual(["Archive"]);
    expect(t.seen.syncs).toEqual(["acc1"]);
  });

  it("drops the moves of an account that is removed, and pushes nothing for it", async () => {
    const t = await build(make());
    await addMessage(t.storage, 1);
    await addMessage(t.storage, 2);
    await t.move({ threadId: "t1", action: "archive" });
    await t.move({ threadId: "t2", action: "delete" });
    expect(await t.storage.moveOps.listPending()).toHaveLength(2);

    await removeAccount(
      {
        ...t.storage,
        accounts: t.storage.accounts,
        credentials: t.credentials,
        uow: t.storage.uow,
      },
      "acc1",
    );
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(await t.storage.store.listFolders("acc1")).toEqual([]);
    await t.clock.advance(60_000);
    expect(t.connector.connects).toBe(0);
    expect(t.errors).toEqual([]);
  });

  it("drops a move quietly when the account vanished first", async () => {
    const t = await build(make());
    await addMessage(t.storage, 1);
    await t.move({ threadId: "t1", action: "archive" });
    await t.storage.accounts.remove("acc1");
    await t.clock.advance(WINDOW);
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.errors).toEqual([]);
    expect(t.connector.connects).toBe(0);
  });

  it("drops a move quietly when the account has no password, as the demo mail does", async () => {
    const t = await build(make(), { password: false });
    const key = await addMessage(t.storage, 1);
    await t.move({ threadId: "t1", action: "delete" });
    await t.clock.advance(WINDOW);
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.connector.connects).toBe(0);
    expect(t.errors).toEqual([]);
    expect((await get(t.storage, key))?.mailboxes).toBe(MAILBOX_BIT.trash);
    expect(await t.service.nextDueMs()).toBeNull();
  });

  it("moves only the copy that is not in Sent, and takes the copy in Sent when it is Delete", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, ["INBOX", "Sent"]);
    await t.move({ threadId: "t1", action: "archive" });
    await t.clock.advance(WINDOW);
    expect(t.connector.moves.moveCalls[0]?.locations).toEqual([makeLocation(1)]);
    expect((await t.storage.store.getLocations(key)).map((l) => l.folderId).sort()).toEqual([
      "Archive",
      "Sent",
    ]);

    const other = await addMessage(t.storage, 2, ["Sent", "INBOX"]);
    await t.move({ threadId: "t2", action: "delete" });
    await t.clock.advance(WINDOW);
    expect(t.connector.moves.moveCalls[1]?.locations).toHaveLength(2);
    expect((await t.storage.store.getLocations(other)).map((l) => l.folderId)).toEqual([
      "Trash",
      "Trash",
    ]);
  });

  it("moves both copies of a message that sits in two folders", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, ["INBOX", "Clients"]);
    await t.move({ threadId: "t1", action: "move", target: { role: "archive" } });
    await t.clock.advance(WINDOW);
    expect(t.connector.moves.moveCalls[0]?.locations).toHaveLength(2);
    expect((await t.storage.store.getLocations(key)).map((l) => l.folderId)).toEqual([
      "Archive",
      "Archive",
    ]);
  });
});

describe.each([
  ["in memory", () => createInMemoryStorage()],
  ["sqlite", sqlite],
] as const)("Delete forever: the push to the server (ADR 0044, rule 16), %s", (_name, make) => {
  it("expunges the copies in Trash and removes the message from the store only when the server says so", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, "Trash");
    const result = await t.service.deleteForever([key]);
    expect(result.queued).toEqual([key]);
    // No window: the request is due at once, and the message is still here until it is confirmed.
    expect(await get(t.storage, key)).toBeDefined();
    await settle();

    await t.runner.runNow();
    expect(t.connector.moves.expungeCalls).toHaveLength(1);
    expect(t.connector.moves.expungeCalls[0]?.locations).toEqual([makeLocation(1, "Trash")]);
    expect(await get(t.storage, key)).toBeUndefined();
    expect((await t.storage.bodies.getBodies([key])).size).toBe(0);
    expect(await t.storage.moveOps.listPending()).toEqual([]);
  });

  it("keeps the message when the server refuses, or cannot be reached", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, "Trash");
    t.connector.moves.rejectFolders.add("Trash");
    await t.service.deleteForever([key]);
    await t.runner.runNow();
    expect(await get(t.storage, key)).toBeDefined();
    expect(await t.storage.moveOps.listPending()).toEqual([]);
    expect(t.seen.refused).toEqual(["purge:1"]);

    const other = await addMessage(t.storage, 2, "Trash");
    t.connector.moves.rejectFolders.clear();
    t.connector.connectErrors.push(new FakeMailError("unreachable"));
    await t.service.deleteForever([other]);
    await t.runner.runNow();
    expect(await get(t.storage, other)).toBeDefined();
    expect(await t.storage.moveOps.listPending()).toEqual([
      expect.objectContaining({ key: other }),
    ]);
  });

  it("takes the copies one at a time: the message stays while one is refused", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, ["Trash"]);
    await t.storage.store.addLocations([{ key, location: makeLocation(2, "Trash") }]);
    // The server knows only the first copy as being in a folder it can change.
    const inner = t.connector.moves.expunge.bind(t.connector.moves);
    t.connector.moves.expunge = async (locations) =>
      (await inner(locations)).map((r) =>
        r.location.uid === 2 ? { ...r, outcome: "rejected" as const } : r,
      );
    await t.service.deleteForever([key]);
    await t.runner.runNow();
    expect(await t.storage.store.getLocations(key)).toEqual([makeLocation(2, "Trash")]);
    expect(await get(t.storage, key)).toBeDefined();
  });

  it("refuses at the core what is not in Trash, whatever asked, and sends nothing", async () => {
    const t = await build(make());
    const inbox = await addMessage(t.storage, 1, "INBOX");
    const both = await addMessage(t.storage, 2, ["Trash", "Clients"]);
    const result = await t.service.deleteForever([inbox, both]);
    expect(result.queued).toEqual([]);
    expect([...result.refused].sort()).toEqual([inbox, both].sort());
    await t.clock.advance(60_000);
    expect(t.connector.moves.expungeCalls).toEqual([]);
    expect(t.connector.connects).toBe(0);
  });

  it("asks again on the way out: a copy that left Trash since is not deleted", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, "Trash");
    await t.service.deleteForever([key]);
    // Between the request and the push the message was restored to the inbox by a sync.
    await t.storage.store.addLocations([{ key, location: makeLocation(9, "INBOX") }]);
    await t.runner.runNow();
    expect(t.connector.moves.expungeCalls).toEqual([]);
    expect(await get(t.storage, key)).toBeDefined();
    expect(await t.storage.moveOps.listPending()).toEqual([]);
  });

  it("removes at once a message that has no copy on the server, the demo mail", async () => {
    const t = await build(make(), { password: false });
    const key = await addMessage(t.storage, 1, [], { labelIds: ["Trash"] });
    expect((await get(t.storage, key))?.mailboxes).toBe(MAILBOX_BIT.trash);
    const result = await t.service.deleteForever([key]);
    expect(result.removed).toEqual([key]);
    expect(await get(t.storage, key)).toBeUndefined();
    expect(t.connector.connects).toBe(0);
  });

  it("counts a copy that was gone already as deleted", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, "Trash");
    t.connector.moves.uidValidity.set("Trash", "2");
    await t.service.deleteForever([key]);
    await t.runner.runNow();
    // The folder was rebuilt: its UIDs mean nothing now, and sync decides what is left of it.
    expect(t.seen.refused).toEqual([]);
    expect(await get(t.storage, key)).toBeUndefined();
  });

  it("is not blocked by a failed log-in: the request waits for the vault", async () => {
    const t = await build(make());
    const key = await addMessage(t.storage, 1, "Trash");
    const read = t.credentials.get.bind(t.credentials);
    t.credentials.get = () => Promise.reject(new Error("vault did not answer"));
    await t.service.deleteForever([key]);
    await t.runner.runNow();
    expect(await get(t.storage, key)).toBeDefined();
    expect(await t.storage.moveOps.listPending()).toHaveLength(1);
    t.credentials.get = read;
    await t.clock.advance(10 * 60_000);
    expect(await get(t.storage, key)).toBeUndefined();
  });
});

describe("moves on an account whose places are labels (Gmail), through the fake connection", () => {
  it("passes the action and the target on, and keeps the copy it is told to keep", async () => {
    const storage = createInMemoryStorage();
    const t = await build(storage);
    await storage.store.setFolders("acc1", [
      folder("All", "archive", false),
      folder("GTrash", "trash", false),
      folder("GSpam", "spam", false),
    ]);
    const m = makeMessage({
      providerId: "g1",
      threadId: "tg1",
      labelIds: ["inbox", "Clients"],
    });
    const { keys } = await storage.store.upsertMessages([m]);
    await storage.store.addLocations([
      { key: keys[0] as number, location: makeLocation(1, "All") },
    ]);
    await t.move({ threadId: "tg1", action: "archive" });
    const moved = await get(storage, keys[0] as number);
    // The tag stays; only the inbox label goes.
    expect(moved?.labelIds).toEqual(["Clients"]);
    expect(moved?.mailboxes).toBe(MAILBOX_BIT.archive | MAILBOX_BIT.other);
    await t.clock.advance(WINDOW);
    expect(t.connector.moves.moveCalls[0]).toMatchObject({
      action: "archive",
      target: { role: "archive" },
    });
  });
});
