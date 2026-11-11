import type { Message, Thing } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { createAgentStore } from "../src/renderer/agent.ts";
import type { Backend } from "../src/renderer/client.ts";
import { createMailStore } from "../src/renderer/store.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function mailRig(messages: readonly Message[]) {
  const moved: unknown[] = [];
  const seen: [readonly number[], boolean][] = [];
  const backend = {
    onEvent: () => () => {},
    listNewest: async () => ({ messages }),
    search: async () => ({ messages }),
    openThread: async (id: string) => ({
      thread: { id, accountId: "acc1", labelIds: [], subject: "" },
      messages: messages.filter((m) => m.threadId === id),
    }),
    moveThread: async (args: unknown) => {
      moved.push(args);
      return { operationId: "op1", keys: [], changeSeq: 1 };
    },
    setSeen: async (keys: readonly number[], value: boolean) => {
      seen.push([keys, value]);
      return { changedKeys: keys, changeSeq: 2 };
    },
  } as unknown as Backend;
  return { store: createMailStore(backend), moved, seen };
}

const mail = (key: number, threadId: string, isSeen = true) =>
  makeMessage({ key, threadId, flags: { seen: isSeen, flagged: false } } as Partial<Message>);

describe("moving rows that need not be selected (ADR 0056, rules 4 and 6)", () => {
  const LIST = [mail(4, "t4"), mail(3, "t3"), mail(2, "t2"), mail(1, "t1")];

  it("sends several threads as one action, and takes them out of the list together", async () => {
    const { store, moved } = mailRig(LIST);
    await store.start();
    const rows = [LIST[1], LIST[2]] as Message[];
    expect(await store.moveThreads(rows, "delete")).toBe("moved");
    expect(moved).toEqual([{ threadId: "t3", others: ["t2"], action: "delete" }]);
    expect(store.messages().map((m) => m.key)).toEqual([4, 1]);
  });

  it("leaves the reader where it is when the row is another one", async () => {
    const { store } = mailRig(LIST);
    await store.start();
    store.select(1);
    await tick();
    await store.moveThreads([LIST[0] as Message], "delete");
    expect(store.messages().map((m) => m.key)).toEqual([3, 2, 1]);
    expect(store.messages()[store.selected()]?.key).toBe(3);
    expect(store.thread()?.thread.id).toBe("t3");
  });

  it("moves the selection on when the selected row goes", async () => {
    const { store } = mailRig(LIST);
    await store.start();
    store.select(1);
    await tick();
    await store.moveThreads([LIST[1] as Message, LIST[2] as Message], "delete");
    expect(store.messages()[store.selected()]?.key).toBe(1);
  });
});

describe("marking several rows (ADR 0056, rule 3)", () => {
  it("takes only the rows when marking unread", async () => {
    const LIST = [mail(2, "t2"), mail(1, "t1")];
    const { store, seen } = mailRig(LIST);
    await store.start();
    store.markRows(LIST, false);
    await tick();
    expect(seen).toEqual([[[2, 1], false]]);
  });

  it("takes the whole thread when marking read", async () => {
    const LIST = [mail(3, "t2", false), mail(2, "t2", false), mail(1, "t1", false)];
    const { store, seen } = mailRig(LIST);
    await store.start();
    store.markRows([LIST[0] as Message], true);
    await tick();
    await tick();
    expect([...new Set(seen.flatMap(([keys]) => keys))].sort()).toEqual([2, 3]);
  });
});

const thing = (threadId: string): Thing =>
  ({
    threadId,
    accountId: "a",
    who: threadId,
    headline: threadId,
    why: "",
    score: 1,
    quote: { messageKey: 1, quote: "" },
  }) as Thing;

