import { ManualClock, settle } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { FlagRunner } from "../src/backend/flagRunner.ts";

function rig() {
  const clock = new ManualClock();
  const log: string[] = [];
  const state = { due: null as number | null, fail: null as Error | null };
  const runner = new FlagRunner({
    clock,
    async process() {
      log.push(`process@${clock.now()}`);
      if (state.fail) throw state.fail;
    },
    nextDueMs: async () => state.due,
    onError: (e) => log.push(`error:${(e as Error).message}`),
  });
  return { clock, log, state, runner };
}

describe("FlagRunner", () => {
  it("waits for the time of the earliest request and runs then, not before", async () => {
    const r = rig();
    r.state.due = 1000;
    r.runner.wake();
    await settle();
    expect(r.log).toEqual([]);
    expect(r.clock.pendingDelays()).toEqual([1000]);

    await r.clock.advance(999);
    expect(r.log).toEqual([]);
    r.state.due = null;
    await r.clock.advance(1);
    expect(r.log).toEqual(["process@1000"]);
  });

  it("moves the timer when a newer request pushes the time out, so a burst is one run", async () => {
    const r = rig();
    r.state.due = 1000;
    r.runner.wake();
    await settle();
    await r.clock.advance(600);
    // The reader toggled again: the request now waits until 1600.
    r.state.due = 1600;
    r.runner.wake();
    await settle();
    expect(r.clock.pendingDelays()).toEqual([1000]);
    await r.clock.advance(999);
    expect(r.log).toEqual([]);
    r.state.due = null;
    await r.clock.advance(1);
    expect(r.log).toEqual(["process@1600"]);
  });

  it("never sleeps longer than 30 s, so a jumped clock is noticed", async () => {
    const r = rig();
    r.state.due = 3_600_000;
    r.runner.wake();
    await settle();
    expect(r.clock.pendingDelays()).toEqual([30_000]);
  });

  it("runs what is due at start-up and then arms for the rest", async () => {
    const r = rig();
    r.state.due = 5_000;
    await r.runner.runNow();
    expect(r.log).toEqual(["process@0"]);
    expect(r.clock.pendingDelays()).toEqual([5_000]);
  });

  it("does not run in parallel with itself", async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = (r.runner as unknown as { deps: { process: () => Promise<void> } }).deps;
    const inner = deps.process;
    deps.process = async () => {
      await gate;
      await inner();
    };
    const first = r.runner.runNow();
    const second = r.runner.runNow();
    await settle();
    release();
    await Promise.all([first, second]);
    expect(r.log).toEqual(["process@0"]);
  });

  it("reports an error and keeps its timer", async () => {
    const r = rig();
    r.state.fail = new Error("disk full");
    await r.runner.runNow();
    expect(r.log).toContain("error:disk full");
    expect(r.clock.pendingDelays()).toEqual([30_000]);
  });

  it("stop cancels the timer and later wakes do nothing", async () => {
    const r = rig();
    r.state.due = 5_000;
    r.runner.wake();
    await settle();
    await r.runner.stop();
    expect(r.clock.pendingDelays()).toEqual([]);
    r.runner.wake();
    await r.runner.runNow();
    await settle();
    expect(r.log).toEqual([]);
  });
});
