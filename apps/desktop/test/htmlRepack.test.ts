import type { ClockPort } from "@matters/core";
import { describe, expect, it } from "vitest";
import { startHtmlRepack } from "../src/backend/htmlRepack.ts";

// ADR 0088: the move to sender blocks runs in steps after launch, and stops when done.

function manualClock() {
  const timers: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
  const clock: ClockPort = {
    now: () => 0,
    setTimeout(run, delayMs) {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    random: () => 0,
  };
  /** Runs the oldest pending timer and lets its step settle; returns its delay. */
  const tick = async (): Promise<number | null> => {
    const timer = timers.find((t) => !t.cancelled);
    if (!timer) return null;
    timers.splice(timers.indexOf(timer), 1);
    timer.run();
    await new Promise((r) => setImmediate(r));
    return timer.delayMs;
  };
  return { clock, tick };
}

describe("html repack", () => {
  it("waits after launch, pauses between steps and ends when the list is empty", async () => {
    const { clock, tick } = manualClock();
    let left = 3;
    startHtmlRepack({
      clock,
      startDelayMs: 1000,
      pauseMs: 10,
      step: async () => {
        left -= 1;
        return { moved: 1, done: left === 0 };
      },
    });
    expect(await tick()).toBe(1000);
    expect(await tick()).toBe(10);
    expect(await tick()).toBe(10);
    expect(left).toBe(0);
    expect(await tick()).toBeNull();
  });

  it("stops on an error and when stopped", async () => {
    const { clock, tick } = manualClock();
    const errors: unknown[] = [];
    startHtmlRepack({
      clock,
      step: () => Promise.reject(new Error("disk")),
      onError: (e) => errors.push(e),
    });
    await tick();
    expect(errors).toHaveLength(1);
    expect(await tick()).toBeNull();

    let steps = 0;
    const stop = startHtmlRepack({
      clock,
      step: async () => {
        steps += 1;
        return { moved: 1, done: false };
      },
    });
    await tick();
    stop();
    expect(await tick()).toBeNull();
    expect(steps).toBe(1);
  });
});
