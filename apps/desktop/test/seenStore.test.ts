import type { ChangesEvent, ThreadMessage } from "@matters/contracts";
import type { Message, SavedView } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import type { Backend } from "../src/renderer/client.ts";
import { createMailStore } from "../src/renderer/store.ts";
import { createViewsStore } from "../src/renderer/views.ts";

/**
 * A backend over a small mailbox that the test also writes to: `server` is what the worker
 * would have committed. `setSeen` answers only when the test lets it, so the moments in between
 * (optimistic, stale event, committed) can be looked at one by one.
 */
function rig(initial: readonly Message[]) {
  const server = new Map(initial.map((m) => [m.key, m]));
  const calls = {
    openThread: [] as string[],
    getMessages: [] as number[][],
    setSeen: [] as { keys: readonly number[]; seen: boolean }[],
    search: [] as string[],
  };
  let seq = 10;
  const gates: { release: () => void; fail: (e: Error) => void }[] = [];
  let hold = false;
  const sorted = () => [...server.values()].sort((a, b) => b.key - a.key);

  const backend = {
    async listNewest() {
      return { messages: sorted() };
    },
    async search({ query }: { query: string }) {
      calls.search.push(query);
      const all = sorted();
      return { messages: query.includes("is:unread") ? all.filter((m) => !m.flags.seen) : all };
    },
    async getMessages(keys: readonly number[]) {
      calls.getMessages.push([...keys]);
      return { messages: keys.flatMap((k) => (server.has(k) ? [server.get(k) as Message] : [])) };
    },
    async openThread(threadId: string) {
      calls.openThread.push(threadId);
      const messages = sorted()
        .filter((m) => m.threadId === threadId)
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
      const first = messages[0] as ThreadMessage;
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
    async setSeen(keys: readonly number[], seen: boolean) {
      calls.setSeen.push({ keys, seen });
      if (hold) {
        await new Promise<void>((resolve, reject) =>
          gates.push({ release: resolve, fail: (e) => reject(e) }),
        );
      }
      const changedKeys: number[] = [];
      for (const k of keys) {
        const m = server.get(k);
        if (m && m.flags.seen !== seen) {
          server.set(k, { ...m, flags: { ...m.flags, seen } });
          changedKeys.push(k);
        }
      }
      if (changedKeys.length > 0) seq++;
      return { changeSeq: seq, changedKeys };
    },
    async countMatches() {
      return { count: [...server.values()].filter((m) => !m.flags.seen).length };
    },
    async listViews() {
      return [] as SavedView[];
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
    /** Hold `setSeen` until `release()`. */
    holdWrites: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const g of gates.splice(0)) g.release();
    },
    failWrites: (e: Error) => {
      hold = false;
      for (const g of gates.splice(0)) g.fail(e);
    },
    /** Changes the server without the reader: sync did it. */
    change(key: number, seen: boolean) {
      const m = server.get(key) as Message;
      server.set(key, { ...m, flags: { ...m.flags, seen } });
      seq++;
    },
    remove(key: number) {
      server.delete(key);
      seq++;
    },
    add(m: Message) {
      server.set(m.key, m);
      seq++;
    },
  };
}

