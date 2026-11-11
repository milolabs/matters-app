import type { AgentStatus } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createAgentStore } from "../src/renderer/agent.ts";
import type { Backend } from "../src/renderer/client.ts";
import { createStatusOrder } from "../src/renderer/statusOrder.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createStatusOrder", () => {
  it("drops an answer when something asked later has already been shown", async () => {
    const order = createStatusOrder();
    const shown: string[] = [];
    const older = deferred<string>();
    const newer = deferred<string>();
    const first = order.settle(older.promise, (v) => shown.push(v));
    const second = order.settle(newer.promise, (v) => shown.push(v));
    newer.resolve("chosen");
    await second;
    older.resolve("old");
    await first;
    expect(shown).toEqual(["chosen"]);
  });

  it("shows answers that come back in order, and still returns a dropped one", async () => {
    const order = createStatusOrder();
    const shown: number[] = [];
    await order.settle(Promise.resolve(1), (v) => shown.push(v));
    await order.settle(Promise.resolve(2), (v) => shown.push(v));
    expect(shown).toEqual([1, 2]);

    const late = deferred<number>();
    const pending = order.settle(late.promise, (v) => shown.push(v));
    await order.settle(Promise.resolve(4), (v) => shown.push(v));
    late.resolve(3);
    await expect(pending).resolves.toBe(3);
    expect(shown).toEqual([1, 2, 4]);
  });

  it("a failed request does not stop later answers from showing", async () => {
    const order = createStatusOrder();
    const shown: number[] = [];
    await expect(
      order.settle(Promise.reject(new Error("no")), (v: number) => shown.push(v)),
    ).rejects.toThrow("no");
    await order.settle(Promise.resolve(2), (v) => shown.push(v));
    expect(shown).toEqual([2]);
  });
});

describe("the agent store", () => {
  it("does not let a status read from before a change undo that change", async () => {
    const withShare = (weekSharePercent: number) =>
      ({ settings: { enabled: true, weekSharePercent } }) as unknown as AgentStatus;
    const slowRead = deferred<AgentStatus>();
    const backend = {
      agentStatus: () => slowRead.promise,
      onEvent: () => () => {},
    } as unknown as Backend;
    await createRoot(async (dispose) => {
      const store = createAgentStore(backend, { openDraft: async () => {} });
      const reading = store.refresh();
      await store.change(Promise.resolve(withShare(25)));
      expect(store.status()?.settings.weekSharePercent).toBe(25);
      slowRead.resolve(withShare(10));
      await reading;
      expect(store.status()?.settings.weekSharePercent).toBe(25);
      dispose();
    });
  });
});
