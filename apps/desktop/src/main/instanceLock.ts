// One running copy per data folder (ADR 0110). Electron's single-instance lock covers userData; this
// file covers the database, which `MATTERS_DB_PATH` can put outside it. The owner file next to the
// database names the process that has it open; a file a crashed run left is recognised and taken.
import { execFileSync } from "node:child_process";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** `<database>.owner`. Not `-…` (that would count as a mailbox file) and not `.lock` (SQLite's). */
export const OWNER_SUFFIX = ".owner";
export const ownerPath = (databasePath: string) => databasePath + OWNER_SUFFIX;

/** Who has the database open. `token` tells two writes of the same process apart. */
export interface Owner {
  readonly pid: number;
  /** When that process was created, on the wall clock. */
  readonly startedAtMs: number;
  readonly host: string;
  readonly token: string;
  /** For the message only: which data folder the other copy runs on. */
  readonly userData: string;
}

export function parseOwner(text: string): Owner | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.pid !== "number" ||
    !Number.isInteger(o.pid) ||
    o.pid <= 0 ||
    typeof o.startedAtMs !== "number" ||
    !Number.isFinite(o.startedAtMs) ||
    typeof o.host !== "string" ||
    typeof o.token !== "string" ||
    typeof o.userData !== "string"
  ) {
    return null;
  }
  return {
    pid: o.pid,
    startedAtMs: o.startedAtMs,
    host: o.host,
    token: o.token,
    userData: o.userData,
  };
}

/** What can be learned about the processes on this machine. */
export interface ProcessFacts {
  readonly pid: number;
  readonly host: string;
  readonly nowMs: number;
  /** When this machine started; a process recorded before that is gone. */
  readonly bootedAtMs: number;
  /** Whether a process with that pid exists (one we may not signal counts). */
  alive(pid: number): boolean;
  /** When the process with that pid was created, or null where that cannot be read. */
  startedAtMs(pid: number): number | null;
}

/** A process start read back is accurate to the second; the recorded one to process creation. */
export const START_TOLERANCE_MS = 5_000;
/** An unreadable owner file this young may be one being written right now. */
export const YOUNG_FILE_MS = 10_000;

export type Verdict =
  | { readonly kind: "held"; readonly owner: Owner | null; readonly why: string }
  | { readonly kind: "stale"; readonly why: string };

/**
 * Whether the owner file names a process that still runs. Every doubt is "held": two writers on one
 * database are worse than a message that says which file to remove.
 */
export function ownerVerdict(owner: Owner | null, fileAgeMs: number, facts: ProcessFacts): Verdict {
  if (!owner) {
    return fileAgeMs < YOUNG_FILE_MS
      ? { kind: "held", owner: null, why: "another copy is starting" }
      : { kind: "stale", why: "unreadable" };
  }
  if (owner.host !== facts.host) {
    return {
      kind: "held",
      owner,
      why: `a copy on ${owner.host}, which this computer cannot check`,
    };
  }
  // This process has written nothing yet: a file with its pid is from an earlier process.
  if (owner.pid === facts.pid) return { kind: "stale", why: "pid reused by this process" };
  if (!facts.alive(owner.pid)) return { kind: "stale", why: "process gone" };
  const started = facts.startedAtMs(owner.pid);
  if (started !== null) {
    return Math.abs(started - owner.startedAtMs) > START_TOLERANCE_MS
      ? { kind: "stale", why: "pid reused by another process" }
      : { kind: "held", owner, why: `process ${owner.pid}` };
  }
  // No way to read a start time (Windows): a restart since is still certain.
  if (owner.startedAtMs < facts.bootedAtMs - START_TOLERANCE_MS) {
    return { kind: "stale", why: "recorded before the last restart" };
  }
  return { kind: "held", owner, why: `process ${owner.pid}` };
}

