import { describe, expect, it } from "vitest";
import { BOOT_START, nextBootReport, readBootReport } from "../src/backend/bootStage.ts";
import type { FromWorker, ToWorker } from "../src/backend/protocol.ts";
import { SyncHost, type SyncHostHandlers, type WorkerLike } from "../src/backend/syncHost.ts";
import { REVEAL_DEADLINE_MS, revealDeadline, SCRIPT_GRACE_MS } from "../src/main/revealPolicy.ts";
import { bootExit, LOADER_FADE_MS, LOADER_MIN_MS } from "../src/renderer/bootScreen.ts";

// ADR 0103: startup in stages, the window shown by a policy rather than one timer, and a loading
// screen that never flashes.
describe("nextBootReport", () => {
  it("goes from starting to opening to ready", () => {
    const opening = nextBootReport(BOOT_START, { kind: "open" });
    expect(opening).toEqual({ stage: "opening", step: 0, total: 0 });
    expect(nextBootReport(opening, { kind: "ready" })).toEqual({
      stage: "ready",
      step: 0,
      total: 0,
    });
  });

  it("says how far an update is when the migration can count it", () => {
    const opening = nextBootReport(BOOT_START, { kind: "open" });
    const one = nextBootReport(opening, { kind: "migrating", step: 1, total: 3 });
    expect(one).toEqual({ stage: "updating", step: 1, total: 3 });
    expect(nextBootReport(one, { kind: "migrating", step: 2, total: 3 })).toEqual({
      stage: "updating",
      step: 2,
      total: 3,
    });
  });

  it("does not make up a count it was not given", () => {
    expect(nextBootReport(BOOT_START, { kind: "migrating", step: 4, total: 3 })).toEqual({
      stage: "updating",
      step: 0,
      total: 0,
    });
    expect(nextBootReport(BOOT_START, { kind: "migrating", step: 1.5, total: 3 }).total).toBe(0);
  });

  it("never goes back once ready, nor from updating to opening", () => {
    const ready = nextBootReport(BOOT_START, { kind: "ready" });
    expect(nextBootReport(ready, { kind: "migrating", step: 1, total: 1 })).toBe(ready);
    expect(nextBootReport(ready, { kind: "open" })).toBe(ready);
    const updating = nextBootReport(BOOT_START, { kind: "migrating", step: 1, total: 1 });
    expect(nextBootReport(updating, { kind: "open" })).toBe(updating);
  });
});

describe("readBootReport", () => {
  it("takes a known stage and two small integers", () => {
    expect(readBootReport({ type: "bootStage", stage: "updating", step: 2, total: 3 })).toEqual({
      stage: "updating",
      step: 2,
      total: 3,
    });
  });

  it("drops anything else", () => {
    expect(readBootReport(null)).toBeNull();
    expect(readBootReport({ stage: "subject: hello" })).toBeNull();
    expect(readBootReport({ stage: "ready", step: "2", total: {} })).toEqual({
      stage: "ready",
      step: 0,
      total: 0,
    });
    expect(readBootReport({ stage: "updating", step: 9, total: 3 })).toEqual({
      stage: "updating",
      step: 0,
      total: 0,
    });
    expect(readBootReport({ stage: "updating", step: -1, total: 1e9 })).toEqual({
      stage: "updating",
      step: 0,
      total: 0,
    });
  });
});

describe("revealDeadline", () => {
  const createdAtMs = 1000;

  it("is 800 ms after the window was created while the page has not started", () => {
    expect(revealDeadline({ createdAtMs, scriptStartedAtMs: null, stage: "opening" })).toBe(
      createdAtMs + REVEAL_DEADLINE_MS,
    );
  });

  it("does not pre-empt a page that started late and is about to finish", () => {
    // Dev: the script starts ~580–760 ms after the window was created.
    expect(revealDeadline({ createdAtMs, scriptStartedAtMs: 1700, stage: "ready" })).toBe(
      1700 + SCRIPT_GRACE_MS,
    );
  });

  it("keeps the 800 ms deadline for a page that started early", () => {
    expect(revealDeadline({ createdAtMs, scriptStartedAtMs: 1060, stage: "ready" })).toBe(
      createdAtMs + REVEAL_DEADLINE_MS,
    );
  });

  it("shows an update at the deadline, whatever the page does", () => {
    expect(revealDeadline({ createdAtMs, scriptStartedAtMs: 1700, stage: "updating" })).toBe(
      createdAtMs + REVEAL_DEADLINE_MS,
    );
  });
});

describe("bootExit", () => {
  it("goes at once, with no fade, when it was never seen", () => {
    expect(bootExit(null, 500, false)).toEqual({ waitMs: 0, fadeMs: 0 });
  });

  it("stays its minimum once seen, then fades", () => {
    expect(bootExit(1000, 1100, false)).toEqual({
      waitMs: LOADER_MIN_MS - 100,
      fadeMs: LOADER_FADE_MS,
    });
    expect(bootExit(1000, 2000, false)).toEqual({ waitMs: 0, fadeMs: LOADER_FADE_MS });
  });

  it("does not fade for reduced motion, and still does not flash", () => {
    expect(bootExit(1000, 1000, true)).toEqual({ waitMs: LOADER_MIN_MS, fadeMs: 0 });
  });
});

describe("SyncHost and an update of the schema", () => {
  it("passes on the worker's steps", () => {
    let onMessage: (m: FromWorker) => void = () => {};
    const worker: WorkerLike = {
      postMessage: (_m: ToWorker) => {},
      on(event: string, listener: (...args: never[]) => void) {
        if (event === "message") onMessage = listener as (m: FromWorker) => void;
        return this;
      },
      terminate: () => Promise.resolve(0),
    };
    const steps: [number, number][] = [];
    const handlers = new Proxy({} as SyncHostHandlers, {
      get: (_t, name) =>
        name === "onMigrating" ? (s: number, t: number) => steps.push([s, t]) : () => {},
    });
    const host = new SyncHost({ spawn: () => worker, handlers });
    void host.start();
    onMessage({ type: "migrating", step: 1, total: 2 });
    onMessage({ type: "migrating", step: 2, total: 2 });
    expect(steps).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
