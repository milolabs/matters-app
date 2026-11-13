import { describe, expect, it } from "vitest";
import type { AgentBudget, PlanLimits } from "../src/index.ts";
import {
  DEFAULT_AGENT_BUDGET,
  DEFAULT_WEEK_SHARE_PERCENT,
  mayRun,
  NO_WEEK_LIMIT_PERCENT,
} from "../src/index.ts";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const NOW = 1_000_000_000_000;

function limits(session: number, week: number, over: Partial<PlanLimits> = {}): PlanLimits {
  return {
    session: { usedPercent: session, resetsAtMs: NOW + 2 * HOUR },
    week: { usedPercent: week, resetsAtMs: NOW + WEEK / 2 },
    usingOverage: false,
    seenAtMs: NOW,
    ...over,
  };
}

// Half the week has passed, so background work may have used half of its share.
const halfWeek: AgentBudget = {
  weekSharePercent: 10,
  usedByUsPercent: 0,
  weekStartMs: NOW - WEEK / 2,
};

describe("mayRun: the table of ADR 0051, rule 7", () => {
  const cases: [string, number, number, boolean][] = [
    // priority, session, week, allowed
    ["P0", 99, 99, true],
    ["P0", 100, 10, false],
    ["P0", 10, 100, false],
    ["P1", 70, 80, true],
    ["P1", 71, 10, false],
    ["P1", 10, 81, false],
    ["P2", 50, 70, true],
    ["P2", 51, 10, false],
    ["P2", 10, 71, false],
    ["P3", 25, 50, true],
    ["P3", 26, 10, false],
    ["P3", 10, 51, false],
  ];
  for (const [priority, session, week, allowed] of cases) {
    it(`${priority} at session ${session}% and week ${week}% is ${allowed ? "allowed" : "refused"}`, () => {
      const result = mayRun(priority as "P0", limits(session, week), halfWeek, NOW);
      expect(result.ok).toBe(allowed);
    });
  }

  it("names the window and when it resets", () => {
    expect(mayRun("P1", limits(90, 10), halfWeek, NOW)).toEqual({
      ok: false,
      reason: "sessionLimit",
      untilMs: NOW + 2 * HOUR,
    });
    expect(mayRun("P1", limits(10, 90), halfWeek, NOW)).toEqual({
      ok: false,
      reason: "weekLimit",
      untilMs: NOW + WEEK / 2,
    });
  });

  it("counts a window as empty once its reset time has passed", () => {
    const stale = limits(100, 10);
    expect(mayRun("P0", stale, halfWeek, NOW + 3 * HOUR)).toEqual({ ok: true });
  });
});

describe("mayRun: overage", () => {
  it("stops P1 to P3 while the runtime bills overage, and leaves P0", () => {
    const l = limits(1, 1, { usingOverage: true });
    for (const p of ["P1", "P2", "P3"] as const) {
      expect(mayRun(p, l, halfWeek, NOW)).toEqual({ ok: false, reason: "overage" });
    }
    expect(mayRun("P0", l, halfWeek, NOW)).toEqual({ ok: true });
  });
});

describe("mayRun: the even share of the week", () => {
  it("defaults to 10 percent", () => {
    expect(DEFAULT_WEEK_SHARE_PERCENT).toBe(10);
    expect(DEFAULT_AGENT_BUDGET.weekSharePercent).toBe(10);
  });

  // 60% of the week used at half the week: no spare, so the share binds.
  const busy = limits(1, 60);

  it("allows what has been earned so far and refuses beyond it", () => {
    expect(mayRun("P1", busy, { ...halfWeek, usedByUsPercent: 5 }, NOW)).toEqual({
      ok: true,
    });
    const over = mayRun("P1", busy, { ...halfWeek, usedByUsPercent: 6 }, NOW);
    expect(over).toMatchObject({ ok: false, reason: "budget" });
  });

  it("says when the share has caught up", () => {
    // 79% used leaves no spare until 21% of a week before the reset, after the share catches up.
    const result = mayRun("P1", limits(1, 79), { ...halfWeek, usedByUsPercent: 7.5 }, NOW);
    // 7.5% of a 10% share is three quarters of the week.
    expect(result).toEqual({ ok: false, reason: "budget", untilMs: NOW - WEEK / 2 + 0.75 * WEEK });
  });

  it("does not apply to P0", () => {
    expect(mayRun("P0", limits(1, 1), { ...halfWeek, usedByUsPercent: 50 }, NOW)).toEqual({
      ok: true,
    });
  });

  it("takes the week's start from the window when not given", () => {
    const b = { weekSharePercent: 10, usedByUsPercent: 6 };
    // The week window resets half a week from now, so half of it has passed.
    expect(mayRun("P1", busy, b, NOW)).toMatchObject({ ok: false, reason: "budget" });
    expect(mayRun("P1", busy, { ...b, usedByUsPercent: 5 }, NOW)).toEqual({ ok: true });
  });

  it("is a plain cap when the start of the week is not known", () => {
    const l: PlanLimits = { usingOverage: false, seenAtMs: NOW };
    expect(mayRun("P1", l, { weekSharePercent: 10, usedByUsPercent: 10 }, NOW)).toEqual({
      ok: true,
    });
    expect(mayRun("P1", l, { weekSharePercent: 10, usedByUsPercent: 11 }, NOW)).toEqual({
      ok: false,
      reason: "budget",
    });
  });
});