function agentRig(all: readonly Thing[]) {
  const asked: (string | undefined)[] = [];
  const feedback: string[] = [];
  const undone: string[] = [];
  const covers = new Map<string, number>();
  let refuse = "";
  const backend = {
    onEvent: () => () => {},
    agentStatus: async () => ({ settings: { enabled: true }, progress: { state: "idle" } }),
    agentThings: async (limit: number, query?: string) => {
      asked.push(query);
      const things = query === undefined ? all : all.filter((t) => t.threadId === query);
      return { things: things.slice(0, limit), total: things.length };
    },
    openThread: async (id: string) => ({
      thread: { id, accountId: "a" },
      messages: [{ key: 1 }],
    }),
    agentFeedback: async (id: string, kind: string) => {
      if (id === refuse) throw new Error("no");
      feedback.push(`${id}:${kind}`);
      return covers.get(id) ?? 0;
    },
    agentUndoFeedback: async (id: string) => {
      undone.push(id);
    },
    agentRuleOffer: async () => null,
  } as unknown as Backend;
  const agent = createAgentStore(backend, {
    openDraft: async () => {},
    schedule: () => () => {},
  });
  return { agent, asked, feedback, undone, covers, refuseNext: (id: string) => (refuse = id) };
}

describe("the rest does not close under the person", () => {
  const forNow = (id: string): Thing => ({ ...thing(id), now: true });
  const rig = (first: readonly Thing[]) => {
    let list = first;
    const nowOf = () => list.filter((t) => t.now === true).length;
    const backend = {
      onEvent: () => () => {},
      agentStatus: async () => ({ settings: { enabled: true }, progress: { state: "idle" } }),
      agentThings: async (limit: number, query?: string) => ({
        things: list.slice(0, limit),
        total: list.length,
        ...(query === undefined ? { now: nowOf() } : {}),
      }),
      openThread: async (id: string) => ({ thread: { id, accountId: "a" }, messages: [] }),
      agentFeedback: async () => {},
      agentUndoFeedback: async () => {},
      agentRuleOffer: async () => null,
    } as unknown as Backend;
    const agent = createAgentStore(backend, {
      openDraft: async () => {},
      schedule: () => () => {},
    });
    return { agent, setList: (next: readonly Thing[]) => (list = next) };
  };
  const ids = (agent: ReturnType<typeof rig>["agent"]) => agent.things().map((t) => t.threadId);

  it("stays on the row when the first thing for now arrives", async () => {
    const { agent, setList } = rig([thing("c"), thing("d")]);
    await agent.start();
    agent.setShown(true);
    agent.select("d");
    setList([forNow("n"), thing("c"), thing("d")]);
    await agent.refresh();
    expect(ids(agent)).toEqual(["n", "c", "d"]);
    expect(agent.sections()).toBe(true);
    expect(agent.restOpen()).toBe(true);
    expect(agent.selected()?.threadId).toBe("d");
    expect(agent.chose()).toBe(true);
  });

  it("stays when everything for now was dealt with and more comes", async () => {
    const a = forNow("a");
    const { agent, setList } = rig([a, thing("c"), thing("d")]);
    await agent.start();
    agent.setShown(true);
    await agent.feedbackMany([a], "later");
    setList([thing("c"), thing("d")]);
    await agent.refresh();
    expect(ids(agent)).toEqual(["c", "d"]);
    agent.select("d");
    setList([forNow("n"), thing("c"), thing("d")]);
    await agent.refresh();
    expect(ids(agent)).toEqual(["n", "c", "d"]);
    expect(agent.selected()?.threadId).toBe("d");
  });

  it("stays when an undo brings a thing for now back", async () => {
    const a = forNow("a");
    const { agent } = rig([a, thing("c"), thing("d")]);
    await agent.start();
    agent.setShown(true);
    await agent.feedbackMany([a], "later");
    agent.select("d");
    await agent.undoFeedback();
    expect(ids(agent)).toEqual(["a", "c", "d"]);
    expect(agent.selected()?.threadId).toBe("d");
  });

  it("leaves it closed when only what is for now is on screen", async () => {
    const { agent, setList } = rig([forNow("a"), thing("c")]);
    await agent.start();
    agent.setShown(true);
    setList([forNow("n"), forNow("a"), thing("c")]);
    await agent.refresh();
    expect(ids(agent)).toEqual(["n", "a"]);
    expect(agent.restOpen()).toBe(false);
  });

  it("starts closed again for what arrives while another view is on screen", async () => {
    const { agent, setList } = rig([thing("c"), thing("d")]);
    await agent.start();
    setList([forNow("n"), thing("c"), thing("d")]);
    await agent.refresh();
    expect(ids(agent)).toEqual(["n"]);
    expect(agent.restOpen()).toBe(false);
  });

  it("is not opened by the rows of a search", async () => {
    const { agent } = rig([forNow("a"), thing("c")]);
    await agent.start();
    agent.setShown(true);
    agent.setQuery("x");
    await tick();
    expect(ids(agent)).toEqual(["a", "c"]);
    agent.setQuery("");
    await tick();
    expect(ids(agent)).toEqual(["a"]);
    expect(agent.restOpen()).toBe(false);
  });
});

