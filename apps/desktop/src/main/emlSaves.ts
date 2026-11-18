// Save as .eml… (ADR 0145, rules 1 to 5): what main does when the mail window asks to save the
// open thread's letters as files. One letter: the save dialog, one file. Several: a folder, one
// file per letter, named so the folder reads the thread in order. The page names letters by key,
// with the subject and date for their names; main makes the names safe, asks where, and has the
// backend fetch each message as the server has it and write it there. Everything from outside
// comes in through `EmlDeps`, so the rules can be tested without a window, a dialog or a disk.
import { join } from "node:path";
import {
  emlFileName,
  emlFolderNames,
  numberedFileName,
  type SourceOutcome,
  sourcesSummaryText,
} from "@matters/core";
import {
  type EmlAnswer,
  type EmlLetterAsk,
  type EmlProgress,
  readEmlLetters,
} from "./emlShapes.ts";

export type { EmlLetterAsk } from "./emlShapes.ts";

/** How many numbers a taken name is tried with before the letter is reported not saved. */
const MAX_NUMBER = 1000;

export type { EmlAnswer, EmlProgress } from "./emlShapes.ts";

export interface EmlDeps {
  /** The save dialog for one letter; undefined when cancelled. It asks before it replaces. */
  chooseSavePath(defaultName: string): Promise<string | undefined>;
  /** The folder dialog for several; undefined when cancelled. */
  chooseFolder(): Promise<string | undefined>;
  /** Whether something of that name is in the folder (a file, a folder, a link). */
  exists(path: string): Promise<boolean>;
  /** The backend fetches the message and writes it to `target`. */
  save(
    job: string,
    messageKey: number,
    target: string,
    overwrite: boolean,
    onBytes: (bytes: number, total: number) => void,
  ): Promise<SourceOutcome>;
  stop(job: string): Promise<void>;
  /** Marks the file as from the internet; rejects when it could not. */
  quarantine(path: string): Promise<void>;
  /** `YYYY-MM-DD` of a time, on this Mac's calendar. */
  dayOf(ms: number): string;
  progress(progress: EmlProgress | null): void;
  newJob(): string;
  log(message: string, error?: unknown): void;
}

export class EmlSaves {
  private readonly deps: EmlDeps;
  private running: { job: string | null; stopped: boolean } | null = null;

  constructor(deps: EmlDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Asks where first, so a cancelled dialog costs no download, then saves letter by letter. */
  async save(value: unknown): Promise<EmlAnswer> {
    const letters = readEmlLetters(value);
    if (letters === null) return { kind: "invalid" };
    if (this.running) return { kind: "busy" };
    const run = { job: null as string | null, stopped: false };
    this.running = run;
    try {
      const plan = await this.place(letters);
      if (plan === null) return { kind: "cancelled" };
      const outcomes: SourceOutcome[] = [];
      for (const [index, step] of plan.entries()) {
        if (run.stopped) {
          outcomes.push("cancelled");
          continue;
        }
        outcomes.push(await this.one(run, step, index, plan.length));
      }
      const saved = outcomes.filter((o) => o === "saved").length;
      return { kind: "done", saved, problem: sourcesSummaryText(outcomes) };
    } finally {
      this.running = null;
      this.deps.progress(null);
    }
  }

  /** Stop: the letter being written is cut short and removed, and the rest are not started. */
  async stop(): Promise<void> {
    const run = this.running;
    if (!run) return;
    run.stopped = true;
    if (run.job) await this.deps.stop(run.job);
  }

  /** Where each letter goes, or null when the person cancelled the dialog. */
  private async place(
    letters: readonly EmlLetterAsk[],
  ): Promise<{ messageKey: number; target: string; overwrite: boolean; folder: boolean }[] | null> {
    const { deps } = this;
    if (letters.length === 1) {
      const only = letters[0] as EmlLetterAsk;
      const target = await deps.chooseSavePath(emlFileName(only.subject, deps.dayOf(only.dateMs)));
      // The dialog has asked about a file that is there.
      return target === undefined
        ? null
        : [{ messageKey: only.messageKey, target, overwrite: true, folder: false }];
    }
    const folder = await deps.chooseFolder();
    if (folder === undefined) return null;
    const names = emlFolderNames(
      letters.map((l) => ({ subject: l.subject, day: deps.dayOf(l.dateMs) })),
    );
    return letters.map((l, i) => ({
      messageKey: l.messageKey,
      target: join(folder, names[i] as string),
      overwrite: false,
      folder: true,
    }));
  }

  /**
   * One letter. In a folder a taken name gets ` 2`, ` 3` before `.eml` and nothing there is
   * replaced (rule 2): the name is looked for first, and the write itself refuses a name taken
   * meanwhile, which tries the next number.
   */
  private async one(
    run: { job: string | null; stopped: boolean },
    step: { messageKey: number; target: string; overwrite: boolean; folder: boolean },
    index: number,
    count: number,
  ): Promise<SourceOutcome> {
    const { deps } = this;
    deps.progress({ index, count, bytes: 0, totalBytes: 0 });
    for (let n = 1; n <= (step.folder ? MAX_NUMBER : 1); n++) {
      const target = step.folder ? numberedFileName(step.target, n) : step.target;
      if (step.folder && (await deps.exists(target))) continue;
      const job = deps.newJob();
      run.job = job;
      let outcome: SourceOutcome;
      try {
        outcome = await deps.save(job, step.messageKey, target, step.overwrite, (bytes, total) =>
          deps.progress({ index, count, bytes, totalBytes: total }),
        );
      } catch (error) {
        deps.log("a message could not be saved as a file", error);
        outcome = "failed";
      } finally {
        run.job = null;
      }
      if (run.stopped && outcome !== "saved") return "cancelled";
      if (outcome === "exists" && step.folder) continue;
      if (outcome === "saved") await this.mark(target);
      return outcome;
    }
    return "exists";
  }

  /** A save that cannot be marked is still a save; the mark is for Gatekeeper. */
  private async mark(path: string): Promise<void> {
    try {
      await this.deps.quarantine(path);
    } catch (error) {
      this.deps.log("could not mark a saved message as downloaded", error);
    }
  }
}
