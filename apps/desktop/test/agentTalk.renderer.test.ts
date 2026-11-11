import type { TalkAgentEntry, TalkEntry, TalkResult, TalkSummary } from "@matters/core";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  createAgentTalk,
  firstName,
  foundFooter,
  isAtBottom,
  type TalkThreadRef,
  trailStepLabel,
} from "../src/renderer/agentTalk.ts";
import type { Backend } from "../src/renderer/client.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

function gate<T>() {
  let release: (value: T) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

const you = (threadId: string | null, id: number, text: string, atMs = 1): TalkEntry => ({
  id,
  threadId,
  atMs,
  role: "you",
  text,
});
const answer = (
  threadId: string,
  id: number,
  text: string,
  kind: "answer" | "draft" | "question" | "closed" = "answer",
): TalkEntry => ({
  id,
  threadId,
  atMs: 2,
  role: "agent",
  kind,
  text,
  quotes: [],
  runtimeName: "Claude Code",
  model: "haiku",
  threads: 1,
});

const ref = (id: string, over: Partial<TalkThreadRef> = {}): TalkThreadRef => ({
  id,
  name: "Anna",
  subject: `About ${id}`,
  ...over,
});

function setup(
  options: {
    read?: (id: string, call: number) => Promise<TalkEntry[]> | TalkEntry[];
    /** What the person kept: open unless they hid it. */
    keptOpen?: boolean;
    /** The talk across all mail that was kept open (ADR 0086). */
    openTalk?: number | null;
    width?: number;
  } = {},
) {
  const [width, setWidth] = createSignal(options.width ?? 1400);
  const stored = new Map<string, TalkEntry[]>();
  const reads: string[] = [];
  const turns: { id: string; words: string; gate: ReturnType<typeof gate<TalkResult>> }[] = [];
  const stops: string[] = [];
  const undone: unknown[][] = [];
  const kept: boolean[] = [];
  const keptTalks: (number | null)[] = [];
  const listeners: ((e: { type: string; [key: string]: unknown }) => void)[] = [];
  let storedAll: TalkEntry[] = [];
  // Talks across all mail (ADR 0086): what `setAll` stores is talk 1, unless a test gives talks.
  let storedTalks: TalkSummary[] | null = null;
  const talkEntries = new Map<number, TalkEntry[]>();
  const allReads: number[] = [];
  const allReadArgs: [number | undefined, number | undefined][] = [];
  const allTurns: {
    words: string;
    talkId: number | null | undefined;
    gate: ReturnType<typeof gate<TalkResult>>;
  }[] = [];
  const deleted: (number | "all")[] = [];
  const renamed: [number, string][] = [];
  let nowMs = 10 * 60 * 60 * 1000;
  const listTalks = (): TalkSummary[] =>
    storedTalks ??
    (storedAll.length === 0
      ? []
      : [
          {
            id: 1,
            startedAtMs: 1,
            lastAtMs: nowMs,
            firstWords: storedAll.find((e) => e.role === "you")?.text ?? "",
            entries: storedAll.length,
          },
        ]);
  const allStops: number[] = [];
  let timers: (() => void)[] = [];
  const threadAgent = { refreshed: 0, revealed: [] as string[] };
  const backend = {
    agentTalkEntries: async (id: string) => {
      reads.push(id);
      return options.read ? options.read(id, reads.length) : (stored.get(id) ?? []);
    },
    agentTalk: (id: string, words: string) => {
      const g = gate<TalkResult>();
      turns.push({ id, words, gate: g });
      return g.promise;
    },
    agentTalkStop: async (id: string) => {
      stops.push(id);
    },
    agentTalkAllEntries: async (talkId?: number, beforeId?: number) => {
      allReads.push(allReads.length);
      allReadArgs.push([talkId, beforeId]);
      const list = talkEntries.get(talkId ?? 1) ?? (talkId === 1 ? storedAll : []);
      const before = list.filter((e) => beforeId === undefined || e.id < beforeId);
      return before.slice(-200);
    },
    agentTalks: async () => listTalks(),
    agentTalkRename: async (id: number, title: string) => {
      renamed.push([id, title]);
    },
    agentTalkDelete: async (id: number) => {
      deleted.push(id);
      if (storedTalks !== null) storedTalks = storedTalks.filter((t) => t.id !== id);
      else if (id === 1) storedAll = [];
    },
    agentTalkDeleteAll: async () => {
      deleted.push("all");
      const n = listTalks().length;
      storedTalks = [];
      storedAll = [];
      return n;
    },
    agentTalkAll: (words: string, talkId?: number | null) => {
      const g = gate<TalkResult>();
      allTurns.push({ words, talkId, gate: g });
      // The result names the talk it landed in: the one asked in, or talk 1 for a new one.
      return g.promise.then((r) => ({ ...r, talkId: r.talkId ?? talkId ?? 1 }));
    },
    agentTalkAllStop: async () => {
      allStops.push(allStops.length);
    },
    agentUndoFeedback: async (...args: unknown[]) => {
      undone.push(args);
    },
    onEvent: (l: (e: { type: string; [key: string]: unknown }) => void) => {
      listeners.push(l);
      return () => {};
    },
  } as unknown as Backend;
  let open: TalkThreadRef | null = null;
  const made: unknown[][] = [];
  const talk = createAgentTalk({
    backend,
    onMade: (threadId, entry, words, headline) =>
      made.push([threadId, entry.kind, words, headline]),
    thread: () => open,
    threadAgent: {
      refresh: async () => {
        threadAgent.refreshed++;
      },
      reveal: (id: string) => {
        threadAgent.revealed.push(id);
      },
    },
    schedule: (run) => {
      timers.push(run);
      return () => {
        timers = timers.filter((t) => t !== run);
      };
    },
    windowWidth: width,
    open: { initial: options.keptOpen ?? false, keep: (o) => kept.push(o) },
    openTalk: { initial: options.openTalk, keep: (id) => keptTalks.push(id) },
    now: () => nowMs,
  });
  return {
    talk,
    setWidth,
    stored,
    reads,
    turns,
    stops,
    undone,
    kept,
    made,
    threadAgent,
    openThread(next: TalkThreadRef | null) {
      open = next;
      talk.sync();
    },
    emit(event: { type: string; [key: string]: unknown } = { type: "agentChanged" }) {
      for (const l of listeners) l(event);
    },
    setAll(entries: TalkEntry[]) {
      storedAll = entries;
    },
    allReads,
    allReadArgs,
    allTurns,
    allStops,
    deleted,
    renamed,
    keptTalks,
    setTalks(list: TalkSummary[], entries: Record<number, TalkEntry[]> = {}) {
      storedTalks = list;
      for (const [id, e] of Object.entries(entries)) talkEntries.set(Number(id), e);
    },
    setNow(ms: number) {
      nowMs = ms;
    },
    pending: () => timers.length,
    fire() {
      const t = timers;
      timers = [];
      for (const r of t) r();
    },
  };
}

describe("the talk with the agent (ADR 0064)", () => {
  it("shows the talk of the open thread only, and reads nothing else on open", async () => {
    const s = setup();
    s.stored.set("a", [you("a", 1, "What is this?"), answer("a", 2, "A contract.")]);
    s.stored.set("b", [you("b", 3, "Hello")]);
    s.openThread(ref("a"));
    // Not a frame of anything before the read arrives.
    expect(s.talk.entries()).toEqual([]);
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([1, 2]);
    s.openThread(ref("b"));
    expect(s.talk.entries()).toEqual([]);
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([3]);
    expect(s.reads).toEqual(["a", "b"]);
    expect(s.turns).toHaveLength(0);
    s.openThread(null);
    expect(s.talk.entries()).toEqual([]);
  });

  it("drops an answer that comes after the person moved on", async () => {
    const slow = gate<TalkEntry[]>();
    const s = setup({
      read: (id) => (id === "a" ? slow.promise : [you("b", 9, "B")]),
    });
    s.openThread(ref("a"));
    s.openThread(ref("b"));
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([9]);
    slow.release([you("a", 1, "A")]);
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([9]);
    // Back on A, nothing of B is shown while A is read again.
    s.openThread(ref("a"));
    expect(s.talk.entries()).toEqual([]);
  });

  it("reads again after a push, once for several pushes close together", async () => {
    const s = setup();
    s.openThread(ref("a"));
    await flush();
    s.stored.set("a", [you("a", 1, "Hi")]);
    s.emit();
    s.emit();
    expect(s.pending()).toBe(1);
    s.fire();
    await flush();
    expect(s.reads).toEqual(["a", "a"]);
    expect(s.talk.entries()).toHaveLength(1);
  });

  it("keeps the words and the turn per thread", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("Who wrote this?");
    s.openThread(ref("b"));
    expect(s.talk.words()).toBe("");
    s.talk.setWords("Other words");
    void s.talk.send();
    expect(s.talk.busy("b")).toBe(true);
    expect(s.talk.busy("a")).toBe(false);
    s.openThread(ref("a"));
    expect(s.talk.words()).toBe("Who wrote this?");
    // A turn in A goes on with B's still running.
    void s.talk.send();
    expect(s.turns.map((t) => [t.id, t.words])).toEqual([
      ["b", "Other words"],
      ["a", "Who wrote this?"],
    ]);
    expect(s.talk.busy("a")).toBe(true);
    expect(s.talk.busy("b")).toBe(true);
    expect(s.talk.pending("a")).toBe("Who wrote this?");
    s.openThread(ref("b"));
    expect(s.talk.pending("b")).toBe("Other words");
    expect(s.talk.pending("a")).toBe("Who wrote this?");
  });

  it("allows one turn per thread, and sends nothing blank", async () => {
    const s = setup();
    s.openThread(ref("a"));
    void s.talk.send();
    s.talk.setWords("   ");
    void s.talk.send();
    expect(s.turns).toHaveLength(0);
    s.talk.setWords("One");
    void s.talk.send();
    s.talk.setWords("Two");
    void s.talk.send();
    expect(s.turns.map((t) => t.words)).toEqual(["One"]);
    // The second words are still in the field.
    expect(s.talk.words()).toBe("Two");
  });

  it("opens the pane with the first message, empties the field, and trims the words", async () => {
    const s = setup();
    s.openThread(ref("a"));
    expect(s.talk.paneOpen()).toBe(false);
    s.talk.setWords("  Who wrote this?  ");
    void s.talk.send();
    expect(s.talk.paneOpen()).toBe(true);
    expect(s.kept).toEqual([true]);
    expect(s.talk.words()).toBe("");
    expect(s.turns[0]?.words).toBe("Who wrote this?");
  });

  it("says what a finished turn made, with the person's words, and nothing for a failed one", async () => {
    const s = setup();
    s.openThread(ref("a", { headline: "Anna waits" }));
    await flush();
    s.talk.setWords("this is done");
    void s.talk.send();
    await flush();
    s.turns[0]?.gate.release({
      entries: [you("a", 1, "this is done"), answer("a", 2, "You spoke", "closed")],
    });
    await flush();
    expect(s.made).toEqual([["a", "closed", "this is done", "Anna waits"]]);
    s.talk.setWords("again");
    void s.talk.send();
    await flush();
    s.turns[1]?.gate.fail(new Error("No."));
    await flush();
    expect(s.made).toHaveLength(1);
  });

  it("does not open the pane or ask for a turn when a thread is opened", async () => {
    const s = setup();
    s.openThread(ref("a"));
    await flush();
    expect(s.talk.paneOpen()).toBe(false);
    expect(s.turns).toHaveLength(0);
    expect(s.kept).toEqual([]);
  });

  it("hides the pane without cutting the turn short", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("Hello");
    void s.talk.send();
    s.talk.setOpen(false);
    expect(s.talk.paneOpen()).toBe(false);
    expect(s.talk.busy("a")).toBe(true);
    expect(s.stops).toEqual([]);
  });

  it("shows the talk and the end of the turn together, and shows new work under the letters", async () => {
    const s = setup();
    s.openThread(ref("a"));
    await flush();
    s.talk.setWords("Reply yes");
    const done = s.talk.send();
    const entries = [you("a", 1, "Reply yes"), answer("a", 2, "", "draft")];
    s.stored.set("a", entries);
    s.turns[0]?.gate.release({ entries });
    await done;
    expect(s.talk.busy("a")).toBe(false);
    expect(s.talk.entries().map((e) => e.id)).toEqual([1, 2]);
    expect(s.threadAgent.revealed).toEqual(["a"]);
    expect(s.threadAgent.refreshed).toBe(1);
    expect(s.talk.latestWorkId()).toBe(2);
  });

  it("does not bring set-aside work back for a plain answer", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("What is this?");
    const done = s.talk.send();
    s.turns[0]?.gate.release({ entries: [you("a", 1, "x"), answer("a", 2, "A contract.")] });
    await done;
    expect(s.threadAgent.revealed).toEqual([]);
    expect(s.threadAgent.refreshed).toBe(1);
  });

  it("puts the words back on a failure and keeps the problem for that thread", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("Reply yes");
    const done = s.talk.send();
    s.turns[0]?.gate.fail(new Error("Your plan has no room left this week."));
    await done;
    expect(s.talk.words()).toBe("Reply yes");
    expect(s.talk.problem()).toBe("Your plan has no room left this week.");
    expect(s.talk.busy("a")).toBe(false);
    s.openThread(ref("b"));
    expect(s.talk.problem()).toBe("");
    s.openThread(ref("a"));
    expect(s.talk.problem()).toBe("Your plan has no room left this week.");
    // Sending again clears it.
    void s.talk.send();
    expect(s.talk.problem()).toBe("");
  });

  it("does not overwrite words typed while the turn ran", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("First");
    const done = s.talk.send();
    s.talk.setWords("Second");
    s.turns[0]?.gate.fail(new Error("That did not work."));
    await done;
    expect(s.talk.words()).toBe("Second");
  });

  it("restores the words on Stop, with no problem shown", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("Reply yes");
    const done = s.talk.send();
    s.talk.stop();
    expect(s.stops).toEqual(["a"]);
    s.turns[0]?.gate.fail(new Error("Stopped."));
    await done;
    expect(s.talk.words()).toBe("Reply yes");
    expect(s.talk.problem()).toBe("");
    expect(s.talk.busy("a")).toBe(false);
  });

  it("restores the words in the thread they were typed in when the person moved on", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("For A");
    const done = s.talk.send();
    s.openThread(ref("b"));
    s.turns[0]?.gate.fail(new Error("That did not work."));
    await done;
    expect(s.talk.words()).toBe("");
    s.openThread(ref("a"));
    expect(s.talk.words()).toBe("For A");
    expect(s.talk.problem()).toBe("That did not work.");
  });

  it("says when a message is newer than the talk", async () => {
    const s = setup();
    s.stored.set("a", [you("a", 1, "Hi", 100), { ...answer("a", 2, "Yes"), atMs: 200 }]);
    s.openThread(ref("a", { lastMessageMs: 50 }));
    await flush();
    expect(s.talk.newMessage()).toBe(false);
    s.openThread(ref("a", { lastMessageMs: 500 }));
    expect(s.talk.newMessage()).toBe(true);
    s.stored.set("b", []);
    s.openThread(ref("b", { lastMessageMs: 500 }));
    await flush();
    expect(s.talk.newMessage()).toBe(false);
  });

  it("offers Undo on the newest closing only, once", async () => {
    const s = setup();
    s.stored.set("a", [you("a", 1, "No reply needed"), answer("a", 2, "no reply", "closed")]);
    s.openThread(ref("a"));
    await flush();
    const [first, closed] = s.talk.entries();
    expect(s.talk.canUndo(first as TalkEntry)).toBe(false);
    expect(s.talk.canUndo(closed as TalkEntry)).toBe(true);
    await s.talk.undoClosed();
    expect(s.undone).toEqual([["a", "closed"]]);
    expect(s.talk.canUndo(closed as TalkEntry)).toBe(false);
  });

  it("reads the first name", () => {
    expect(firstName("Anna Kowalska")).toBe("Anna");
    expect(firstName("")).toBe("");
  });
});

