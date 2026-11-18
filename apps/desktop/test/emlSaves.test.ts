import type { SourceOutcome } from "@matters/core";
import { describe, expect, it } from "vitest";
import { type EmlDeps, type EmlProgress, EmlSaves } from "../src/main/emlSaves.ts";
import { readEmlAnswer, readEmlLetters, readEmlProgress } from "../src/main/emlShapes.ts";

const DAY = Date.UTC(2026, 10, 16, 12);
const letter = (messageKey: number, subject = "Lunch", dateMs = DAY) => ({
  messageKey,
  subject,
  dateMs,
});

function setup(over: Partial<EmlDeps> = {}) {
  const saves: { job: string; messageKey: number; target: string; overwrite: boolean }[] = [];
  const marked: string[] = [];
  const progress: (EmlProgress | null)[] = [];
  const taken = new Set<string>();
  const outcomes: SourceOutcome[] = [];
  let jobs = 0;
  const deps: EmlDeps = {
    chooseSavePath: async (name) => `/Users/me/Downloads/${name}`,
    chooseFolder: async () => "/Users/me/Thread",
    exists: async (path) => taken.has(path),
    save: async (job, messageKey, target, overwrite, onBytes) => {
      saves.push({ job, messageKey, target, overwrite });
      onBytes(10, 20);
      return outcomes.shift() ?? "saved";
    },
    stop: async () => {},
    quarantine: async (path) => void marked.push(path),
    dayOf: () => "2026-11-16",
    progress: (p) => void progress.push(p),
    newJob: () => `job${++jobs}`,
    log: () => {},
    ...over,
  };
  return { saves, marked, progress, taken, outcomes, eml: new EmlSaves(deps) };
}

describe("Save as .eml… (ADR 0145, rules 1 to 5)", () => {
  it("saves one letter through the save dialog, under its subject and day, and marks it", async () => {
    let offered = "";
    const t = setup({
      chooseSavePath: async (name) => {
        offered = name;
        return `/Users/me/Downloads/${name}`;
      },
    });
    expect(await t.eml.save([letter(1)])).toEqual({ kind: "done", saved: 1, problem: null });
    expect(offered).toBe("Lunch 2026-11-16.eml");
    // The dialog asked before replacing, so the write may.
    expect(t.saves).toEqual([
      {
        job: "job1",
        messageKey: 1,
        target: "/Users/me/Downloads/Lunch 2026-11-16.eml",
        overwrite: true,
      },
    ]);
    expect(t.marked).toEqual(["/Users/me/Downloads/Lunch 2026-11-16.eml"]);
    expect(t.progress.at(0)).toEqual({ index: 0, count: 1, bytes: 0, totalBytes: 0 });
    expect(t.progress.at(-1)).toBeNull();
  });

  it("asks where first: a cancelled dialog fetches nothing", async () => {
    const t = setup({ chooseSavePath: async () => undefined, chooseFolder: async () => undefined });
    expect(await t.eml.save([letter(1)])).toEqual({ kind: "cancelled" });
    expect(await t.eml.save([letter(1), letter(2)])).toEqual({ kind: "cancelled" });
    expect(t.saves).toEqual([]);
  });

  it("saves several into a folder, one file each, named in the thread's order", async () => {
    const t = setup();
    await t.eml.save([letter(1, "Lunch"), letter(2, "Re: Lunch")]);
    expect(t.saves.map((s) => [s.target, s.overwrite])).toEqual([
      ["/Users/me/Thread/01 Lunch 2026-11-16.eml", false],
      ["/Users/me/Thread/02 Re: Lunch 2026-11-16.eml", false],
    ]);
  });

  it("never replaces a file in the folder: a taken name gets a number, also one taken meanwhile", async () => {
    const t = setup();
    t.taken.add("/Users/me/Thread/01 Lunch 2026-11-16.eml");
    // The second name is free when looked for, and taken by the time it is written.
    t.outcomes.push("saved", "exists", "saved");
    await t.eml.save([letter(1), letter(2)]);
    expect(t.saves.map((s) => s.target)).toEqual([
      "/Users/me/Thread/01 Lunch 2026-11-16 2.eml",
      "/Users/me/Thread/02 Lunch 2026-11-16.eml",
      "/Users/me/Thread/02 Lunch 2026-11-16 2.eml",
    ]);
    expect(t.saves.every((s) => !s.overwrite)).toBe(true);
  });

  it("says what was saved and what was not", async () => {
    const t = setup();
    t.outcomes.push("saved", "gone", "saved");
    expect(await t.eml.save([letter(1), letter(2), letter(3)])).toEqual({
      kind: "done",
      saved: 2,
      problem: "2 letters of 3 saved. 1 letter not: no longer on the server.",
    });
    expect(t.marked).toHaveLength(2);
    const one = setup();
    one.outcomes.push("offline");
    expect(await one.eml.save([letter(1)])).toMatchObject({
      saved: 0,
      problem: expect.stringMatching(/reached/),
    });
  });

  it("stops the letter being written and starts no other", async () => {
    let release!: (o: SourceOutcome) => void;
    const stopped: string[] = [];
    const t = setup({
      save: (job) =>
        new Promise<SourceOutcome>((resolve) => {
          release = resolve;
          void job;
        }),
      stop: async (job) => {
        stopped.push(job);
        release("cancelled");
      },
    });
    const running = t.eml.save([letter(1), letter(2), letter(3)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.eml.save([letter(9)])).toEqual({ kind: "busy" });
    await t.eml.stop();
    expect(await running).toEqual({
      kind: "done",
      saved: 0,
      problem: "0 letters of 3 saved. Stopped before the rest.",
    });
    expect(stopped).toEqual(["job1"]);
  });

  it("takes only letters of the right shape from the page", async () => {
    const t = setup();
    for (const bad of [
      null,
      [],
      [{ messageKey: -1, subject: "", dateMs: 0 }],
      [{ messageKey: 1 }],
      "x",
    ]) {
      expect(await t.eml.save(bad)).toEqual({ kind: "invalid" });
    }
    expect(
      readEmlLetters([{ messageKey: 1, subject: "s".repeat(5000), dateMs: 1 }])?.[0]?.subject,
    ).toHaveLength(2000);
    expect(readEmlLetters(Array.from({ length: 501 }, (_, i) => letter(i + 1)))).toBeNull();
    expect(t.saves).toEqual([]);
  });

  it("reads main's answer and progress before the page does", () => {
    expect(readEmlAnswer({ kind: "done", saved: 1, problem: null })).toEqual({
      kind: "done",
      saved: 1,
      problem: null,
    });
    expect(readEmlAnswer({ kind: "evil" })).toMatchObject({ kind: "done", saved: 0 });
    expect(readEmlProgress({ index: 0, count: 2, bytes: 5, totalBytes: 9 })).toEqual({
      index: 0,
      count: 2,
      bytes: 5,
      totalBytes: 9,
    });
    expect(readEmlProgress({ index: -1, count: 2, bytes: 5, totalBytes: 9 })).toBeNull();
  });
});
