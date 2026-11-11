import { describe, expect, it } from "vitest";
import type { Message, SeenIntent } from "../src/index.ts";
import { reapplyPendingSeen, rejectSeen, SEEN_PUSH_DELAY_MS, setSeen } from "../src/index.ts";

const message = (key: number, seen: boolean): Message =>
  ({ key, accountId: "a", flags: { seen } }) as unknown as Message;

const intent = (key: number, seen: boolean, previousSeen: boolean): SeenIntent => ({
  key,
  accountId: "a",
  seen,
  previousSeen,
  attempts: 0,
  nextAttemptMs: 0,
  createdAtMs: 0,
  rev: 1,
});

function recorder(over: { changed?: readonly number[]; stored?: readonly Message[] } = {}) {
  const calls: string[] = [];
  const puts: unknown[] = [];
  const deps = {
    uow: {
      async run<T>(work: () => Promise<T>) {
        calls.push("uow:start");
        const r = await work();
        calls.push("uow:end");
        return r;
      },
    },
    store: {
      async getByKeys(keys: readonly number[]) {
        calls.push(`get:${keys.join(",")}`);
        return over.stored ?? keys.map((k) => message(k, false));
      },
      async setSeen(keys: readonly number[], seen: boolean) {
        calls.push(`setSeen:${seen}:${keys.join(",")}`);
        return { changeSeq: 7, changedKeys: over.changed ?? keys };
      },
    },
    flagOps: {
      async put(intents: readonly unknown[]) {
        calls.push("put");
        puts.push(...intents);
      },
      async settle(intents: readonly SeenIntent[]) {
        calls.push(`settle:${intents.map((i) => i.key).join(",")}`);
        return intents;
      },
      async listPending() {
        return [];
      },
    },
    now: () => 1000,
  };
  return { deps, calls, puts };
}

describe("setSeen", () => {
  it("reads the old state, writes the flag, then the request, all in one unit", async () => {
    const { deps, calls, puts } = recorder({ stored: [message(2, true), message(1, false)] });
    const result = await setSeen(deps, [1, 2, 1], false);
    expect(calls).toEqual(["uow:start", "get:1,2", "setSeen:false:1,2", "put", "uow:end"]);
    expect(result.changeSeq).toBe(7);
    expect(puts).toEqual([
      {
        key: 2,
        accountId: "a",
        seen: false,
        previousSeen: true,
        nextAttemptMs: 1000 + SEEN_PUSH_DELAY_MS,
        createdAtMs: 1000,
      },
      expect.objectContaining({ key: 1, previousSeen: false }),
    ]);
  });

  it("queues only the messages that changed, and nothing when none did", async () => {
    const some = recorder({ changed: [2] });
    await setSeen(some.deps, [1, 2], true);
    expect(some.puts).toEqual([expect.objectContaining({ key: 2 })]);

    const none = recorder({ changed: [] });
    await setSeen(none.deps, [1], true);
    expect(none.calls).not.toContain("put");
  });
});

describe("reapplyPendingSeen", () => {
  it("writes nothing when nothing is pending", async () => {
    const { deps, calls } = recorder();
    expect(await reapplyPendingSeen(deps, "a")).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("rejectSeen", () => {
  it("settles first and restores only what it settled, grouped by the state to go back to", async () => {
    const { deps, calls } = recorder();
    const settled = [intent(1, true, false), intent(2, false, true), intent(3, true, false)];
    deps.flagOps.settle = async (intents) => {
      calls.push("settle");
      // Message 3 was replaced by a newer request meanwhile.
      return intents.filter((i) => i.key !== 3);
    };
    const restored = await rejectSeen(deps, settled);
    expect(calls).toEqual(["uow:start", "settle", "setSeen:true:2", "setSeen:false:1", "uow:end"]);
    expect(restored).toEqual([2, 1]);
  });

  it("does nothing for no requests", async () => {
    const { deps, calls } = recorder();
    expect(await rejectSeen(deps, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
