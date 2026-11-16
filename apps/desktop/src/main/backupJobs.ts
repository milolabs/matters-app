// Back Up… and Restore from a Backup… in Settings › Storage (ADR 0145, rules 6 to 9): main's
// side. Main shows the dialogs, starts the work in a process of its own (backupWorker.ts) and
// ends it on Stop, and owns every file name: a backup is written under a temporary name beside
// the chosen one and takes its name only when it is whole and flushed; a file to restore is
// copied into the data folder first, and only that copy is checked, prepared and swapped in at
// the next start. One job at a time. Everything from outside comes in through `BackupDeps`, so the
// rules can be tested without a window, a dialog or a process.
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type {
  BackupAnswer,
  BackupJobState,
  BackupOverview,
  RestoreAnswer,
} from "@matters/contracts";
import { backupFileName, type RestoreVerdict, restoreRefusalText } from "@matters/core";
import {
  cancelPending,
  listSetAside,
  makePending,
  readPending,
  restorePaths,
  setAsidePath,
  sweepIncoming,
} from "./restore.ts";

/** A job of the worker process: its answer, and a way to end it at once. */
export interface WorkerRun {
  readonly answer: Promise<unknown>;
  kill(): void;
}

export interface BackupFs {
  /** Creates an empty file, mode 0600, that must not exist yet. */
  createPrivate(path: string): Promise<void>;
  /** Flushes a file to disk. */
  sync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Copies a file the person chose, by clone where the disk can; the copy is mode 0600. */
  copyIn(from: string, to: string): Promise<void>;
  /** Size of a file, 0 when it is not there. */
  size(path: string): Promise<number>;
  mkdir(path: string): Promise<void>;
  chmodPrivate(path: string): Promise<void>;
}

export interface BackupDeps {
  readonly databasePath: string;
  chooseSavePath(defaultName: string): Promise<string | undefined>;
  chooseBackupFile(): Promise<string | undefined>;
  work(
    job:
      | { readonly kind: "copy"; readonly source: string; readonly target: string }
      | { readonly kind: "check"; readonly path: string; readonly current: string }
      | { readonly kind: "consolidate"; readonly path: string },
  ): WorkerRun;
  readonly fs: BackupFs;
  now(): number;
  dayOf(ms: number): string;
  log(message: string, error?: unknown): void;
}

export type {
  BackupAnswer,
  BackupJobState,
  BackupOverview,
  RestoreAnswer,
} from "@matters/contracts";

const BACKUP_FAILED = "The backup could not be written. Nothing was left under its name.";
const RESTORE_FAILED = "The backup could not be read, so nothing will change.";

/** The worker's answer to a check, read without trusting its shape. */
function readCheck(value: unknown):
  | {
      readonly verdict: RestoreVerdict;
      readonly prepared?: { messages: number; accounts: number; heldSends: number };
      readonly holdAccounts?: readonly string[];
    }
  | { readonly message: string } {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.ok !== true) return { message: typeof v.message === "string" ? v.message : "no answer" };
  return v as never;
}

export class BackupJobs {
  private readonly deps: BackupDeps;
  private job: {
    state: BackupJobState;
    run: WorkerRun | null;
    stopped: boolean;
    temp?: string;
  } | null = null;

  constructor(deps: BackupDeps) {
    this.deps = deps;
  }

  async overview(): Promise<BackupOverview> {
    const { databasePath } = this.deps;
    return {
      pending: await readPending(databasePath),
      setAside: await listSetAside(databasePath),
      job: await this.state(),
    };
  }

  /** The job's state, with how much of a backup is written so far. */
  async state(): Promise<BackupJobState> {
    const job = this.job;
    if (!job) return { kind: "idle" };
    if (job.state.kind === "backingUp" && job.temp) {
      return { ...job.state, writtenBytes: await this.deps.fs.size(job.temp) };
    }
    return job.state;
  }

  /** Stop: the worker ends at once, and what it wrote is removed. */
  stop(): void {
    const job = this.job;
    if (!job) return;
    job.stopped = true;
    job.run?.kill();
  }

