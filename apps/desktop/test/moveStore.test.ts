import type { ChangesEvent, ThreadMessage } from "@matters/contracts";
import type { Label, LabelRole, Message, MoveAction, MoveTarget } from "@matters/core";
import {
  isHiddenMailbox,
  MAILBOX_BIT,
  MOVE_UNDO_WINDOW_MS,
  planMove,
  resolvePlace,
  targetOf,
} from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import type { Backend } from "../src/renderer/client.ts";
import { createMovesStore } from "../src/renderer/moves.ts";
import { createMailStore } from "../src/renderer/store.ts";

const folder = (id: string, role: LabelRole, name = id): Label => ({
  id,
  accountId: "acc1",
  name,
  role,
  exclusive: true,
});
const FOLDERS = [
  folder("INBOX", "inbox"),
  folder("Archive", "archive"),
  folder("Trash", "trash"),
  folder("Junk", "spam"),
  folder("Sent", "sent"),
  folder("Clients", "other"),
];
const bit = (role: LabelRole) => MAILBOX_BIT[role];

/**
 * A backend over a small mailbox that the test also writes to. `moveThread` is the worker's: it
 * plans with the core, changes the labels and answers; it answers only when the test lets it, so
 * the moments in between (the key, the commit, the event) can be looked at one by one.
 */
function rig(initial: readonly Message[]) {
  const server = new Map(initial.map((m) => [m.key, m]));
  const calls = {
    moveThread: [] as {
      threadId: string;
      action: MoveAction;
      target?: MoveTarget;
      hidden?: boolean;
    }[],
    openThread: [] as { threadId: string; hidden: boolean }[],
    undoMove: [] as string[],
    deleteForever: [] as (readonly number[])[],
    getMessages: [] as number[][],
  };
  let seq = 10;
  let hold = false;
  let failNext: Error | null = null;
  const gates: (() => void)[] = [];
  const ops = new Map<string, { keys: number[]; before: Map<number, Message> }>();
  let opId = 0;
  const events: ((e: unknown) => void)[] = [];
  const sorted = () => [...server.values()].sort((a, b) => b.key - a.key);
  const visible = (m: Message) => !isHiddenMailbox(m.mailboxes ?? 0);

  /** Just enough of the query language for these tests. */
  const matches = (query: string, m: Message) => {
    const asks = /in:(trash|spam)/.test(query);
    if (!asks && !visible(m)) return false;
    return query
      .split(/\s+/)
      .filter((t) => t !== "")
      .every((t) => {
        const place = /^in:(\w+)$/.exec(t);
        if (place) return ((m.mailboxes ?? 0) & bit(place[1] as LabelRole)) !== 0;
        if (t === "is:unread") return !m.flags.seen;
        const label = /^label:(\w+)$/.exec(t);
        return label ? m.labelIds.some((l) => l.toLowerCase() === label[1]) : true;
      });
  };

  const backend = {
    async listNewest() {
      return { messages: sorted().filter(visible) };
    },
    async search({ query }: { query: string }) {
      return { messages: sorted().filter((m) => matches(query, m)) };
    },
    async getMessages(keys: readonly number[]) {
      calls.getMessages.push([...keys]);
      return { messages: keys.flatMap((k) => (server.has(k) ? [server.get(k) as Message] : [])) };
    },
    async openThread(threadId: string, hidden = false) {
      calls.openThread.push({ threadId, hidden });
      const messages = sorted()
        .filter((m) => m.threadId === threadId && (hidden || visible(m)))
        .reverse()
        .map(
          (m): ThreadMessage => ({
            ...m,
            bodyText: `body ${m.key}`,
            attachments: [],
            attachmentsKnown: true,
            hasInline: false,
          }),
        );
      const first = messages[0];
      if (!first) throw new Error("no such thread");
      return {
        thread: {
          id: threadId,
          accountId: first.accountId,
          subject: first.subject,
          messageKeys: messages.map((m) => m.key),
          lastMessageKey: (messages[messages.length - 1] as ThreadMessage).key,
          labelIds: [],
          unreadCount: messages.filter((m) => !m.flags.seen).length,
        },
        messages,
      };
    },
    async moveThread(args: {
      threadId: string;
      action: MoveAction;
      target?: MoveTarget;
      hidden?: boolean;
    }) {
      calls.moveThread.push(args);
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      const place = resolvePlace(FOLDERS, targetOf(args.action, args.target));
      const before = new Map<number, Message>();
      for (const m of sorted().filter((x) => x.threadId === args.threadId)) {
        if (!args.hidden && !visible(m)) continue;
        const plan = planMove(
          { labelIds: m.labelIds, mailboxes: m.mailboxes ?? 0 },
          args.action,
          place,
          FOLDERS,
        );
        if (plan === null) continue;
        before.set(m.key, m);
        server.set(m.key, { ...m, ...plan });
      }
      if (before.size === 0) return { operationId: null, keys: [], changeSeq: seq };
      seq++;
      const operationId = `op${++opId}`;
      ops.set(operationId, { keys: [...before.keys()], before });
      return { operationId, keys: [...before.keys()], changeSeq: seq };
    },
    async undoMove(operationId: string) {
      calls.undoMove.push(operationId);
      const op = ops.get(operationId);
      if (!op) return { kind: "gone" as const };
      for (const [key, m] of op.before) server.set(key, m);
      ops.delete(operationId);
      seq++;
      return { kind: "undone" as const, keys: op.keys, changeSeq: seq };
    },
    async deleteForever(keys: readonly number[]) {
      calls.deleteForever.push(keys);
      // A copy outside Trash (the inbox bit as well) is refused, as the core does.
      const refused = keys.filter((k) => {
        const bits = server.get(k)?.mailboxes ?? 0;
        return !(bits & bit("trash")) || (bits & bit("inbox")) !== 0;
      });
      return { queued: keys.filter((k) => !refused.includes(k)), removed: [], refused };
    },
    async listFolders() {
      return FOLDERS;
    },
    async countMatches() {
      return { count: 0 };
    },
    onEvent(listener: (e: unknown) => void) {
      events.push(listener);
      return () => {};
    },
  } as unknown as Backend;

  const event = (changedKeys: number[], removedKeys: number[] = []): ChangesEvent => ({
    type: "changes",
    changeSeq: seq,
    changedKeys,
    removedKeys,
  });
  return {
    backend,
    server,
    calls,
    event,
    seq: () => seq,
    emit: (e: unknown) => {
      for (const l of events) l(e);
    },
    holdWrites: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const g of gates.splice(0)) g();
    },
    failNext: (e: Error) => {
      failNext = e;
    },
    remove(key: number) {
      server.delete(key);
      seq++;
    },
  };
}

