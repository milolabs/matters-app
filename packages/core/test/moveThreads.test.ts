import { describe, expect, it } from "vitest";
import { type MoveDeps, moveThread } from "../src/index.ts";

const message = (key: number, threadId: string) => ({
  key,
  threadId,
  accountId: "a",
  labelIds: ["INBOX"],
  mailboxes: 1,
});

function rig() {
  const threads = new Map([
    ["t1", [message(1, "t1"), message(2, "t1")]],
    ["t2", [message(3, "t2")]],
  ]);
  const put: { key: number; operationId: string }[][] = [];
  let runs = 0;
  let ids = 0;
  const deps = {
    store: {
      getThread: async (id: string) => {
        const messages = threads.get(id);
        return messages ? { thread: { accountId: "a" }, messages } : null;
      },
      listFolders: async () => [
        { id: "INBOX", accountId: "a", name: "INBOX", role: "inbox", exclusive: true },
        { id: "Archive", accountId: "a", name: "Archive", role: "archive", exclusive: true },
      ],
      setPlacement: async () => ({ changeSeq: 7, changedKeys: [] }),
    },
    moveOps: {
      put: async (rows: { key: number; operationId: string }[]) => {
        put.push(rows);
      },
    },
    uow: {
      run: <T>(work: () => Promise<T>) => {
        runs++;
        return work();
      },
    },
    now: () => 1000,
    newId: () => `op${++ids}`,
  } as unknown as MoveDeps;
  return { deps, put, runs: () => runs };
}

describe("moving several threads (ADR 0056, rule 6)", () => {
  it("is one action in one unit of work", async () => {
    const { deps, put, runs } = rig();
    const done = await moveThread(deps, { threadId: "t1", others: ["t2"], action: "archive" });
    expect(done.operationId).toBe("op1");
    expect(done.keys).toEqual([1, 2, 3]);
    expect(runs()).toBe(1);
    expect(put).toHaveLength(1);
    expect(new Set(put[0]?.map((r) => r.operationId))).toEqual(new Set(["op1"]));
  });

  it("counts a thread named twice once, and skips one that is gone", async () => {
    const { deps } = rig();
    const done = await moveThread(deps, {
      threadId: "t2",
      others: ["t2", "gone"],
      action: "archive",
    });
    expect(done.keys).toEqual([3]);
  });

  it("has nothing to take back when nothing moved", async () => {
    const { deps, put } = rig();
    const done = await moveThread(deps, { threadId: "gone", others: [], action: "archive" });
    expect(done.operationId).toBeNull();
    expect(put).toEqual([]);
  });
});