const found = (id: number, text: string): TalkEntry => ({
  id,
  threadId: null,
  atMs: 2,
  role: "agent",
  kind: "found",
  text,
  quotes: [],
  runtimeName: "Claude Code",
  model: "sonnet",
  threads: 1,
  query: "offer",
  hits: [],
});

describe("the talk across all mail (ADR 0064)", () => {
  it("is the scope while no thread is open, and a thread cannot be chosen then", () => {
    const s = setup();
    expect(s.talk.scope()).toBe("all");
    s.talk.setScope("thread");
    expect(s.talk.scope()).toBe("all");
    s.openThread(ref("a"));
    expect(s.talk.scope()).toBe("thread");
    s.talk.setScope("all");
    expect(s.talk.scope()).toBe("all");
    s.talk.setScope("thread");
    expect(s.talk.scope()).toBe("thread");
  });

  it("opening another thread takes the scope back to the thread, and the same one does not", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setScope("all");
    s.openThread(ref("a", { subject: "Changed" }));
    expect(s.talk.scope()).toBe("all");
    s.openThread(ref("b"));
    expect(s.talk.scope()).toBe("thread");
  });

  it("never shows one scope's entries in the other, not even for a frame", async () => {
    const s = setup();
    s.stored.set("a", [you("a", 1, "In the thread")]);
    s.setAll([you(null, 7, "Across"), found(8, "Two people.")]);
    s.openThread(ref("a"));
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([1]);
    s.talk.setScope("all");
    // The read of all mail is on its way; what is in view is not the thread's.
    expect(s.talk.entries().some((e) => e.threadId === "a")).toBe(false);
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([7, 8]);
    s.talk.setScope("thread");
    expect(s.talk.entries().map((e) => e.id)).toEqual([1]);
    // Coming back shows what was there at once, and reads again.
    const reads = s.allReads.length;
    s.talk.setScope("all");
    expect(s.talk.entries().map((e) => e.id)).toEqual([7, 8]);
    await flush();
    expect(s.allReads.length).toBe(reads + 1);
  });

  it("reads all mail when no thread is open, and again after a push", async () => {
    const s = setup();
    s.setAll([you(null, 1, "Across")]);
    s.openThread(null);
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([1]);
    s.setAll([you(null, 1, "Across"), found(2, "Two.")]);
    s.emit();
    s.fire();
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([1, 2]);
    expect(s.reads).toEqual([]);
  });

  it("keeps words, the turn and the problem per scope, and the turns run side by side", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setWords("About the thread");
    s.talk.setScope("all");
    expect(s.talk.words()).toBe("");
    s.talk.setWords("Across everything");
    void s.talk.send();
    expect(s.allTurns.map((t) => t.words)).toEqual(["Across everything"]);
    expect(s.turns).toHaveLength(0);
    expect(s.talk.busyNow()).toBe(true);
    expect(s.talk.pendingNow()).toBe("Across everything");
    expect(s.talk.busy("a")).toBe(false);
    // Back in the thread: its words are there, and sending is not held up by the other turn.
    s.talk.setScope("thread");
    expect(s.talk.words()).toBe("About the thread");
    expect(s.talk.busyNow()).toBe(false);
    void s.talk.send();
    expect(s.turns.map((t) => t.words)).toEqual(["About the thread"]);
    expect(s.talk.busy("a")).toBe(true);
    // The thread's turn ends and the all-mail one goes on.
    s.turns[0]?.gate.release({ entries: [you("a", 1, "x"), answer("a", 2, "ok")] });
    await flush();
    expect(s.talk.busy("a")).toBe(false);
    s.talk.setScope("all");
    expect(s.talk.pendingNow()).toBe("Across everything");
    // A failure of one scope puts the words back in that scope and shows its problem there only.
    s.allTurns[0]?.gate.fail(new Error("No room left."));
    await flush();
    expect(s.talk.words()).toBe("Across everything");
    expect(s.talk.problem()).toBe("No room left.");
    s.talk.setScope("thread");
    expect(s.talk.problem()).toBe("");
  });

  it("sends nothing blank, one turn at a time, opens the pane, and touches no thread", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setScope("all");
    void s.talk.send();
    s.talk.setWords("  Who waits?  ");
    void s.talk.send();
    s.talk.setWords("Again");
    void s.talk.send();
    expect(s.allTurns.map((t) => t.words)).toEqual(["Who waits?"]);
    expect(s.talk.words()).toBe("Again");
    expect(s.talk.paneOpen()).toBe(true);
    s.allTurns[0]?.gate.release({ entries: [you(null, 1, "x"), found(2, "Two.")] });
    await flush();
    expect(s.made).toEqual([]);
    expect(s.threadAgent.refreshed).toBe(0);
    expect(s.threadAgent.revealed).toEqual([]);
    expect(s.talk.busyNow()).toBe(false);
  });

  it("shows the answer and the end of the turn in one frame", async () => {
    const s = setup();
    s.talk.setScope("all");
    s.talk.setWords("Who waits?");
    const done = s.talk.send();
    const entries = [you(null, 1, "Who waits?"), found(2, "Two.")];
    s.setAll(entries);
    s.allTurns[0]?.gate.release({ entries });
    await done;
    expect(s.talk.pendingNow()).toBeNull();
    expect(s.talk.entries().map((e) => e.id)).toEqual([1, 2]);
  });

  it("stops the turn in view and puts the words back with no problem", async () => {
    const s = setup();
    s.openThread(ref("a"));
    s.talk.setScope("all");
    s.talk.setWords("Who waits?");
    const done = s.talk.send();
    s.talk.stop();
    expect(s.allStops).toHaveLength(1);
    expect(s.stops).toEqual([]);
    s.allTurns[0]?.gate.fail(new Error("Stopped."));
    await done;
    expect(s.talk.words()).toBe("Who waits?");
    expect(s.talk.problem()).toBe("");
    // Stopping with nothing running asks for nothing.
    s.talk.stop();
    expect(s.allStops).toHaveLength(1);
  });

  it("shows the steps of the turn that runs, and drops them when it ends", async () => {
    const s = setup();
    s.talk.setScope("all");
    // A step with no turn running is nobody's.
    s.emit({ type: "agentTalkStep", query: "offer", threads: 3 });
    expect(s.talk.step()).toBeNull();
    s.talk.setWords("Who waits?");
    const done = s.talk.send();
    expect(s.talk.step()).toBeNull();
    s.emit({ type: "agentTalkStep", query: "offer OR oferta", threads: 3 });
    expect(s.talk.step()).toEqual({ query: "offer OR oferta", threads: 3 });
    s.allTurns[0]?.gate.release({ entries: [] });
    await done;
    expect(s.talk.step()).toBeNull();
    // Not shown in a thread.
    s.openThread(ref("a"));
    expect(s.talk.step()).toBeNull();
  });

  it("lists the queries it ran and what it decided on the trail, and drops them when the turn ends (ADR 0080)", async () => {
    const s = setup();
    s.talk.setScope("all");
    s.emit({ type: "agentTalkStep", kind: "search", query: "early", threads: 1 });
    expect(s.talk.steps()).toEqual([]);
    s.talk.setWords("Where is the offer?");
    const done = s.talk.send();
    s.emit({ type: "agentTalkStep", kind: "search", query: "acme-labs", threads: 40 });
    s.emit({
      type: "agentTalkStep",
      kind: "follow",
      query: "",
      threads: 0,
      note: "Try the letter",
    });
    s.emit({ type: "agentTalkStep", kind: "search", query: "offer OR oferta", threads: 2 });
    expect(s.talk.steps()).toEqual([
      { kind: "search", text: "acme-labs", threads: 40 },
      { kind: "follow", text: "Try the letter", threads: 0 },
      { kind: "search", text: "offer OR oferta", threads: 2 },
    ]);
    // Steps of the trail are not the end of the search: that one has no kind.
    expect(s.talk.step()).toBeNull();
    s.allTurns[0]?.gate.release({ entries: [] });
    await done;
    expect(s.talk.steps()).toEqual([]);
    // A long trail shows its latest steps only.
    s.talk.setWords("Again");
    const again = s.talk.send();
    for (let i = 0; i < 20; i++) {
      s.emit({ type: "agentTalkStep", kind: "search", query: `q${i}`, threads: i });
    }
    expect(s.talk.steps()).toHaveLength(12);
    expect(s.talk.steps()[11]?.text).toBe("q19");
    s.allTurns[1]?.gate.release({ entries: [] });
    await again;
  });

  it("lists what the loop searched and read beside the lines the agent wrote, and shows more of them (ADR 0083)", async () => {
    const s = setup();
    s.talk.setScope("all");
    s.talk.setWords("My employment history");
    const done = s.talk.send();
    s.emit({
      type: "agentTalkStep",
      kind: "note",
      query: "",
      threads: 0,
      note: "Starting with offers.",
    });
    s.emit({ type: "agentTalkStep", kind: "search", query: "offer", threads: 4 });
    s.emit({
      type: "agentTalkStep",
      kind: "read",
      query: "",
      threads: 1,
      note: "Your offer — Kim Partner — 2026-10-20",
    });
    expect(s.talk.steps()).toEqual([
      { kind: "note", text: "Starting with offers.", threads: 0 },
      { kind: "search", text: "offer", threads: 4 },
      { kind: "read", text: "Your offer — Kim Partner — 2026-10-20", threads: 1 },
    ]);
    for (let i = 0; i < 60; i++) {
      s.emit({ type: "agentTalkStep", kind: "search", query: `q${i}`, threads: i });
    }
    expect(s.talk.steps()).toHaveLength(40);
    expect(s.talk.steps()[39]?.text).toBe("q59");
    s.allTurns[0]?.gate.release({ entries: [] });
    await done;
    expect(s.talk.steps()).toEqual([]);
  });

  it("lists what the loop counted and looked at as facts, the count beside its query (ADR 0102)", async () => {
    const s = setup();
    s.talk.setScope("all");
    s.talk.setWords("Make views");
    const done = s.talk.send();
    s.emit({ type: "agentTalkStep", kind: "look", query: "", threads: 0, note: "your views" });
    s.emit({
      type: "agentTalkStep",
      kind: "count",
      query: "from:shop.test",
      threads: 500,
      note: "500+ messages, 12 unread",
    });
    expect(s.talk.steps()).toEqual([
      { kind: "look", text: "your views", threads: 0 },
      { kind: "count", text: "from:shop.test", threads: 500, detail: "500+ messages, 12 unread" },
    ]);
    expect(trailStepLabel("count")).toBe("Counted");
    expect(trailStepLabel("look")).toBe("Looked at");
    // The loop's steps: it shows more of them than the trail.
    for (let i = 0; i < 30; i++) {
      s.emit({ type: "agentTalkStep", kind: "search", query: `q${i}`, threads: i });
    }
    expect(s.talk.steps()).toHaveLength(32);
    s.allTurns[0]?.gate.release({ entries: [] });
    await done;
  });

  it("labels a note as the agent's own words, so that it cannot pass for a fact (ADR 0083)", () => {
    // A note that reads like a fact line still carries the note label, and the facts keep theirs.
    const note = { kind: "note", text: "Read Offer — Anna — 2026-03-01", threads: 0 } as const;
    expect(trailStepLabel(note.kind)).toBe("Note:");
    expect(trailStepLabel("read")).toBe("Read");
    expect(trailStepLabel("search")).toBe("Searched");
    expect(trailStepLabel("follow")).toBe("Next");
  });

  it("says in the footer which way the answer was found and what left this Mac (ADR 0083)", () => {
    const base = found(1, "Two.") as TalkAgentEntry;
    const trail = foundFooter({ ...base, threads: 2 });
    expect(trail).toBe(
      "Searched the usual way. Sent your question, short extracts of the threads it found, and 2 threads in full to Claude Code. Nothing else left this Mac.",
    );
    expect(foundFooter({ ...base, threads: 0 })).toBe(
      "Searched the usual way. Sent your question to Claude Code. No mail left this Mac.",
    );
    expect(foundFooter({ ...base, threads: 1, loop: { searches: 4, read: 3 } })).toBe(
      "Searched in a loop: 4 searches, 3 read in full. Sent your question, the search results, those threads and 1 thread in full for the answer to Claude Code. Nothing else left this Mac.",
    );
    // Nothing found: the loop still sent what it searched, and the threads it opened.
    expect(foundFooter({ ...base, threads: 0, loop: { searches: 2, read: 0 } })).toBe(
      "Searched in a loop: 2 searches, 0 read in full. Sent your question and the search results to Claude Code. Nothing else left this Mac.",
    );
    expect(foundFooter({ ...base, threads: 0, loop: { searches: 1, read: 2 } })).toContain(
      "Sent your question, the search results and those threads to Claude Code",
    );
    expect(foundFooter({ ...base, threads: 0, loop: { searches: 0, read: 0 } })).toContain(
      "No mail left this Mac.",
    );
  });

  it("says in the footer when the text of attached files left this Mac too (ADR 0087)", () => {
    const base = found(1, "Two.") as TalkAgentEntry;
    expect(foundFooter({ ...base, threads: 1, loop: { searches: 2, read: 1, files: 2 } })).toBe(
      "Searched in a loop: 2 searches, 1 read in full, 2 attached files read. Sent your question, the search results, those threads, the files it read and 1 thread in full for the answer to Claude Code. Nothing else left this Mac.",
    );
    expect(foundFooter({ ...base, threads: 0, loop: { searches: 1, read: 0, files: 1 } })).toBe(
      "Searched in a loop: 1 search, 0 read in full, 1 attached file read. Sent your question, the search results and the files it read to Claude Code. Nothing else left this Mac.",
    );
    expect(
      foundFooter({ ...base, threads: 0, loop: { searches: 1, read: 2, files: 1 } }),
    ).toContain("your question, the search results, those threads and the files it read");
  });

  it("says in the footer when senders and counts, or the person's views, left this Mac (ADR 0102)", () => {
    const base = found(1, "Views.") as TalkAgentEntry;
    expect(
      foundFooter({ ...base, threads: 0, loop: { searches: 0, read: 0, counts: 2, views: true } }),
    ).toBe(
      "Searched in a loop: 0 searches, 0 read in full, 2 counts. Sent your question and the names and addresses of senders with counts of their mail and the names and queries of your views to Claude Code. No message left this Mac.",
    );
    expect(foundFooter({ ...base, threads: 1, loop: { searches: 1, read: 1, counts: 1 } })).toBe(
      "Searched in a loop: 1 search, 1 read in full, 1 count. Sent your question, the search results, those threads and 1 thread in full for the answer to Claude Code. It also sent the names and addresses of senders with counts of their mail. Nothing else left this Mac.",
    );
    // A loop that only listed views: no sender went.
    expect(foundFooter({ ...base, threads: 0, loop: { searches: 0, read: 0, views: true } })).toBe(
      "Searched in a loop: 0 searches, 0 read in full. Sent your question and the names and queries of your views to Claude Code. No message left this Mac.",
    );
  });

  it("offers no Undo, no new-message line and no draft link in All mail", async () => {
    const s = setup();
    s.stored.set("a", [you("a", 1, "x", 100), answer("a", 2, "no reply", "closed")]);
    s.openThread(ref("a", { lastMessageMs: 900 }));
    await flush();
    expect(s.talk.newMessage()).toBe(true);
    s.talk.setScope("all");
    expect(s.talk.newMessage()).toBe(false);
    expect(s.talk.latestWorkId()).toBeNull();
    await s.talk.undoClosed();
    expect(s.undone).toEqual([]);
  });

  describe("the column in a wide and a narrow window (ADR 0069, rules 1 and 5)", () => {
    it("follows the kept choice in a wide window, and keeps what is chosen there", () => {
      const open = setup({ keptOpen: true });
      expect(open.talk.paneOpen()).toBe(true);
      open.talk.toggle();
      expect(open.talk.paneOpen()).toBe(false);
      expect(open.kept).toEqual([false]);
      expect(setup({ keptOpen: false }).talk.paneOpen()).toBe(false);
    });

    it("starts closed under 1060 px even when the kept choice is open", () => {
      const s = setup({ keptOpen: true, width: 1059 });
      expect(s.talk.overlay()).toBe(true);
      expect(s.talk.paneOpen()).toBe(false);
      expect(s.kept).toEqual([]);
    });

    it("opens there on request, and neither opening nor hiding changes the kept choice", () => {
      const s = setup({ keptOpen: true, width: 900 });
      s.talk.setOpen(true);
      expect(s.talk.paneOpen()).toBe(true);
      s.talk.setOpen(false);
      expect(s.talk.paneOpen()).toBe(false);
      s.talk.toggle();
      expect(s.talk.paneOpen()).toBe(true);
      expect(s.kept).toEqual([]);
    });

    it("opens there with a message, without keeping anything", () => {
      const s = setup({ keptOpen: true, width: 900 });
      s.openThread(ref("a"));
      s.talk.setWords("Hello");
      void s.talk.send();
      expect(s.talk.paneOpen()).toBe(true);
      expect(s.kept).toEqual([]);
    });

    it("returns to the kept choice when the window grows", () => {
      const s = setup({ keptOpen: false, width: 900 });
      s.talk.setOpen(true);
      expect(s.talk.paneOpen()).toBe(true);
      s.setWidth(1060);
      expect(s.talk.overlay()).toBe(false);
      expect(s.talk.paneOpen()).toBe(false);
      const shown = setup({ keptOpen: true, width: 900 });
      expect(shown.talk.paneOpen()).toBe(false);
      shown.setWidth(1400);
      expect(shown.talk.paneOpen()).toBe(true);
    });

    it("forgets a request made in a narrow window once it is told the window grew", () => {
      const s = setup({ keptOpen: true, width: 900 });
      s.talk.setOpen(true);
      s.setWidth(1400);
      s.talk.forgetAsk();
      s.setWidth(900);
      expect(s.talk.paneOpen()).toBe(false);
    });

    it("keeps the words of a hidden column", () => {
      const s = setup({ keptOpen: true });
      s.openThread(ref("a"));
      s.talk.setWords("Half a thought");
      s.talk.setOpen(false);
      s.talk.setOpen(true);
      expect(s.talk.words()).toBe("Half a thought");
    });
  });
});