function timers() {
  let seq = 0;
  let live: { id: number; run: () => void }[] = [];
  return {
    setTimeout: (run: () => void) => {
      const id = ++seq;
      live.push({ id, run });
      return () => {
        live = live.filter((t) => t.id !== id);
      };
    },
    live: () => live.length,
    fire() {
      const due = live;
      live = [];
      for (const t of due) t.run();
    },
  };
}

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const unread = { seen: false, flagged: false, answered: false, draft: false };

/** Newest first: e1 > d1 > c1 > b1 (Trash) > a2 > a1. Thread A has two messages, both in the inbox. */
function mailbox() {
  const day = (n: number) => Date.UTC(2024, 0, n);
  const m = (providerId: string, threadId: string, n: number, labelId: string, role: LabelRole) =>
    makeMessage({
      providerId,
      threadId,
      dateMs: day(n),
      flags: unread,
      labelIds: [labelId],
      mailboxes: bit(role),
    });
  return {
    a1: m("a1", "A", 1, "INBOX", "inbox"),
    a2: m("a2", "A", 2, "INBOX", "inbox"),
    b1: m("b1", "B", 3, "Trash", "trash"),
    c1: m("c1", "C", 4, "Archive", "archive"),
    d1: m("d1", "D", 5, "INBOX", "inbox"),
    e1: m("e1", "E", 6, "INBOX", "inbox"),
  };
}

