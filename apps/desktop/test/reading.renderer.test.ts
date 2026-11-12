// The reading in the background can be seen (ADR 0117, rule 3a): the words of the list's foot row,
// of a saved view's line, of the popover and of Settings, and the store that reads the status.
import type { BackendEvent } from "@matters/contracts";
import type { PromptCount, PromptProgress, ReadingStatus, ReadingView } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  readingCountText,
  readingFoot,
  readingSettingsText,
  readingStateText,
  readingWaitActs,
  readingWaitText,
  resetText,
} from "../src/renderer/agentText.ts";
import {
  elapsedText,
  inFlightText,
  leftText,
  paceText,
  promptLine,
  SLOW_HERE,
  SLOW_TURN_MS,
  WAITS_FOR_BACKGROUND,
} from "../src/renderer/promptView.ts";
import { createReading } from "../src/renderer/reading.ts";

const NOW = Date.UTC(2026, 10, 12, 9);
const MIN = 60_000;

const view = (over: Partial<ReadingView> = {}): ReadingView => ({
  viewId: "v1",
  name: "Needs you",
  promptKey: "k1",
  found: 754,
  read: 292,
  toRead: 462,
  state: "waiting",
  ...over,
});

const status = (
  views: readonly ReadingView[],
  over: Partial<ReadingStatus> = {},
): ReadingStatus => ({
  ai: "on",
  runtime: "Codex",
  paused: false,
  views,
  ...over,
});

const live = (over: Partial<PromptProgress> = {}): PromptProgress => ({
  promptKey: "k1",
  phase: "reading",
  done: 0,
  total: 200,
  finished: false,
  background: true,
  view: { id: "v1", name: "Needs you", read: 240, total: 754 },
  runtime: "Ollama",
  ...over,
});

describe("why the reading waits, in words (rule 3a)", () => {
  const until = NOW + 5 * 3_600_000;
  const at = resetText(until, NOW);
  it.each([
    [{ kind: "pausedByPerson" }, "Reading paused", false],
    [{ kind: "limit", untilMs: until }, `Reading paused at Codex's limit until ${at}`, false],
    [{ kind: "limit" }, "Reading paused at Codex's limit", false],
    [
      { kind: "plan", reason: "sessionLimit", untilMs: until },
      `Waits for room in Codex's session until ${at}`,
      false,
    ],
    [{ kind: "plan", reason: "weekLimit" }, "Waits for room in Codex's week", false],
    [
      { kind: "plan", reason: "budget", untilMs: until },
      `Waits for its share of Codex's week until ${at}`,
      false,
    ],
    [{ kind: "plan", reason: "overage" }, "Waits: Codex is past its plan's limit", false],
    [
      { kind: "plan", reason: "sessionLimit", unknown: true },
      "Waits until Codex's limits are known",
      false,
    ],
    [{ kind: "checking" }, "Waits while Codex is checked", false],
    [{ kind: "signedOut" }, "Waits: sign in to Codex", true],
    [{ kind: "notPlan" }, "Waits: Codex is not on your plan", true],
    [{ kind: "runtime" }, "Waits: Codex is not ready", true],
    [{ kind: "consent" }, "Waits: no account is shared with Codex", true],
    [{ kind: "soon" }, "Reading goes on in a moment", false],
    [
      { kind: "failed", problem: "x" },
      "Stopped after a turn failed; tries again with new mail",
      false,
    ],
  ] as const)("%j", (wait, text, acts) => {
    expect(readingWaitText(wait, "Codex", NOW)).toBe(text);
    expect(readingWaitActs(wait)).toBe(acts);
  });

  it("names no runtime it does not know", () => {
    expect(readingWaitText({ kind: "signedOut" }, "", NOW)).toBe("Waits: sign in to the assistant");
  });
});