/** Timers the test fires by hand, so a countdown can be looked at without waiting. */
function timers() {
  let seq = 0;
  let live: { id: number; ms: number; run: () => void }[] = [];
  const state = { created: 0 };
  return {
    state,
    setTimeout: (run: () => void, ms: number) => {
      const id = ++seq;
      state.created++;
      live.push({ id, ms, run });
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
const read = { ...unread, seen: true };

/** Newest first: c1 > b1 > a2 > a1. Thread A has two messages. */
function mailbox(flags = unread) {
  const day = (n: number) => Date.UTC(2024, 0, n);
  const m = (providerId: string, threadId: string, dateMs: number) =>
    makeMessage({ providerId, threadId, dateMs, flags });
  return {
    a1: m("a1", "A", day(1)),
    a2: m("a2", "A", day(2)),
    b1: m("b1", "B", day(3)),
    c1: m("c1", "C", day(4)),
  };
}

async function open(query = "") {
  const mb = mailbox();
  const r = rig(Object.values(mb));
  const t = timers();
  const store = createMailStore(r.backend, {
    autoRead: { setTimeout: t.setTimeout },
    now: () => Date.now(),
  });
  await store.start();
  if (query) {
    store.setQuery(query);
    await settle();
  }
  await settle();
  return { ...r, mb, store, t, key: (n: keyof typeof mb) => mb[n].key };
}

const keysOf = (store: { messages: () => readonly Message[] }) =>
  store.messages().map((m) => m.key);
const seenOf = (store: { messages: () => readonly Message[] }, key: number) =>
  store.messages().find((m) => m.key === key)?.flags.seen;

describe("marking read: the optimistic update", () => {
  it("patches the list and the open thread before it says anything to the backend", async () => {
    const t = await open();
    t.store.select(2); // a2, thread A
    await settle();
    expect(t.store.thread()?.thread.id).toBe("A");
    expect(t.store.thread()?.thread.unreadCount).toBe(2);

    t.holdWrites();
    t.store.toggleSeen();
    // Synchronously, with the write still on its way.
    expect(seenOf(t.store, t.key("a1"))).toBe(true);
    expect(seenOf(t.store, t.key("a2"))).toBe(true);
    expect(seenOf(t.store, t.key("b1"))).toBe(false);
    expect(t.store.thread()?.messages.map((m) => m.flags.seen)).toEqual([true, true]);
    expect(t.store.thread()?.thread.unreadCount).toBe(0);
    expect(t.calls.setSeen).toHaveLength(1);
    t.release();
    await settle();
  });

  it("keeps what the reader asked for over a stale event until one as new as the commit arrives", async () => {
    const t = await open();
    t.store.select(2);
    await settle();
    t.holdWrites();
    t.store.toggleSeen();
    t.release();
    await settle();
    const commit = t.seq();

    // An event about earlier sync work, read before the commit: the server copy says unread.
    t.server.set(t.key("a1"), t.mb.a1);
    t.server.set(t.key("a2"), t.mb.a2);
    await t.store.applyChanges({ ...t.event([t.key("a1"), t.key("a2")]), changeSeq: commit - 1 });
    expect(seenOf(t.store, t.key("a1"))).toBe(true);
    expect(seenOf(t.store, t.key("a2"))).toBe(true);

    // The commit's own event arrives: the server copy now says read, and the overlay lets go.
    t.server.set(t.key("a1"), { ...t.mb.a1, flags: read });
    t.server.set(t.key("a2"), { ...t.mb.a2, flags: read });
    await t.store.applyChanges({ ...t.event([t.key("a1"), t.key("a2")]), changeSeq: commit });
    expect(seenOf(t.store, t.key("a1"))).toBe(true);

    // Later, someone else marks it unread: nothing holds that back any more.
    t.change(t.key("a1"), false);
    await t.store.applyChanges(t.event([t.key("a1")]));
    expect(seenOf(t.store, t.key("a1"))).toBe(false);
  });

  it("goes back to what the backend has when the write fails", async () => {
    const t = await open();
    t.store.select(1);
    await settle();
    t.holdWrites();
    t.store.toggleSeen();
    expect(seenOf(t.store, t.key("b1"))).toBe(true);
    t.failWrites(new Error("worker is restarting"));
    await settle();
    expect(seenOf(t.store, t.key("b1"))).toBe(false);
    expect(t.calls.getMessages).toContainEqual([t.key("b1")]);
    expect(t.store.thread()?.thread.unreadCount).toBe(1);
  });

  it("settles at once when the backend says nothing changed", async () => {
    const t = await open();
    t.store.select(1);
    await settle();
    t.change(t.key("b1"), true); // sync had it read already
    await t.store.markSeen([t.key("b1")], true);
    t.change(t.key("b1"), false);
    await t.store.applyChanges(t.event([t.key("b1")]));
    expect(seenOf(t.store, t.key("b1"))).toBe(false);
  });

  it("does not let a newer toggle be undone by the older one's answer", async () => {
    const t = await open();
    t.store.select(1);
    await settle();
    t.holdWrites();
    t.store.toggleSeen(); // read
    t.store.toggleSeen(); // unread again, before the first answered
    expect(seenOf(t.store, t.key("b1"))).toBe(false);
    t.release();
    await settle();
    await t.store.applyChanges(t.event([t.key("b1")]));
    expect(seenOf(t.store, t.key("b1"))).toBe(false);
    expect(t.server.get(t.key("b1"))?.flags.seen).toBe(false);
  });
});

describe("u: toggling by the selected row", () => {
  it("an unread row marks the whole thread read", async () => {
    const t = await open();
    t.store.select(3); // a1, unread, thread A has a2 too
    await settle();
    t.store.toggleSeen();
    await settle();
    expect(t.calls.setSeen).toEqual([{ keys: [t.key("a1"), t.key("a2")], seen: true }]);
    expect(t.server.get(t.key("a2"))?.flags.seen).toBe(true);
  });

  it("a read row marks only its own message unread", async () => {
    const t = await open();
    t.store.select(3);
    await settle();
    t.store.toggleSeen();
    await settle();
    await t.store.applyChanges(t.event([t.key("a1"), t.key("a2")]));

    t.store.toggleSeen();
    await settle();
    expect(t.calls.setSeen[1]).toEqual({ keys: [t.key("a1")], seen: false });
    expect(t.server.get(t.key("a1"))?.flags.seen).toBe(false);
    expect(t.server.get(t.key("a2"))?.flags.seen).toBe(true);
  });

  it("does nothing on an empty list", async () => {
    const r = rig([]);
    const store = createMailStore(r.backend);
    await store.start();
    store.toggleSeen();
    expect(r.calls.setSeen).toEqual([]);
  });

  it("cancels the countdown, and the thread is not marked again until it is selected again", async () => {
    const t = await open();
    t.store.move(1); // b1: the reader's choice, a countdown starts
    await settle();
    expect(t.t.live()).toBe(1);

    t.store.toggleSeen(); // read now
    t.store.toggleSeen(); // and unread again
    expect(t.t.live()).toBe(0);
    t.t.fire();
    await settle();
    expect(seenOf(t.store, t.key("b1"))).toBe(false);
    expect(t.calls.setSeen.map((c) => c.seen)).toEqual([true, false]);

    // Away and back: now it counts again.
    t.store.move(1);
    t.store.move(-1);
    expect(t.t.live()).toBe(1);
    t.t.fire();
    await settle();
    expect(seenOf(t.store, t.key("b1"))).toBe(true);
  });
});

describe("reading a thread by staying on it", () => {
  it("marks the unread messages of the thread read when the countdown ends", async () => {
    const t = await open();
    t.store.move(1);
    t.store.move(1); // a2: thread A
    await settle();
    expect(t.t.live()).toBe(1);
    t.t.fire();
    await settle();
    expect(t.calls.setSeen).toEqual([{ keys: [t.key("a1"), t.key("a2")], seen: true }]);
  });

  it("does not count anything for what the app selected: start, a view, a refresh", async () => {
    const t = await open();
    expect(t.t.state.created).toBe(0);

    t.store.setQuery("is:unread");
    await settle();
    expect(t.t.state.created).toBe(0);

    // The selected row is deleted; the app lands on its neighbour.
    t.remove(t.key("c1"));
    await t.store.applyChanges(t.event([], [t.key("c1")]));
    expect(t.store.thread()?.thread.id).toBe("B");
    expect(t.t.state.created).toBe(0);
    t.t.fire();
    await settle();
    expect(t.calls.setSeen).toEqual([]);
  });

  it("a click on the row the app selected makes it the reader's", async () => {
    const t = await open();
    t.store.select(0);
    expect(t.t.live()).toBe(1);
  });

  it("does not start over when the open thread is fetched again after a change", async () => {
    const t = await open();
    t.store.move(1);
    await settle();
    const made = t.t.state.created;
    t.change(t.key("b1"), false);
    await t.store.applyChanges(t.event([t.key("b1")]));
    await t.store.applyChanges(t.event([t.key("b1")]));
    expect(t.t.state.created).toBe(made);
    expect(t.t.live()).toBe(1);
  });

  it("leaves a message that arrives in the open thread unread once the thread was read", async () => {
    const t = await open();
    t.store.move(1);
    await settle();
    t.t.fire();
    await settle();
    expect(seenOf(t.store, t.key("b1"))).toBe(true);

    const reply = makeMessage({
      providerId: "b2",
      threadId: "B",
      dateMs: Date.UTC(2024, 0, 9),
      flags: unread,
    });
    t.add(reply);
    await t.store.applyChanges(t.event([reply.key]));
    await settle();
    expect(t.t.live()).toBe(0);
    t.t.fire();
    await settle();
    expect(seenOf(t.store, reply.key)).toBe(false);
    expect(t.store.thread()?.messages.map((m) => m.key)).toContain(reply.key);
  });

  it("window focus: blur cancels, focus starts the same thread over", async () => {
    const t = await open();
    t.store.move(1);
    await settle();
    expect(t.t.live()).toBe(1);
    t.store.setWindowFocused(false);
    expect(t.t.live()).toBe(0);
    t.store.setWindowFocused(true);
    expect(t.t.live()).toBe(1);
  });
});

describe("the row being read stays in a list it no longer matches", () => {
  async function unreadList() {
    const t = await open("is:unread");
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("b1"), t.key("a2"), t.key("a1")]);
    t.store.move(1); // b1
    await settle();
    expect(t.store.thread()?.thread.id).toBe("B");
    return t;
  }

  /** The reader marks b1 read and the committed state comes back as an event. */
  async function readSelected(t: Awaited<ReturnType<typeof unreadList>>) {
    t.store.toggleSeen();
    await settle();
    await t.store.applyChanges(t.event([t.key("b1")]));
  }

  it("keeps the row, its place, the selection and the open thread after the refresh", async () => {
    const t = await unreadList();
    const opened = t.calls.openThread.length;
    const timersMade = t.t.state.created;
    await readSelected(t);

    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("b1"), t.key("a2"), t.key("a1")]);
    expect(t.store.selected()).toBe(1);
    expect(t.store.heldKey()).toBe(t.key("b1"));
    expect(seenOf(t.store, t.key("b1"))).toBe(true);
    expect(t.store.thread()?.thread.id).toBe("B");
    // No other thread opened by itself, and no countdown on a neighbour.
    expect(t.calls.openThread.slice(opened).every((id) => id === "B")).toBe(true);
    expect(t.t.state.created).toBe(timersMade);
    expect(t.t.live()).toBe(0);
  });

  it("drops the row when the reader moves on, and j continues from the neighbour", async () => {
    const t = await unreadList();
    await readSelected(t);
    t.store.move(1);
    await settle();
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("a2"), t.key("a1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("a2"));
    expect(t.store.heldKey()).toBeNull();
    expect(t.store.thread()?.thread.id).toBe("A");

    t.store.move(1);
    await settle();
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("a1"));
  });

  it("still holds the row after a key that goes nowhere, and drops it on the next move", async () => {
    const t = await unreadList();
    t.store.move(-1); // c1, the top row
    await settle();
    t.store.toggleSeen();
    await settle();
    await t.store.applyChanges(t.event([t.key("c1")]));
    expect(t.store.heldKey()).toBe(t.key("c1"));

    t.store.move(-1); // already on top
    await settle();
    expect(t.store.heldKey()).toBe(t.key("c1"));
    expect(t.store.selected()).toBe(0);

    t.store.move(1);
    await settle();
    expect(keysOf(t.store)).toEqual([t.key("b1"), t.key("a2"), t.key("a1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("b1"));
  });

  it("drops the row when the reader moves up, and k continues from the neighbour", async () => {
    const t = await unreadList();
    await readSelected(t);
    t.store.move(-1);
    await settle();
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("a2"), t.key("a1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("c1"));
    expect(t.store.thread()?.thread.id).toBe("C");
  });

  it("visits every other row once, with no skipped or doubled row, walking down then up", async () => {
    const t = await unreadList();
    await readSelected(t);
    const visited: number[] = [];
    for (let i = 0; i < 2; i++) {
      t.store.move(1);
      visited.push(t.store.messages()[t.store.selected()]?.key as number);
    }
    t.store.move(-1);
    visited.push(t.store.messages()[t.store.selected()]?.key as number);
    t.store.move(-1);
    visited.push(t.store.messages()[t.store.selected()]?.key as number);
    expect(visited).toEqual([t.key("a2"), t.key("a1"), t.key("a2"), t.key("c1")]);
  });

  it("drops the row on a click elsewhere, with the clicked row selected", async () => {
    const t = await unreadList();
    await readSelected(t);
    t.store.select(3); // a1 in the list that still has the held row
    await settle();
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("a2"), t.key("a1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("a1"));
  });

  it("stays through more refreshes, and follows new mail arriving above it", async () => {
    const t = await unreadList();
    await readSelected(t);
    const d1 = makeMessage({
      providerId: "d1",
      threadId: "D",
      dateMs: Date.UTC(2024, 0, 8),
      flags: unread,
    });
    t.add(d1);
    await t.store.applyChanges(t.event([d1.key]));
    expect(keysOf(t.store)).toEqual([d1.key, t.key("c1"), t.key("b1"), t.key("a2"), t.key("a1")]);
    expect(t.store.messages()[t.store.selected()]?.key).toBe(t.key("b1"));
    expect(t.store.heldKey()).toBe(t.key("b1"));
    expect(t.store.thread()?.thread.id).toBe("B");
  });

  it("stops holding a row once it matches again", async () => {
    const t = await unreadList();
    await readSelected(t);
    t.store.toggleSeen(); // that message unread again
    await settle();
    await t.store.applyChanges(t.event([t.key("b1")]));
    expect(t.store.heldKey()).toBeNull();
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("b1"), t.key("a2"), t.key("a1")]);
  });

  it("does not hold a row that was deleted", async () => {
    const t = await unreadList();
    t.remove(t.key("b1"));
    await t.store.applyChanges(t.event([], [t.key("b1")]));
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("a2"), t.key("a1")]);
    expect(t.store.heldKey()).toBeNull();
  });

  it("forgets the held row when the query changes", async () => {
    const t = await unreadList();
    await readSelected(t);
    t.store.setQuery("is:unread ");
    await settle();
    expect(t.store.heldKey()).toBeNull();
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("a2"), t.key("a1")]);
  });

  it("the other rows of the thread leave at once, and only the selected one is held", async () => {
    const t = await open("is:unread");
    t.store.move(2); // a2
    await settle();
    t.store.toggleSeen();
    await settle();
    await t.store.applyChanges(t.event([t.key("a1"), t.key("a2")]));
    expect(keysOf(t.store)).toEqual([t.key("c1"), t.key("b1"), t.key("a2")]);
    expect(t.store.heldKey()).toBe(t.key("a2"));
  });
});