async function open(query = "") {
  const mb = mailbox();
  const r = rig(Object.values(mb));
  const t = timers();
  const moves = createMovesStore(r.backend);
  const store = createMailStore(r.backend, {
    autoRead: { setTimeout: t.setTimeout },
    moves,
    folders: () => FOLDERS,
  });
  r.backend.onEvent((e) => {
    if (e.type === "changes") void store.applyChanges(e);
  });
  await store.start();
  if (query) {
    store.setQuery(query);
    await settle();
  }
  await settle();
  const key = (n: keyof typeof mb) => mb[n].key;
  const select = async (n: keyof typeof mb) => {
    store.select(store.messages().findIndex((m) => m.key === key(n)));
    await settle();
  };
  return { ...r, mb, store, moves, timers: t, key, select };
}

const keysOf = (store: { messages: () => readonly Message[] }) =>
  store.messages().map((m) => m.key);

describe("moving a thread: in the frame of the key (ADR 0044, rules 9 and 10)", () => {
  it("takes the rows out, selects the next older one and shows the line before anything is answered", async () => {
    const t = await open("in:inbox");
    expect(keysOf(t.store)).toEqual([t.key("e1"), t.key("d1"), t.key("a2"), t.key("a1")]);
    await t.select("d1");
    t.holdWrites();

    // No await from here until the checks: this is the frame of the key.
    void t.store.moveThread("archive");
    expect(keysOf(t.store)).toEqual([t.key("e1"), t.key("a2"), t.key("a1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("a2"));
    expect(t.moves.pending()).toHaveLength(1);
    expect(t.moves.pending()[0]).toMatchObject({ action: "archive", subject: t.mb.d1.subject });
    expect(t.moves.latestPending()?.notBeforeMs).toBeGreaterThan(Date.now());
    // The backend was asked in the same turn, and has not answered.
    expect(t.calls.moveThread).toEqual([{ threadId: "D", action: "archive" }]);
    expect(t.server.get(t.key("d1"))?.labelIds).toEqual(["INBOX"]);

    t.release();
    await settle();
    expect(t.server.get(t.key("d1"))?.labelIds).toEqual(["Archive"]);
    expect(t.moves.pending()[0]?.id).toBe("op1");
  });

  it("goes to the next older row, or the last one, and takes every row of the thread", async () => {
    const t = await open("in:inbox");
    await t.select("e1");
    void t.store.moveThread("archive");
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("d1"));
    await settle();

    // The thread has two rows, the selected one the newer of them: the older follows it out.
    await t.select("a2");
    void t.store.moveThread("delete");
    expect(keysOf(t.store)).toEqual([t.key("d1")]);
    expect(t.store.selected()).toBe(0);
    await settle();
    expect(t.store.thread()?.thread.id).toBe("D");

    // The last row of the list: the selection goes to the row before it.
    await t.select("d1");
    void t.store.moveThread("spam");
    expect(t.store.messages()).toEqual([]);
    await settle();
    expect(t.store.thread()).toBeNull();
  });

  it("selects the last row when the thread was at the end", async () => {
    const t = await open("in:inbox");
    await t.select("a1");
    void t.store.moveThread("archive");
    expect(keysOf(t.store)).toEqual([t.key("e1"), t.key("d1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("d1"));
    await settle();
  });

  it("leaves an empty list and the empty state when the last row goes", async () => {
    const t = await open("in:archive");
    expect(keysOf(t.store)).toEqual([t.key("c1")]);
    void t.store.moveThread("delete");
    await settle();
    expect(t.store.messages()).toEqual([]);
    expect(t.store.selected()).toBe(0);
    expect(t.store.thread()).toBeNull();
    expect(t.store.loaded()).toBe(true);
    // Another key on nothing is nothing.
    await t.store.moveThread("archive");
    expect(t.calls.moveThread).toHaveLength(1);
  });

  it("keeps the row in All mail when it is archived, and the line is the only word of it", async () => {
    const t = await open();
    expect(keysOf(t.store)).not.toContain(t.key("b1"));
    await t.select("d1");
    const before = keysOf(t.store);
    void t.store.moveThread("archive");
    expect(keysOf(t.store)).toEqual(before);
    expect(t.moves.pending()).toHaveLength(1);
    await settle();
    expect(t.server.get(t.key("d1"))?.mailboxes).toBe(bit("archive"));
  });

  it("takes a deleted thread out of All mail, from a Search and from is:unread", async () => {
    for (const q of ["", "is:unread", "d1"]) {
      const t = await open(q);
      await t.select("d1");
      if (!t.store.messages().some((m) => m.key === t.key("d1"))) continue;
      void t.store.moveThread("delete");
      expect(keysOf(t.store), q).not.toContain(t.key("d1"));
      await settle();
    }
  });

  it("only says so when there is nothing to move, and changes nothing", async () => {
    const t = await open("in:archive");
    await t.select("c1");
    await t.store.moveThread("archive");
    expect(keysOf(t.store)).toEqual([t.key("c1")]);
    expect(t.calls.moveThread).toEqual([]);
    expect(t.moves.pending()).toEqual([]);
    expect(t.moves.notice()).toBe("Already archived");
    expect(t.moves.announcement()).toBe("Already archived");
  });

  it("asks the backend when it knows less, and puts the rows back if there was nothing to move", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    // The server holds it in the Archive already; this window's copy says Inbox.
    t.server.set(t.key("d1"), { ...t.mb.d1, labelIds: ["Archive"], mailboxes: bit("archive") });
    void t.store.moveThread("archive");
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
    await settle();
    expect(t.moves.pending()).toEqual([]);
    expect(t.moves.notice()).toBe("Already archived");
  });

  it("puts the rows back and says so when the backend fails", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    t.failNext(new Error("down"));
    void t.store.moveThread("delete");
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
    await settle();
    expect(keysOf(t.store)).toContain(t.key("d1"));
    expect(t.moves.pending()).toEqual([]);
    expect(t.moves.notice()).toMatch(/Couldn't move/);
  });

  it("does not start a read countdown for the row the selection lands on", async () => {
    const t = await open("in:inbox");
    await t.select("e1");
    t.timers.fire();
    await t.select("d1");
    expect(t.timers.live()).toBe(1);
    void t.store.moveThread("archive");
    // The app moved the selection, not the reader: the countdown of d1 is cancelled, none starts.
    expect(t.timers.live()).toBe(0);
    await settle();
    t.timers.fire();
    await settle();
    expect(t.store.messages().every((m) => !m.flags.seen)).toBe(true);
    expect(t.server.get(t.key("e1"))?.flags.seen).toBe(false);
  });

  it("lets go of a held row: the row that stayed in a view after it was read goes with its thread", async () => {
    const t = await open("is:unread");
    await t.select("e1");
    t.store.toggleSeen();
    await settle();
    expect(t.store.heldKey()).toBeNull();
    void t.store.moveThread("delete");
    expect(t.store.heldKey()).toBeNull();
    await settle();
    expect(keysOf(t.store)).not.toContain(t.key("e1"));
  });
});

describe("what left stays away until the commit has come back (rule 9)", () => {
  it("is not brought back by a fetch that was answered from before the commit", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    t.holdWrites();
    void t.store.moveThread("archive");
    // An older event arrives while the write is on its way: it refetches, and the server still
    // holds the row in the inbox.
    await t.store.applyChanges(t.event([t.key("e1")]));
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
    t.release();
    await settle();
    await t.store.applyChanges(t.event([t.key("d1")]));
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
    expect(t.store.selected()).toBeLessThan(t.store.messages().length);
  });

  it("is not brought back by a refetch that is older than the commit", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    void t.store.moveThread("archive");
    await settle();
    // An event of a sequence before the commit, with the row still matching in the server's list.
    t.server.set(t.key("d1"), { ...t.mb.d1 });
    await t.store.applyChanges({ ...t.event([t.key("e1")]), changeSeq: t.seq() - 1 });
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
  });

  it("lets go once the event at least as new as the commit has been applied", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    void t.store.moveThread("archive");
    await settle();
    await t.store.applyChanges(t.event([t.key("d1")]));
    // The server has it somewhere else; the list agrees. A later fetch that matches it again would
    // now be believed (another device moved it back).
    t.server.set(t.key("d1"), { ...t.mb.d1 });
    await t.store.applyChanges(t.event([t.key("d1")]));
    expect(keysOf(t.store)).toContain(t.key("d1"));
  });

  it("drops a message that became deleted from All mail when an event says it changed", async () => {
    const t = await open();
    expect(keysOf(t.store)).toContain(t.key("d1"));
    t.server.set(t.key("d1"), { ...t.mb.d1, labelIds: ["Trash"], mailboxes: bit("trash") });
    await t.store.applyChanges(t.event([t.key("d1")]));
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
  });
});

describe("taking it back (rule 10)", () => {
  it("brings the rows back with their labels and selects the thread again if the reader stayed", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    void t.store.moveThread("delete");
    await settle();
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
    const landedOn = t.store.messages()[t.store.selected()]?.key;
    expect(landedOn).toBe(t.key("a2"));

    const line = t.moves.latestPending();
    expect(line).toBeDefined();
    expect(await t.store.undoMove(line as NonNullable<typeof line>)).toBe("undone");
    await settle();
    expect(keysOf(t.store)).toContain(t.key("d1"));
    expect(t.server.get(t.key("d1"))).toEqual(t.mb.d1);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("d1"));
    expect(t.store.thread()?.thread.id).toBe("D");
    expect(t.moves.pending()).toEqual([]);
  });

  it("leaves the selection alone when the reader has moved on since", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    void t.store.moveThread("delete");
    await settle();
    await t.select("e1");
    const line = t.moves.latestPending() as NonNullable<ReturnType<typeof t.moves.latestPending>>;
    await t.store.undoMove(line);
    await settle();
    expect(keysOf(t.store)).toContain(t.key("d1"));
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("e1"));
  });

  it("waits for the answer when Undo is pressed before the backend has said what the action is", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    t.holdWrites();
    void t.store.moveThread("archive");
    const line = t.moves.latestPending() as NonNullable<ReturnType<typeof t.moves.latestPending>>;
    const undone = t.store.undoMove(line);
    await settle();
    expect(t.calls.undoMove).toEqual([]);
    t.release();
    expect(await undone).toBe("undone");
    expect(t.calls.undoMove).toEqual(["op1"]);
    expect(t.server.get(t.key("d1"))).toEqual(t.mb.d1);
  });

  it("says it is too late, and keeps the rows where they went", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    void t.store.moveThread("archive");
    await settle();
    const line = t.moves.latestPending() as NonNullable<ReturnType<typeof t.moves.latestPending>>;
    const original = t.backend.undoMove;
    t.backend.undoMove = async () => ({ kind: "tooLate" });
    expect(await t.store.undoMove(line)).toBe("tooLate");
    t.backend.undoMove = original;
    expect(keysOf(t.store)).not.toContain(t.key("d1"));
    expect(t.moves.notice()).toMatch(/^Too late to undo/);
    expect(t.moves.pending()).toEqual([]);
  });
});