describe("talks across all mail (ADR 0086)", () => {
  const HOUR = 60 * 60 * 1000;
  const talk = (id: number, lastAtMs: number, firstWords: string, entries = 2): TalkSummary => ({
    id,
    startedAtMs: lastAtMs,
    lastAtMs,
    firstWords,
    entries,
  });
  const inTalk = (talkId: number, id: number, text: string): TalkEntry => ({
    ...you(null, id, text),
    talkId,
  });

  it("opens the latest talk when none was kept, and the kept one when it is still there", async () => {
    const a = setup();
    a.setTalks([talk(2, 5 * HOUR, "newer"), talk(1, 4 * HOUR, "older")], {
      1: [inTalk(1, 1, "older")],
      2: [inTalk(2, 5, "newer")],
    });
    a.openThread(null);
    await flush();
    expect(a.talk.openTalkId()).toBe(2);
    expect(a.talk.entries().map((e) => e.id)).toEqual([5]);
    expect(a.talk.openTalkTitle()).toBe("newer");

    const b = setup({ openTalk: 1 });
    b.setTalks([talk(2, 5 * HOUR, "newer"), talk(1, 4 * HOUR, "older")], {
      1: [inTalk(1, 1, "older")],
    });
    b.openThread(null);
    await flush();
    expect(b.talk.openTalkId()).toBe(1);

    // A kept talk that is gone opens a new one.
    const c = setup({ openTalk: 9 });
    c.setTalks([talk(2, 5 * HOUR, "newer")]);
    c.openThread(null);
    await flush();
    expect(c.talk.openTalkId()).toBeNull();
    expect(c.talk.openTalkTitle()).toBe("New talk");
  });

  it("asks in the open talk, and in a new one after a pause of more than two hours", async () => {
    const s = setup();
    s.setNow(10 * HOUR);
    s.setTalks([talk(1, 9 * HOUR, "recent")], { 1: [inTalk(1, 1, "recent")] });
    s.openThread(null);
    await flush();
    s.talk.setWords("follow-up");
    void s.talk.send();
    expect(s.allTurns[0]?.talkId).toBe(1);
    s.allTurns[0]?.gate.release({ entries: [] });
    await flush();
    // Quiet for more than the pause: the question starts a new talk, shown at once.
    s.setNow(12 * HOUR);
    s.talk.setWords("something new");
    void s.talk.send();
    expect(s.allTurns[1]?.talkId).toBeNull();
    expect(s.talk.openTalkId()).toBeNull();
    expect(s.talk.pendingNow()).toBe("something new");
    expect(s.talk.openTalkTitle()).toBe("something new");
    s.setTalks([talk(3, 12 * HOUR, "something new"), talk(1, 9 * HOUR, "recent")], {
      3: [inTalk(3, 7, "something new")],
    });
    s.allTurns[1]?.gate.release({ entries: [], talkId: 3 });
    await flush();
    expect(s.talk.openTalkId()).toBe(3);
    expect(s.talk.entries().map((e) => e.id)).toEqual([7]);
    expect(s.keptTalks.at(-1)).toBe(3);
  });

  it("continues an old talk chosen from the list, however old", async () => {
    const s = setup();
    s.setNow(100 * HOUR);
    s.setTalks([talk(2, 99 * HOUR, "new"), talk(1, 1 * HOUR, "old")], {
      1: [inTalk(1, 1, "old")],
    });
    s.openThread(null);
    await flush();
    s.talk.openFromList(1);
    await flush();
    expect(s.talk.entries().map((e) => e.id)).toEqual([1]);
    s.talk.setWords("back to it");
    void s.talk.send();
    expect(s.allTurns[0]?.talkId).toBe(1);
  });

  it("starts a new talk only when the open one has something in it", async () => {
    const s = setup();
    s.setTalks([talk(1, 9 * HOUR, "one")], { 1: [inTalk(1, 1, "one")] });
    s.openThread(null);
    await flush();
    s.talk.newTalk();
    expect(s.talk.openTalkId()).toBeNull();
    expect(s.talk.entries()).toEqual([]);
    const kept = s.keptTalks.length;
    s.talk.newTalk();
    expect(s.keptTalks).toHaveLength(kept);
  });

  it("shows a running turn only in its own talk, and says where it runs", async () => {
    const s = setup();
    s.setTalks([talk(2, 9 * HOUR, "two"), talk(1, 8 * HOUR, "one")], {
      1: [inTalk(1, 1, "one")],
      2: [inTalk(2, 3, "two")],
    });
    s.openThread(null);
    await flush();
    s.talk.setWords("in two");
    void s.talk.send();
    expect(s.talk.pendingNow()).toBe("in two");
    expect(s.talk.runningTalk()).toBe(2);
    s.talk.openFromList(1);
    await flush();
    expect(s.talk.pendingNow()).toBeNull();
    expect(s.talk.busyElsewhere()).toBe(true);
    expect(s.talk.busyNow()).toBe(true);
    // The answer lands in its own talk; the one in view stays.
    s.allTurns[0]?.gate.release({ entries: [], talkId: 2 });
    await flush();
    expect(s.talk.openTalkId()).toBe(1);
    expect(s.talk.busyElsewhere()).toBe(false);
  });

  it("loads the page before the first entry when asked", async () => {
    const s = setup();
    const many = Array.from({ length: 250 }, (_, i) => inTalk(1, i + 1, `q${i + 1}`));
    s.setTalks([talk(1, 9 * HOUR, "q1", 250)], { 1: many });
    s.openThread(null);
    await flush();
    expect(s.talk.entries()).toHaveLength(200);
    expect(s.talk.hasOlder()).toBe(true);
    expect(await s.talk.loadOlder()).toBe(true);
    expect(s.allReadArgs.at(-1)).toEqual([1, 51]);
    expect(s.talk.entries()).toHaveLength(250);
    expect(s.talk.entries()[0]?.id).toBe(1);
    expect(s.talk.hasOlder()).toBe(false);
    expect(await s.talk.loadOlder()).toBe(false);
  });

  it("renames, deletes the open talk into a new one, and deletes them all", async () => {
    const s = setup();
    s.setTalks([talk(2, 9 * HOUR, "two"), talk(1, 8 * HOUR, "one")], {
      1: [inTalk(1, 1, "one")],
      2: [inTalk(2, 3, "two")],
    });
    s.openThread(null);
    await flush();
    await s.talk.renameTalk(2, "Second");
    expect(s.renamed).toEqual([[2, "Second"]]);
    await s.talk.deleteTalk(2);
    expect(s.deleted).toEqual([2]);
    expect(s.talk.openTalkId()).toBeNull();
    expect(s.talk.talks().map((t) => t.id)).toEqual([1]);
    await s.talk.deleteAllTalks();
    expect(s.deleted).toEqual([2, "all"]);
    expect(s.talk.talks()).toEqual([]);
    expect(s.talk.openTalkId()).toBeNull();
  });
});

describe("isAtBottom", () => {
  it("is true at the end and within a line of it", () => {
    expect(isAtBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isAtBottom({ scrollTop: 580, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });
  it("is false once scrolled up further", () => {
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });
  it("is true when everything fits", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});