describe("mayRun: the spare of the week", () => {
  // The week resets in 9 hours with 57% left: the even share is spent, the rest would lapse.
  const lateWeek = (used: number): PlanLimits => ({
    session: { usedPercent: 18, resetsAtMs: NOW + 2 * HOUR },
    week: { usedPercent: used, resetsAtMs: NOW + 9 * HOUR },
    usingOverage: false,
    seenAtMs: NOW,
  });
  const spent: AgentBudget = { weekSharePercent: 25, usedByUsPercent: 24 };

  it("lets background work use what the week would lose", () => {
    expect(mayRun("P1", lateWeek(43), spent, NOW)).toEqual({ ok: true });
    expect(mayRun("P3", lateWeek(43), spent, NOW)).toEqual({ ok: true });
  });

  it("still stops at the priority's ceiling", () => {
    expect(mayRun("P3", lateWeek(51), spent, NOW)).toMatchObject({
      ok: false,
      reason: "weekLimit",
    });
  });

  it("is not there when the week is used at the plan's full pace", () => {
    expect(mayRun("P1", limits(1, 60), { ...halfWeek, usedByUsPercent: 6 }, NOW)).toMatchObject({
      ok: false,
      reason: "budget",
    });
  });

  it("names when the spare opens, when that is before the share catches up", () => {
    // 60% used: 40% left is spare from 40% of a week before the reset.
    const result = mayRun("P1", limits(1, 60), { ...halfWeek, usedByUsPercent: 9 }, NOW);
    expect(result).toEqual({ ok: false, reason: "budget", untilMs: NOW + WEEK / 2 - 0.4 * WEEK });
  });
});

describe("mayRun: unknown limits", () => {
  it("allow P0 and P1 only", () => {
    expect(mayRun("P0", undefined, halfWeek, NOW)).toEqual({ ok: true });
    expect(mayRun("P1", undefined, halfWeek, NOW)).toEqual({ ok: true });
    expect(mayRun("P2", undefined, halfWeek, NOW).ok).toBe(false);
    expect(mayRun("P3", undefined, halfWeek, NOW).ok).toBe(false);
  });
});

describe("mayRun: no limit (ADR 0131)", () => {
  // Far past any share: with no limit our own use of the week is not counted against it.
  const none: AgentBudget = {
    weekSharePercent: NO_WEEK_LIMIT_PERCENT,
    usedByUsPercent: 90,
    weekStartMs: NOW - WEEK / 10,
  };

  it("is 100 percent", () => {
    expect(NO_WEEK_LIMIT_PERCENT).toBe(100);
  });

  it("runs background work above every ceiling and past every share", () => {
    for (const p of ["P1", "P2", "P3"] as const) {
      expect(mayRun(p, limits(90, 95), none, NOW)).toEqual({ ok: true });
      expect(mayRun(p, limits(99, 99), none, NOW)).toEqual({ ok: true });
    }
  });

  it("stops when a window is full, until its reset", () => {
    for (const p of ["P1", "P2", "P3"] as const) {
      expect(mayRun(p, limits(100, 40), none, NOW)).toEqual({
        ok: false,
        reason: "sessionLimit",
        untilMs: NOW + 2 * HOUR,
      });
      expect(mayRun(p, limits(40, 100), none, NOW)).toEqual({
        ok: false,
        reason: "weekLimit",
        untilMs: NOW + WEEK / 2,
      });
    }
  });

  it("counts a window whose reset has passed as empty", () => {
    expect(mayRun("P3", limits(100, 100), none, NOW + WEEK)).toEqual({ ok: true });
  });

  it("never runs background work on paid credits", () => {
    for (const p of ["P1", "P2", "P3"] as const) {
      expect(mayRun(p, limits(10, 10, { usingOverage: true }), none, NOW)).toEqual({
        ok: false,
        reason: "overage",
      });
    }
  });

  it("keeps P2 and P3 waiting while the limits are unknown, and lets P1 learn them", () => {
    expect(mayRun("P1", undefined, none, NOW)).toEqual({ ok: true });
    expect(mayRun("P2", undefined, none, NOW).ok).toBe(false);
    expect(mayRun("P3", undefined, none, NOW).ok).toBe(false);
  });

  it("leaves a share below 100 as it was", () => {
    const share = { ...none, weekSharePercent: 99 };
    expect(mayRun("P1", limits(90, 95), share, NOW)).toMatchObject({ ok: false });
    expect(mayRun("P3", limits(30, 10), { ...share, usedByUsPercent: 0 }, NOW)).toMatchObject({
      ok: false,
      reason: "sessionLimit",
    });
    expect(mayRun("P1", limits(10, 60), { ...share, usedByUsPercent: 50 }, NOW)).toMatchObject({
      ok: false,
      reason: "budget",
    });
    expect(mayRun("P1", undefined, { ...share, usedByUsPercent: 100 }, NOW)).toMatchObject({
      ok: false,
      reason: "budget",
    });
  });
});