/** `ps -o etime=`: `[[dd-]hh:]mm:ss`, in seconds; null for anything else. */
export function parseElapsed(text: string): number | null {
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

/** The file system as the claim sees it; synchronous, because it runs before ready. */
export interface OwnerFs {
  /** Creates `path` with `text`, complete, or throws `EEXIST` when it is there. */
  create(path: string, text: string): void;
  /** The text and its age, or null when nothing is there. */
  read(path: string, nowMs: number): { text: string; ageMs: number } | null;
  /** Throws `ENOENT` when `from` is gone (somebody else moved it first). */
  rename(from: string, to: string): void;
  /** Like `create`, from an existing file: puts back a file moved by mistake. */
  restore(from: string, to: string): void;
  remove(path: string): void;
}

const code = (error: unknown) => (error as { code?: string } | null)?.code;

export const nodeOwnerFs: OwnerFs = {
  create(path, text) {
    // Written aside and linked into place: a reader never sees half a file. A volume without hard
    // links gets an exclusive create; a reader of a half-written file sees a young unreadable one.
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, path);
    } catch (error) {
      if (code(error) === "EEXIST") throw error;
      writeFileSync(path, text, { mode: 0o600, flag: "wx" });
    } finally {
      rmSync(temp, { force: true });
    }
  },
  read(path, nowMs) {
    try {
      const text = readFileSync(path, "utf8");
      const ageMs = Math.max(0, nowMs - statSync(path).mtimeMs);
      return { text, ageMs };
    } catch (error) {
      if (code(error) === "ENOENT") return null;
      throw error;
    }
  },
  rename: (from, to) => renameSync(from, to),
  restore: (from, to) => linkSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

export type Claim =
  | { readonly kind: "claimed"; release(): void }
  | { readonly kind: "held"; readonly owner: Owner | null; readonly why: string };

/**
 * Takes the database for `me`, or says who has it. A stale file is first renamed to a name of this
 * claim's own, so of two starts that both found it stale only one moves it; if what was moved is
 * not the file that was judged (another start took it in between), it is put back.
 */
export function claimDatabase(o: {
  readonly path: string;
  readonly me: Owner;
  readonly fs: OwnerFs;
  readonly judge: (owner: Owner | null, fileAgeMs: number) => Verdict;
  readonly nowMs: () => number;
}): Claim {
  const { path, me, fs } = o;
  const text = JSON.stringify(me);
  const aside = `${path}.stale-${me.token}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.create(path, text);
      let released = false;
      return {
        kind: "claimed",
        release() {
          if (released) return;
          released = true;
          // Only our own file: never one a later start wrote after judging ours stale.
          if (fs.read(path, o.nowMs())?.text === text) fs.remove(path);
        },
      };
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const found = fs.read(path, o.nowMs());
    if (!found) continue;
    const verdict = o.judge(parseOwner(found.text), found.ageMs);
    if (verdict.kind === "held") return verdict;
    try {
      fs.rename(path, aside);
    } catch (error) {
      if (code(error) === "ENOENT") continue;
      throw error;
    }
    const moved = fs.read(aside, o.nowMs());
    if (moved && moved.text !== found.text) {
      try {
        fs.restore(aside, path);
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
    }
    fs.remove(aside);
  }
  return { kind: "held", owner: null, why: "the owner file kept changing" };
}

/** This machine's processes, read the way `ownerVerdict` needs them. */
export function nodeProcessFacts(o: {
  readonly pid: number;
  readonly host: string;
  readonly nowMs: number;
  readonly uptimeS: number;
  readonly platform: NodeJS.Platform;
}): ProcessFacts {
  return {
    pid: o.pid,
    host: o.host,
    nowMs: o.nowMs,
    bootedAtMs: o.nowMs - o.uptimeS * 1000,
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return code(error) === "EPERM";
      }
    },
    startedAtMs(pid) {
      if (o.platform !== "darwin" && o.platform !== "linux") return null;
      try {
        const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
          encoding: "utf8",
          env: { PATH: "/bin:/usr/bin", LC_ALL: "C" },
          timeout: 2_000,
        });
        const elapsed = parseElapsed(out);
        return elapsed === null ? null : o.nowMs - elapsed * 1000;
      } catch {
        return null;
      }
    },
  };
}

/** The part of a window the second start touches. */
export interface ForwardWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * A second start on this data folder brings the mail window forward. Before the window's first
 * reveal it does nothing: the window shows itself when the mail is in it (ADR 0103). What the second
 * start was given (its argv, its working directory) is not read: the app opens no files or links
 * from the command line.
 */
export function bringForward(
  win: ForwardWindow | null,
  revealed: boolean,
  activate: () => void,
): boolean {
  if (!win || win.isDestroyed() || !revealed) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  activate();
  win.focus();
  return true;
}
