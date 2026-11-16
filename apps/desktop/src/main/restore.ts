// Restoring from a backup (ADR 0145, rules 8 and 9): where main keeps a restore and how the swap
// runs at the next start. Everything lives in one folder beside the database, `restore/`, on the
// database's own disk, so every step of the swap is a rename:
//
//   restore/pending.db       a checked backup, carried to this build's version, waiting
//   restore/pending.json     what the swap needs: the set-aside folder's name, accounts to hold
//   restore/incoming-*.db    a chosen file being checked; never swapped in under that name
//   restore/held.json        accounts whose password or sign-in this Mac does not use for now
//   restore/set-aside/<time>/<database>(-wal, -shm, -journal)   a database the swap set aside
//
// The swap runs before the backend, inside the single-instance lock and the database's claim (ADR
// 0110), with no connection open. A start with no restore pending pays one `stat`.
import { randomUUID } from "node:crypto";
import {
  type Dirent,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PendingRestoreInfo, SetAsideInfo } from "@matters/contracts";
import { setAsideName, setAsideTime } from "@matters/core";

export type { SetAsideInfo } from "@matters/contracts";

export const RESTORE_FOLDER = "restore";
/** The files SQLite keeps beside a database, moved with it as one set. */
const SET_SUFFIXES = ["-wal", "-shm", "-journal", ""] as const;

export interface RestorePaths {
  readonly dir: string;
  readonly pending: string;
  readonly notes: string;
  readonly held: string;
  readonly setAside: string;
}

export function restorePaths(databasePath: string): RestorePaths {
  const dir = join(dirname(databasePath), RESTORE_FOLDER);
  return {
    dir,
    pending: join(dir, "pending.db"),
    notes: join(dir, "pending.json"),
    held: join(dir, "held.json"),
    setAside: join(dir, "set-aside"),
  };
}

/**
 * What the swap needs to know, written before the pending database takes its name. The set-aside
 * folder is chosen once, so a swap broken off continues into the same folder.
 */
export type PendingNotes = PendingRestoreInfo;

export function readPendingNotes(text: string): PendingNotes | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const n = (raw ?? {}) as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (
    n.version !== 1 ||
    typeof n.setAside !== "string" ||
    setAsideTime(n.setAside) === null ||
    !Array.isArray(n.holdAccounts) ||
    !n.holdAccounts.every((id) => typeof id === "string" && id.length <= 200) ||
    !count(n.preparedAtMs) ||
    !count(n.messages) ||
    !count(n.accounts) ||
    !count(n.heldSends)
  ) {
    return null;
  }
  return n as unknown as PendingNotes;
}