describe("unread counts in the view tabs", () => {
  const unreadView: SavedView = {
    id: "u",
    name: "Unread",
    query: "is:unread",
    position: 0,
    createdMs: 1,
    updatedMs: 1,
  };

  it("count again after a flag change; the active tab's own count keeps the row being read", async () => {
    const t = await open();
    (t.backend as unknown as { listViews: () => Promise<SavedView[]> }).listViews = async () => [
      unreadView,
    ];
    const views = createViewsStore(t.backend, t.store, {
      delay: () => Promise.resolve(),
      gapMs: 0,
    });
    await views.load();
    await settle();
    expect(views.count("u")).toBe(4);

    views.select("u");
    await settle();
    t.store.move(1); // b1
    await settle();
    t.store.toggleSeen();
    await settle();
    // What main.tsx does with each event: the list takes it in, and the badges count again.
    await t.store.applyChanges(t.event([t.key("b1")]));
    views.noteChanges();
    await settle();

    expect(views.count("u")).toBe(3);
    // The tab shows the list's length, which still holds the row the reader is on.
    expect(t.store.messages()).toHaveLength(4);
    expect(`${t.store.messages().length}${t.store.hasMore() ? "+" : ""}`).toBe("4");

    t.store.move(1);
    await settle();
    expect(t.store.messages()).toHaveLength(3);
    views.stop();
  });
});