  /**
   * Back Up… (rule 6): asks where (the default name carries the day), then the worker writes a
   * consistent copy under a temporary name beside it, `.<name>.part-<random>`, made empty with
   * mode 0600 first. Whole, it is flushed and takes its name (the dialog asked before replacing).
   * Stopped or failed, the temporary file goes and nothing is left under the name.
   */
  async backup(): Promise<BackupAnswer> {
    if (this.job) return { kind: "busy" };
    const { deps } = this;
    const target = await deps.chooseSavePath(backupFileName(deps.dayOf(deps.now())));
    if (target === undefined) return { kind: "cancelled" };
    if (this.job) return { kind: "busy" };
    const temp = join(dirname(target), `.${basename(target)}.part-${randomUUID()}`);
    const databaseBytes = await deps.fs.size(deps.databasePath);
    const job = {
      state: { kind: "backingUp", writtenBytes: 0, databaseBytes } as BackupJobState,
      run: null as WorkerRun | null,
      stopped: false,
      temp,
    };
    this.job = job;
    try {
      await deps.fs.createPrivate(temp);
      job.run = deps.work({ kind: "copy", source: deps.databasePath, target: temp });
      const answer = (await job.run.answer) as { ok?: unknown; message?: unknown } | null;
      if (job.stopped) return await this.clean(temp, { kind: "stopped" });
      if (answer?.ok !== true) {
        deps.log(`a backup failed: ${String(answer?.message ?? "no answer")}`);
        return await this.clean(temp, { kind: "failed", text: BACKUP_FAILED });
      }
      await deps.fs.sync(temp);
      await deps.fs.chmodPrivate(temp);
      await deps.fs.rename(temp, target);
      return { kind: "done", name: basename(target), bytes: await deps.fs.size(target) };
    } catch (error) {
      deps.log("a backup failed", error);
      return await this.clean(
        temp,
        job.stopped ? { kind: "stopped" } : { kind: "failed", text: BACKUP_FAILED },
      );
    } finally {
      this.job = null;
    }
  }

  /**
   * Restore from a Backup… (rules 8 and 9): asks for the file, copies it into the data folder
   * (`restore/incoming-<random>.db`, mode 0600), and has the worker check that copy and make it
   * ready. Refused, failed or stopped, the copy goes and nothing changes. Restorable, it becomes the
   * restore that waits, swapped in at the next start.
   */
  async restore(): Promise<RestoreAnswer> {
    if (this.job) return { kind: "busy" };
    const chosen = await this.deps.chooseBackupFile();
    if (chosen === undefined) return { kind: "cancelled" };
    return this.restoreFrom(chosen, false);
  }

  /**
   * Puts a set-aside database back (rule 9): it is made one file first (its log checkpointed into
   * it), then restored as any chosen file is, checks and all.
   */
  async restoreSetAside(name: unknown): Promise<RestoreAnswer> {
    if (this.job) return { kind: "busy" };
    const path = setAsidePath(this.deps.databasePath, name);
    if (path === null || (await this.deps.fs.size(path)) === 0)
      return { kind: "failed", text: RESTORE_FAILED };
    return this.restoreFrom(path, true);
  }

  /** Takes back the restore that waits; the database in use is as it was. */
  async cancelPending(): Promise<void> {
    await cancelPending(this.deps.databasePath);
  }

  private async restoreFrom(source: string, setAside: boolean): Promise<RestoreAnswer> {
    if (this.job) return { kind: "busy" };
    const { deps } = this;
    const paths = restorePaths(deps.databasePath);
    const incoming = join(paths.dir, `incoming-${randomUUID()}.db`);
    const job = {
      state: { kind: "copyingIn" } as BackupJobState,
      run: null as WorkerRun | null,
      stopped: false,
    };
    this.job = job;
    try {
      await deps.fs.mkdir(paths.dir);
      await sweepIncoming(deps.databasePath);
      if (setAside) {
        job.run = deps.work({ kind: "consolidate", path: source });
        const done = (await job.run.answer) as { ok?: unknown } | null;
        if (job.stopped) return { kind: "stopped" };
        if (done?.ok !== true) return { kind: "failed", text: RESTORE_FAILED };
      }
      await deps.fs.copyIn(source, incoming);
      if (job.stopped) return await this.clean(incoming, { kind: "stopped" });
      job.state = { kind: "checking" };
      job.run = deps.work({ kind: "check", path: incoming, current: deps.databasePath });
      const answer = readCheck(await job.run.answer);
      if (job.stopped) return await this.clean(incoming, { kind: "stopped" });
      if ("message" in answer) {
        deps.log(`a backup could not be checked: ${answer.message}`);
        return await this.clean(incoming, { kind: "failed", text: RESTORE_FAILED });
      }
      const { verdict } = answer;
      if (verdict.kind === "refused") {
        return await this.clean(incoming, {
          kind: "refused",
          reason: verdict.reason,
          text: restoreRefusalText(verdict.reason),
        });
      }
      const prepared = answer.prepared ?? { messages: 0, accounts: 0, heldSends: 0 };
      // A restore that waited already is replaced by this one.
      await cancelPending(deps.databasePath);
      const pending = await makePending(
        deps.databasePath,
        incoming,
        {
          holdAccounts: [...(answer.holdAccounts ?? [])],
          preparedAtMs: deps.now(),
          messages: prepared.messages,
          accounts: prepared.accounts,
          heldSends: prepared.heldSends,
        },
        deps.now(),
      );
      return { kind: "ready", pending };
    } catch (error) {
      deps.log("a restore could not be made ready", error);
      return await this.clean(
        incoming,
        job.stopped ? { kind: "stopped" } : { kind: "failed", text: RESTORE_FAILED },
      );
    } finally {
      this.job = null;
    }
  }

  /** Removes a temporary file and what SQLite may have left beside it, then answers. */
  private async clean<T>(path: string, answer: T): Promise<T> {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      await this.deps.fs.remove(`${path}${suffix}`).catch(() => {});
    }
    return answer;
  }
}