/** The held accounts' ids from `held.json`; nothing when there is no file or it is not a list. */
export function readHeld(text: string | null): string[] {
  if (text === null) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The file system the swap uses, synchronous: it runs before the app is ready. */
export interface SwapFs {
  exists(path: string): boolean;
  read(path: string): string | null;
  /** Written aside and renamed into place, so it is never seen half written. */
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
}

export const nodeSwapFs: SwapFs = {
  exists(path) {
    try {
      statSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  write(path, text) {
    const temp = `${path}.${randomUUID()}`;
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  },
  rename: (from, to) => renameSync(from, to),
  mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  remove: (path) => rmSync(path, { force: true }),
};

export type SwapOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "swapped"; readonly setAside: string; readonly held: readonly string[] }
  /** The swap could not run; what it had moved was put back, and the restore still waits. */
  | { readonly kind: "failed"; readonly message: string };

/**
 * The swap at start (ADR 0145, rule 9). With no `pending.db` it costs one `stat` and does
 * nothing. Otherwise, in this order, each step repeatable, so a start that breaks off is
 * continued by the next: the accounts to hold are added to `held.json` (before the database they
 * belong to is in place); the database's set (its log, its shared memory, a rollback journal, then
 * the file) is moved into the set-aside folder, never one without the others beside a database
 * they do not belong to; the pending database takes the database's name; the notes go. When a
 * step fails, what was moved is put back in the reverse order and `held.json` is as it was: the
 * current database stays, and the restore waits for the next start or for the person.
 */
export function swapPendingRestore(databasePath: string, fs: SwapFs = nodeSwapFs): SwapOutcome {
  const paths = restorePaths(databasePath);
  let pending: boolean;
  try {
    pending = fs.exists(paths.pending);
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }
  if (!pending) return { kind: "none" };
  const notes = readPendingNotes(fs.read(paths.notes) ?? "");
  if (notes === null) return { kind: "failed", message: "the restore's notes could not be read" };

  const asideDir = join(paths.setAside, notes.setAside);
  const base = basename(databasePath);
  const heldBefore = fs.read(paths.held);
  const moved: [string, string][] = [];
  try {
    const held = [...new Set([...readHeld(heldBefore), ...notes.holdAccounts])];
    if (notes.holdAccounts.length > 0) fs.write(paths.held, JSON.stringify(held));
    fs.mkdir(asideDir);
    for (const suffix of SET_SUFFIXES) {
      const from = `${databasePath}${suffix}`;
      const to = join(asideDir, `${base}${suffix}`);
      if (!fs.exists(from)) continue;
      // A set-aside file of that name is from this very swap, broken off; it is never replaced.
      if (fs.exists(to)) throw new Error(`${to} is there already`);
      fs.rename(from, to);
      moved.push([from, to]);
    }
    fs.rename(paths.pending, databasePath);
    moved.push([paths.pending, databasePath]);
    fs.remove(paths.notes);
    return { kind: "swapped", setAside: notes.setAside, held };
  } catch (error) {
    for (const [from, to] of moved.reverse()) {
      try {
        fs.rename(to, from);
      } catch {
        // Left where it is: the next start sees the restore still pending and tries again.
      }
    }
    try {
      if (heldBefore === null) fs.remove(paths.held);
      else fs.write(paths.held, heldBefore);
    } catch {}
    return { kind: "failed", message: messageOf(error) };
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The set-aside databases, newest first; a folder that is not one of ours is not listed. */
export async function listSetAside(databasePath: string): Promise<SetAsideInfo[]> {
  const root = restorePaths(databasePath).setAside;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SetAsideInfo[] = [];
  for (const entry of entries) {
    const atMs = setAsideTime(entry.name);
    if (!entry.isDirectory() || atMs === null) continue;
    let bytes = 0;
    for (const suffix of SET_SUFFIXES) {
      try {
        const info = await lstat(join(root, entry.name, `${basename(databasePath)}${suffix}`));
        if (info.isFile()) bytes += info.size;
      } catch {}
    }
    out.push({ name: entry.name, atMs, bytes });
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/** The path of a set-aside database by its folder's name, or null for a name not of ours. */
export function setAsidePath(databasePath: string, name: unknown): string | null {
  if (typeof name !== "string" || setAsideTime(name) === null) return null;
  return join(restorePaths(databasePath).setAside, name, basename(databasePath));
}

/** Removes one set-aside database, its folder whole; only a name of ours. */
export async function removeSetAside(databasePath: string, name: unknown): Promise<boolean> {
  const path = setAsidePath(databasePath, name);
  if (path === null) return false;
  await rm(dirname(path), { recursive: true, force: true });
  return true;
}

/** The restore waiting for the next start, as Settings › Storage shows it; null when none. */
export async function readPending(databasePath: string): Promise<PendingNotes | null> {
  const paths = restorePaths(databasePath);
  try {
    await lstat(paths.pending);
  } catch {
    return null;
  }
  try {
    return readPendingNotes(await readFile(paths.notes, "utf8"));
  } catch {
    return null;
  }
}

/** Takes the waiting restore back: its database and notes go, nothing else is touched. */
export async function cancelPending(databasePath: string): Promise<void> {
  const paths = restorePaths(databasePath);
  await rm(paths.pending, { force: true });
  await rm(paths.notes, { force: true });
}

/** Leftovers of a check that broke off (a quit, a crash): `incoming-*` files only. */
export async function sweepIncoming(databasePath: string): Promise<void> {
  const { dir } = restorePaths(databasePath);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^incoming-[0-9a-f-]+\.db(-journal|-wal|-shm)?$/.test(name))
      await rm(join(dir, name), { force: true });
  }
}

/** Makes a checked, prepared copy the restore that waits: notes first, then the name. */
export async function makePending(
  databasePath: string,
  incoming: string,
  notes: Omit<PendingNotes, "version" | "setAside">,
  nowMs: number,
): Promise<PendingNotes> {
  const paths = restorePaths(databasePath);
  const full: PendingNotes = { version: 1, setAside: setAsideName(nowMs), ...notes };
  const temp = `${paths.notes}.${randomUUID()}`;
  await writeFile(temp, JSON.stringify(full), { mode: 0o600, flag: "wx" });
  await rename(temp, paths.notes);
  await rename(incoming, paths.pending);
  return full;
}

/** The held accounts, read when first asked and kept in step after (rule 9). */
export async function readHeldFile(databasePath: string): Promise<string[]> {
  try {
    return readHeld(await readFile(restorePaths(databasePath).held, "utf8"));
  } catch {
    return [];
  }
}

export async function writeHeldFile(databasePath: string, ids: readonly string[]): Promise<void> {
  const { held } = restorePaths(databasePath);
  if (ids.length === 0) {
    await rm(held, { force: true });
    return;
  }
  const temp = `${held}.${randomUUID()}`;
  await writeFile(temp, JSON.stringify(ids), { mode: 0o600, flag: "wx" });
  await rename(temp, held);
}