describe("searching Matters (ADR 0056, rule 1)", () => {
  it("asks for what matches, and for everything again when the text is gone", async () => {
    const { agent, asked } = agentRig([thing("a"), thing("b")]);
    await agent.start();
    agent.setQuery("b");
    await tick();
    expect(asked.at(-1)).toBe("b");
    expect(agent.filtered()).toBe(true);
    expect(agent.things().map((t) => t.threadId)).toEqual(["b"]);
    expect(agent.selected()?.threadId).toBe("b");
    agent.setQuery("");
    await tick();
    expect(asked.at(-1)).toBeUndefined();
    expect(agent.things()).toHaveLength(2);
    expect(agent.filtered()).toBe(false);
  });
});

describe("waiting for a search of Matters", () => {
  function waitingRig() {
    const asked: string[] = [];
    const answers: (() => void)[] = [];
    const backend = {
      onEvent: () => () => {},
      agentStatus: async () => ({ settings: { enabled: true }, progress: { state: "idle" } }),
      agentThings: (_limit: number, query?: string) => {
        if (query === undefined) return Promise.resolve({ things: [thing("a")], total: 1 });
        asked.push(query);
        return new Promise((resolve) => {
          answers.push(() => resolve({ things: [], total: 0 }));
        });
      },
      openThread: async (id: string) => ({ thread: { id, accountId: "a" }, messages: [] }),
    } as unknown as Backend;
    const agent = createAgentStore(backend, {
      openDraft: async () => {},
      schedule: () => () => {},
    });
    return { agent, asked, answers };
  }

  it("says it is searching until the newest text is answered", async () => {
    const { agent, answers } = waitingRig();
    await agent.start();
    expect(agent.searching()).toBe(false);
    agent.setQuery("x");
    expect(agent.searching()).toBe(true);
    answers[0]?.();
    await tick();
    expect(agent.searching()).toBe(false);
  });

  it("asks one search at a time, and only for what was typed last", async () => {
    const { agent, asked, answers } = waitingRig();
    await agent.start();
    agent.setQuery("f");
    agent.setQuery("fa");
    agent.setQuery("fak");
    await tick();
    expect(asked).toEqual(["f"]);
    answers[0]?.();
    await tick();
    expect(asked).toEqual(["f", "fak"]);
    expect(agent.searching()).toBe(true);
    answers[1]?.();
    await tick();
    expect(agent.searching()).toBe(false);
  });

  it("does not wait for a search that nobody wants any more", async () => {
    const { agent, asked, answers } = waitingRig();
    await agent.start();
    agent.setQuery("f");
    agent.setQuery("");
    expect(agent.searching()).toBe(false);
    await tick();
    expect(agent.things().map((t) => t.threadId)).toEqual(["a"]);
    answers[0]?.();
    await tick();
    expect(asked).toEqual(["f"]);
    expect(agent.things().map((t) => t.threadId)).toEqual(["a"]);
  });
});