describe("the list's foot row (rule 3a)", () => {
  it("while a pass reads: which view and how far, and whether a turn is out", () => {
    const out = inFlightText({ threads: 10, sinceMs: NOW - 80_000 }, "Ollama", NOW);
    expect(out).toBe("10 sent to Ollama, 1 min 20 s");
    expect(
      readingFoot(status([view()]), live({ inFlight: { threads: 10, sinceMs: NOW } }), NOW),
    ).toEqual({
      text: "Needs you 240\u00a0/\u00a0754",
      kind: "reading",
      fraction: 240 / 754,
      inFlight: true,
    });
    expect(readingFoot(null, live({ done: 30 }), NOW)).toMatchObject({
      text: "Needs you 270\u00a0/\u00a0754",
      inFlight: false,
    });
    expect(readingSettingsText(status([view()]), live(), NOW, out)).toBe(
      "Reading Needs you 240\u00a0/\u00a0754 · 10 sent to Ollama, 1 min 20 s",
    );
  });

  it("while nothing reads: why, which view and how far; late only when the person must act", () => {
    const w = view({ wait: { kind: "pausedByPerson" } });
    expect(readingFoot(status([w], { wait: { kind: "pausedByPerson" } }), null, NOW)).toEqual({
      text: "Reading paused · Needs you 292\u00a0/\u00a0754",
      kind: "waiting",
      why: "Reading paused",
      which: "Needs you 292\u00a0/\u00a0754",
    });
    const two = [w, view({ viewId: "v2", name: "Bills", toRead: 8, wait: { kind: "soon" } })];
    expect(readingFoot(status(two), null, NOW)?.text).toBe("Reading paused · 2 views, 470 left");
    expect(readingFoot(status([view({ wait: { kind: "signedOut" } })]), null, NOW)).toEqual({
      text: "Waits: sign in to Codex · Needs you 292\u00a0/\u00a0754",
      kind: "act",
      why: "Waits: sign in to Codex",
      which: "Needs you 292\u00a0/\u00a0754",
    });
  });

  it("is not there when all is read, a view was never run, or AI is off", () => {
    const done = [view({ state: "upToDate", toRead: 0 }), view({ viewId: "v2", state: "notRun" })];
    expect(readingFoot(status(done), null, NOW)).toBeNull();
    expect(readingFoot(status([view()], { ai: "off" }), null, NOW)).toBeNull();
    expect(readingFoot(null, null, NOW)).toBeNull();
    expect(readingSettingsText(status(done), null, NOW)).toBe("Every view with a prompt is read.");
    expect(readingSettingsText(status([]), null, NOW)).toBe("No saved view has a prompt.");
  });

  it("says when no account is shared, though no view is listed", () => {
    expect(readingFoot(status([], { wait: { kind: "consent" } }), null, NOW)).toEqual({
      text: "Waits: no account is shared with Codex",
      kind: "act",
    });
  });
});

describe("the popover's rows (rule 3a)", () => {
  it("counts and states", () => {
    expect(readingCountText(view())).toBe("292 of 754 read");
    expect(readingCountText(view(), live({ done: 10 }))).toBe("250 of 754 read");
    expect(readingCountText(view({ state: "upToDate", read: 754, toRead: 0 }))).toBe("754 read");
    expect(readingCountText(view({ state: "notRun" }))).toBe("");
    expect(readingStateText(view({ state: "upToDate" }), "Codex", NOW)).toBe("Up to date");
    expect(readingStateText(view({ state: "notRun" }), "Codex", NOW)).toBe(
      "Not run yet: it is read once you open it",
    );
    expect(readingStateText(view({ state: "left", toRead: 3, left: 3 }), "Codex", NOW)).toBe(
      "3 sent twice came back with nothing; read again when they change",
    );
    expect(readingStateText(view({ wait: { kind: "pausedByPerson" } }), "Codex", NOW)).toBe(
      "Reading paused",
    );
  });
});