describe("Trash and Spam (rules 3 and 7)", () => {
  it("opens a thread whole from a view that asks for Trash, and without its deleted mail elsewhere", async () => {
    const t = await open("in:trash");
    await t.select("b1");
    expect(t.calls.openThread.at(-1)).toEqual({ threadId: "B", hidden: true });
    expect(t.store.viewAsksTrash()).toBe(true);
    expect(t.store.viewAsksHidden()).toBe(true);
    expect(t.store.trashedKeys()).toEqual([t.key("b1")]);

    const u = await open("in:inbox");
    await u.select("d1");
    expect(u.calls.openThread.at(-1)).toEqual({ threadId: "D", hidden: false });
    expect(u.store.viewAsksTrash()).toBe(false);
    expect(u.store.trashedKeys()).toEqual([]);
  });

  it("opens the thread again when the same thread is looked at from another kind of view", async () => {
    const t = await open();
    await t.select("d1");
    const first = t.calls.openThread.length;
    t.store.setQuery("in:trash");
    await settle();
    t.store.setQuery("d1");
    await settle();
    t.store.setQuery("in:inbox");
    await settle();
    expect(t.calls.openThread.length).toBeGreaterThan(first);
    expect(t.calls.openThread.at(-1)?.hidden).toBe(false);
  });

  it("restores with e and moves to the inbox, passing on that the thread is shown whole", async () => {
    const t = await open("in:trash");
    await t.select("b1");
    void t.store.moveThread("archive");
    expect(keysOf(t.store)).toEqual([]);
    expect(t.calls.moveThread).toEqual([{ threadId: "B", action: "archive", hidden: true }]);
    await settle();
    expect(t.server.get(t.key("b1"))?.mailboxes).toBe(bit("archive"));
  });

  it("deletes for good: the rows go at once and stay away until the server confirmed", async () => {
    const t = await open("in:trash");
    await t.select("b1");
    void t.store.deleteForever();
    expect(keysOf(t.store)).toEqual([]);
    expect(t.calls.deleteForever).toEqual([[t.key("b1")]]);
    await settle();
    // The message is still in the store until the server has expunged it: a refetch must not
    // show it again in the meantime.
    await t.store.applyChanges(t.event([t.key("b1")]));
    expect(keysOf(t.store)).toEqual([]);
    // Confirmed: the removal comes, and the guard is let go.
    t.remove(t.key("b1"));
    await t.store.applyChanges(t.event([], [t.key("b1")]));
    expect(keysOf(t.store)).toEqual([]);
  });

  it("asks nothing of the backend when nothing in the open thread is in Trash", async () => {
    const t = await open("in:inbox");
    await t.select("d1");
    await t.store.deleteForever();
    expect(t.calls.deleteForever).toEqual([]);
    expect(keysOf(t.store)).toContain(t.key("d1"));
  });

  it("brings the rows back when the core refuses", async () => {
    const t = await open("in:trash");
    await t.select("b1");
    // The server's copy of the message changed: no longer in Trash.
    t.server.set(t.key("b1"), { ...t.mb.b1, mailboxes: bit("trash") | bit("inbox") });
    void t.store.deleteForever();
    await settle();
    expect(t.moves.notice()).toMatch(/Couldn't delete/);
    expect(keysOf(t.store)).toEqual([t.key("b1")]);
  });
});

describe("the sends tray also holds moves (rule 10)", () => {
  it("counts down from the window and drops the line when it is over", async () => {
    let now = 1_000_000;
    const events: ((e: unknown) => void)[] = [];
    const backend = {
      onEvent: (l: (e: unknown) => void) => {
        events.push(l);
        return () => {};
      },
    } as unknown as Backend;
    const moves = createMovesStore(backend, () => now);
    const settle1 = moves.begin(
      { action: "archive", count: 1, subject: "Hej" },
      MOVE_UNDO_WINDOW_MS,
    );
    expect(moves.pending()).toHaveLength(1);
    expect(
      moves.secondsLeft(moves.pending()[0] as NonNullable<ReturnType<typeof moves.latestPending>>),
    ).toBe(10);
    settle1("op9");
    // The backend's summary of the same action takes the place of the local line.
    for (const l of events) {
      l({
        type: "moves",
        operations: [{ id: "op9", action: "archive", count: 1, notBeforeMs: now + 10_000 }],
      });
    }
    expect(moves.pending()).toHaveLength(1);
    expect(moves.pending()[0]).toMatchObject({ id: "op9", subject: "Hej" });
    now += 10_001;
    // The clock signal ticks on its own timer in a page; a new line reads the clock at once.
    moves.begin({ action: "delete", count: 1 }, MOVE_UNDO_WINDOW_MS);
    expect(moves.pending().map((l) => l.action)).toEqual(["delete"]);
    expect(
      moves.secondsLeft(moves.pending()[0] as NonNullable<ReturnType<typeof moves.latestPending>>),
    ).toBe(10);
  });
});