describe("now and the rest (ADR 0058, rule 2)", () => {
  const rig = (now: number | undefined, all: readonly Thing[]) => {
    const backend = {
      onEvent: () => () => {},
      agentStatus: async () => ({ settings: { enabled: true }, progress: { state: "idle" } }),
      agentThings: async (limit: number, query?: string) => ({
        things: all.slice(0, limit),
        total: all.length,
        ...(query === undefined && now !== undefined ? { now } : {}),
      }),
      openThread: async (id: string) => ({ thread: { id, accountId: "a" }, messages: [] }),
      agentFeedback: async () => {},
      agentRuleOffer: async () => null,
    } as unknown as Backend;
    return createAgentStore(backend, { openDraft: async () => {}, schedule: () => () => {} });
  };
  const LIST = [{ ...thing("a"), now: true }, { ...thing("b"), now: true }, thing("c"), thing("d")];
  const ids = (agent: ReturnType<typeof rig>) => agent.things().map((t) => t.threadId);

  it("shows what is for now, and the rest when it is opened", async () => {
    const agent = rig(2, LIST);
    await agent.start();
    expect(agent.sections()).toBe(true);
    expect(ids(agent)).toEqual(["a", "b"]);
    expect(agent.restCount()).toBe(2);
    expect(agent.count()).toBe(4);
    agent.setRestOpen(true);
    expect(ids(agent)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not leave the selection in a rest that closes", async () => {
    const agent = rig(2, LIST);
    await agent.start();
    agent.setRestOpen(true);
    agent.select("d");
    agent.setRestOpen(false);
    expect(agent.selected()?.threadId).toBe("a");
  });

  it("shows what is left when everything for now is dealt with", async () => {
    const agent = rig(2, LIST);
    await agent.start();
    await agent.feedbackMany([LIST[0], LIST[1]] as Thing[], "later");
    expect(ids(agent)).toEqual(["c", "d"]);
  });

  it("has no sections with one part, without the count, or in a search", async () => {
    for (const now of [0, 4, undefined]) {
      const agent = rig(now, LIST);
      await agent.start();
      expect(agent.sections()).toBe(false);
      expect(ids(agent)).toHaveLength(4);
    }
    const searching = rig(2, LIST);
    await searching.start();
    searching.setQuery("x");
    await tick();
    expect(searching.sections()).toBe(false);
    expect(ids(searching)).toHaveLength(4);
  });
});

describe("what a closing also hides (ADR 0065)", () => {
  it("says so on the tray's line, in the singular too, and not when it is nothing", async () => {
    const list = [thing("a"), thing("b"), thing("c")];
    const { agent, covers } = agentRig(list);
    await agent.start();
    covers.set("a", 8);
    await agent.feedback(list[0] as Thing, "closed");
    expect(agent.line()?.text).toBe("Closed, no reply needed · also 8 older mails");
    covers.set("b", 1);
    await agent.feedback(list[1] as Thing, "notImportant");
    expect(agent.line()?.text).toBe("Marked not important · also 1 older mail");
    await agent.feedback(list[2] as Thing, "later");
    expect(agent.line()?.text).toBe("Set aside until tomorrow morning");
  });
});

describe("setting several things aside (ADR 0056, rule 5)", () => {
  it("is one line and one Undo, with no rule on offer", async () => {
    const list = [thing("a"), thing("b"), thing("c")];
    const { agent, feedback, undone } = agentRig(list);
    await agent.start();
    expect(await agent.feedbackMany([list[0], list[1]] as Thing[], "closed")).toBe(2);
    expect(feedback).toEqual(["a:closed", "b:closed"]);
    expect(agent.things().map((t) => t.threadId)).toEqual(["c"]);
    expect(agent.line()?.text).toBe("2 things: closed, no reply needed");
    expect(agent.line()?.threadIds).toEqual(["a", "b"]);
    await agent.undoFeedback();
    expect(undone).toEqual(["a", "b"]);
    expect(agent.things()).toHaveLength(3);
  });

  it("says on one line how many older mails the group's closings also hid (ADR 0065)", async () => {
    const list = [thing("a"), thing("b"), thing("c")];
    const { agent, covers } = agentRig(list);
    await agent.start();
    covers.set("a", 2);
    covers.set("b", 3);
    await agent.feedbackMany([list[0], list[1]] as Thing[], "closed");
    expect(agent.line()?.text).toBe("2 things: closed, no reply needed · also 5 older mails");
  });

  it("brings back what was refused, and counts only what was recorded", async () => {
    const list = [thing("a"), thing("b")];
    const { agent, refuseNext } = agentRig(list);
    await agent.start();
    refuseNext("b");
    expect(await agent.feedbackMany(list, "later")).toBe(1);
    expect(agent.things().map((t) => t.threadId)).toEqual(["b"]);
    expect(agent.line()?.text).toContain("1 thing:");
  });
});
