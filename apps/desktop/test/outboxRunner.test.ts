import type { ReconcileReport, SendOperation } from "@matters/core";
import { ManualClock, settle } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { OutboxRunner } from "../src/backend/outboxRunner.ts";

const op = (kind: string): SendOperation => ({ state: { kind } }) as unknown as SendOperation;
const none: ReconcileReport = { resolved: 0, leftToUser: 0, waiting: 0 };

function rig() {
  const clock = new ManualClock();
  const log: string[] = [];
  const state = {
    due: null as number | null,
    unknown: false,
    processed: [] as SendOperation[],
    report: none,
    fail: null as Error | null,
  };
  const runner = new OutboxRunner({
    clock,
    async process() {
      log.push(`process@${clock.now()}`);
      if (state.fail) throw state.fail;
      const done = state.processed;
      state.processed = [];
      return done;
    },
    async reconcile() {
      log.push(`reconcile@${clock.now()}`);
      return state.report;
    },
    nextDueMs: async () => state.due,
    hasUnknown: async () => state.unknown,
    onError: (e) => log.push(`error:${(e as Error).message}`),
  });
  return { clock, log, state, runner };
}

describe("OutboxRunner", () => {
  it("sleeps until the next send is due, and runs then", async () => {
    const r = rig();
    r.state.due = 10_000;
    r.runner.wake();
    await settle();
    expect(r.log).toEqual(["process@0"]);
    expect(r.clock.pendingDelays()).toEqual([10_000]);

    await r.clock.advance(9_999);
    expect(r.log).toEqual(["process@0"]);
    r.state.due = null;
    await r.clock.advance(1);
    expect(r.log).toEqual(["process@0", "process@10000"]);
  });

  it("never sleeps longer than 30 s, so a jumped clock is noticed", async () => {
    const r = rig();
    r.state.due = 3_600_000;
    r.runner.wake();
    await settle();
    expect(r.clock.pendingDelays()).toEqual([30_000]);
  });

  it("a wake replaces the timer and runs at once", async () => {
    const r = rig();
    r.state.due = 60_000;
    r.runner.wake();
    await settle();
    r.state.due = 5_000;
    r.runner.wake();
    await settle();
    expect(r.log).toEqual(["process@0", "process@0"]);
    expect(r.clock.pendingDelays()).toEqual([5_000]);
  });

  it("a wake during a run causes one more run, not a parallel one", async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = r.runner as unknown as { deps: { process: () => Promise<SendOperation[]> } };
    const inner = original.deps.process;
    let first = true;
    original.deps.process = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return inner();
    };
    r.runner.wake();
    r.runner.wake();
    r.runner.wake();
    await settle();
    release();
    await settle();
    expect(r.log.filter((l) => l.startsWith("process"))).toHaveLength(2);
  });

  it("settles unknown sends after a run that produced one, then asks again while it waits", async () => {
    const r = rig();
    r.state.unknown = true;
    r.state.processed = [op("unknown")];
    r.state.report = { resolved: 0, leftToUser: 0, waiting: 1 };
    r.runner.wake();
    await settle();
    expect(r.log).toEqual(["process@0", "reconcile@0"]);
    expect(r.clock.pendingDelays()).toEqual([20_000]);

    await r.clock.advance(20_000);
    expect(r.log.filter((l) => l.startsWith("reconcile"))).toHaveLength(2);

    // once the provider cannot settle it, no more connections are opened for it
    r.state.report = { resolved: 0, leftToUser: 1, waiting: 0 };
    await r.clock.advance(20_000);
    const asked = r.log.filter((l) => l.startsWith("reconcile")).length;
    await r.clock.advance(120_000);
    expect(r.log.filter((l) => l.startsWith("reconcile"))).toHaveLength(asked);
  });

  it("does not look for unknown sends when there are none", async () => {
    const r = rig();
    r.runner.wake();
    await settle();
    expect(r.log).toEqual(["process@0"]);
  });

  it("reports an error and keeps running", async () => {
    const r = rig();
    r.state.fail = new Error("disk full");
    r.runner.wake();
    await settle();
    expect(r.log).toContain("error:disk full");
    expect(r.clock.pendingDelays()).toEqual([30_000]);
  });

  it("stop cancels the timer and waits for the run in flight", async () => {
    const r = rig();
    r.state.due = 5_000;
    r.runner.wake();
    await settle();
    await r.runner.stop();
    expect(r.clock.pendingDelays()).toEqual([]);
    r.runner.wake();
    await settle();
    expect(r.log).toEqual(["process@0"]);
  });
});
