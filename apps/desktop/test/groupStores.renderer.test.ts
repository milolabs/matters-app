import type { Message } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
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