describe("what is in flight, on the line (rule 3a)", () => {
  it("counts its seconds and says the pace only once there is something to go on", () => {
    expect(elapsedText(0)).toBe("0 s");
    expect(elapsedText(45_000)).toBe("45 s");
    expect(elapsedText(2 * MIN)).toBe("2 min");
    expect(elapsedText(65 * MIN)).toBe("1 h 5 min");
    expect(inFlightText(undefined, "Ollama", NOW)).toBe("");
    expect(inFlightText({ threads: 3, sinceMs: NOW - 5000 }, undefined, NOW)).toBe("3 sent, 5 s");
    // One turn answered: too little to go on.
    expect(paceText({ turns: 1, sinceMs: NOW - 4 * MIN }, 10, 100, NOW)).toBe("");
    // 20 in 4 min: 80 more take about 16 min.
    expect(paceText({ turns: 2, sinceMs: NOW - 4 * MIN }, 20, 100, NOW)).toBe("about 16 min left");
    expect(paceText({ turns: 5, sinceMs: NOW - 10_000 }, 90, 100, NOW)).toBe("under a minute left");
    expect(paceText({ turns: 2, sinceMs: NOW - MIN }, 100, 100, NOW)).toBe("");
  });

  const count: PromptCount = {
    ai: "on",
    promptKey: "k1",
    searched: true,
    found: 462,
    read: 0,
    fits: 0,
    toRead: 462,
  };

  it("a run the person started: the count, what is out, and a hint when this Mac is slow", () => {
    const line = (since: number, local = true) =>
      promptLine({
        count,
        progress: {
          phase: "reading",
          done: 0,
          total: 462,
          inFlight: { threads: 10, sinceMs: since },
          runtime: "Ollama",
          ...(local ? { local: true as const } : {}),
        },
        stopping: false,
        outcome: null,
        now: NOW,
      });
    expect(line(NOW - 80_000)).toEqual({
      kind: "reading",
      text: "Reading 0 of 462 threads… · 10 sent to Ollama, 1 min 20 s",
      stopping: false,
    });
    expect(line(NOW - SLOW_TURN_MS)).toMatchObject({ hint: SLOW_HERE });
    expect(line(NOW - SLOW_TURN_MS, false)).not.toHaveProperty("hint");
  });

  it("a run that waits says what for, not a count that does not move", () => {
    const waiting = (w: "background" | "gate") =>
      promptLine({
        count,
        progress: { phase: "searching", done: 0, total: 0, waiting: w, runtime: "Codex" },
        stopping: false,
        outcome: null,
        now: NOW,
      })?.text;
    expect(waiting("background")).toBe(WAITS_FOR_BACKGROUND);
    expect(waiting("gate")).toBe("Checking Codex…");
  });

  it("a saved view read in the background says so by itself, how far, with what is out", () => {
    const l = promptLine({
      count: { ...count, read: 240, toRead: 514, found: 754 },
      progress: null,
      stopping: false,
      outcome: null,
      view: true,
      background: {
        phase: "reading",
        done: 0,
        total: 200,
        view: { id: "v1", name: "Needs you", read: 240, total: 754 },
        inFlight: { threads: 10, sinceMs: NOW - 5000 },
        runtime: "Codex",
      },
      now: NOW,
    });
    expect(l).toEqual({
      kind: "background",
      text: "Reading 240 of 754 in the background… · 10 sent to Codex, 5 s",
    });
  });

  it("a saved view nothing reads says why on its line, in full", () => {
    const base = {
      count: { ...count, read: 292, toRead: 462, found: 754 },
      progress: null,
      stopping: false,
      outcome: null,
      view: true,
      now: NOW,
    };
    expect(
      promptLine({
        ...base,
        reading: { view: view({ wait: { kind: "pausedByPerson" } }), runtime: "Codex" },
      }),
    ).toEqual({ kind: "count", text: "462 threads to read, 292 read already. Reading paused." });
    expect(
      promptLine({
        ...base,
        reading: {
          view: view({ wait: { kind: "plan", reason: "sessionLimit", untilMs: NOW + 3_600_000 } }),
          runtime: "Codex",
        },
      })?.text,
    ).toBe(
      `462 threads to read, 292 read already. Waits for room in Codex's session until ${resetText(NOW + 3_600_000, NOW)}.`,
    );
    expect(
      promptLine({
        ...base,
        reading: { view: view({ state: "left", left: 462 }), runtime: "Codex" },
      })?.text,
    ).toBe(`462 threads to read, 292 read already. ${leftText(462)}`);
    // Not a saved view, or its state not known yet: no claim about the background.
    expect(promptLine({ ...base, view: false })?.text).toBe(
      "462 threads to read, 292 read already.",
    );
    expect(promptLine({ ...base, reading: null })?.text).toBe(
      "462 threads to read, 292 read already.",
    );
  });
});

describe("the store of the reading (rule 3a)", () => {
  it("reads the status on a push after a quiet moment, keeps the pass that reads, and reads afresh on asking", async () => {
    const listeners = new Set<(e: BackendEvent) => void>();
    const asked: boolean[] = [];
    let next = status([view()]);
    const timers: (() => void)[] = [];
    const backend = {
      agentReadingStatus: async (fresh?: boolean) => {
        asked.push(fresh === true);
        return next;
      },
      onEvent: (l: (e: BackendEvent) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const push = (e: BackendEvent) => {
      for (const l of listeners) l(e);
    };
    await createRoot(async (dispose) => {
      const r = createReading(backend, {
        schedule: (run) => {
          timers.push(run);
          return () => {};
        },
      });
      await r.start();
      expect(r.status()).toEqual(next);
      push({ type: "agentChanged" });
      push({ type: "agentChanged" });
      expect(asked).toEqual([false]);
      next = status([view({ state: "reading" })]);
      for (const t of timers.splice(0)) t();
      await Promise.resolve();
      expect(asked).toEqual([false, false]);
      expect(r.status()?.views[0]?.state).toBe("reading");
      push({ type: "agentPromptProgress", ...live({ done: 10 }) });
      expect(r.live()?.done).toBe(10);
      push({ type: "agentPromptProgress", ...live({ done: 20, finished: true }) });
      expect(r.live()).toBeNull();
      await r.fresh();
      expect(asked.at(-1)).toBe(true);
      r.dispose();
      dispose();
    });
  });
});

describe("a saved view above the line (rule 3a)", () => {
  it("says why the background does not read it, beside the question", () => {
    const l = promptLine({
      count: {
        ai: "on",
        promptKey: "k1",
        searched: true,
        found: 1692,
        read: 0,
        fits: 0,
        toRead: 1692,
      },
      progress: null,
      stopping: false,
      outcome: null,
      view: true,
      reading: {
        view: view({ read: 0, toRead: 1692, wait: { kind: "pausedByPerson" } }),
        runtime: "Codex",
      },
      now: NOW,
    });
    expect(l).toEqual({
      kind: "ask",
      text: "Found 1,692 threads. Reading paused.",
      key: "↵ to read them all.",
    });
  });
});
