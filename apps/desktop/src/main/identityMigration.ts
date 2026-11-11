// The app identity moves from the old name to Matters (ADR 0105): the userData folder is copied
// to the new one and the saved passwords are encrypted again under the new Keychain item. This
// file holds the decisions and the order of the steps; the file system, the probe for a running
// old app and the decryption under the old name come in from outside, so every step is testable.
//
// The old folder is the backup: nothing in here writes to it, renames in it or deletes from it.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Credential } from "@matters/core";
import { OWNER_SUFFIX } from "./instanceLock.ts";

/** The name Electron derived the old identity from (the desktop package's earlier name). */
export const OLD_APP_NAME = "@unclosed/desktop";
export const OLD_DATABASE = "unclosed.db";
export const DATABASE = "matters.db";
export const CREDENTIALS = "credentials.json";
/**
 * The old vault inside the new folder, still encrypted with the old Keychain item's key. It never
 * sits under the name the credential store reads, so a step that failed can never look like "no
 * passwords saved".
 */
export const STAGED_CREDENTIALS = "credentials.unclosed.json";
/** The state of the move, in the new folder. Its absence means the move was never decided. */
export const MARKER = "identity-migration.json";
/** The copy is built here, next to the new folder, and renamed into place once complete. */
export const STAGING_SUFFIX = ".migrating";
/** Leftovers of a start that never got going go to `<new folder>.set-aside-<time>`, never away. */
export const SET_ASIDE_INFIX = ".set-aside-";

/** The files that make a folder a mailbox: a database or saved passwords. */
export function holdsMailbox(name: string): boolean {
  return (
    name === DATABASE ||
    name.startsWith(`${DATABASE}-`) ||
    name === CREDENTIALS ||
    name === STAGED_CREDENTIALS
  );
}

/**
 * Entries directly under the old folder that Chromium or the app rebuild on their own: caches,
 * locks and what lives for one session only. Everything else is copied, including what we cannot
 * prove to be regenerable.
 */
const REGENERABLE = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GPUPersistentCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "GrShaderCache",
  "Shared Dictionary",
  // The backend's Node compile cache (index.ts, NODE_COMPILE_CACHE).
  "compile-cache",
  // Blobs and sessionStorage belong to one session of the page.
  "blob_storage",
  "Session Storage",
  // Process locks of the old app; a copied lock would claim a process that is not there.
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
]);

/** Whether a top-level entry of the old folder stays behind. */
export function staysBehind(name: string): boolean {
  return (
    REGENERABLE.has(name) ||
    name === MARKER ||
    name === ".DS_Store" ||
    // The database's owner file (ADR 0110) names a process of the old folder's run.
    name.endsWith(OWNER_SUFFIX)
  );
}

/**
 * The single-instance lock this very start took in the new folder before the move (ADR 0110). It is
 * not debris: it travels into the copy, so the folder that ends up in place is still locked.
 */
const THIS_RUNS_LOCK = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);
export const isThisRunsLock = (name: string) => THIS_RUNS_LOCK.has(name);

/** The database files are renamed on the way, the three of them together; so is the vault. */
export function copiedName(name: string): string {
  if (name === CREDENTIALS) return STAGED_CREDENTIALS;
  if (name === OLD_DATABASE || name.startsWith(`${OLD_DATABASE}-`)) {
    return DATABASE + name.slice(OLD_DATABASE.length);
  }
  return name;
}

export type MarkerState =
  /** No old data was found: nothing to move, now or later. */
  | "fresh"
  /** The new folder already held data: nothing was copied over it. */
  | "kept-existing"
  /** The data is in place; the passwords still wait to be encrypted under the new item. */
  | "credentials-pending"
  | "done";

export interface Marker {
  readonly version: 1;
  readonly state: MarkerState;
  readonly from: string;
  readonly at: string;
}

const STATES: readonly MarkerState[] = ["fresh", "kept-existing", "credentials-pending", "done"];

export function parseMarker(text: string): Marker | null {
  try {
    const v = JSON.parse(text) as Partial<Marker> | null;
    if (
      v?.version === 1 &&
      STATES.includes(v.state as MarkerState) &&
      typeof v.from === "string" &&
      typeof v.at === "string"
    ) {
      return v as Marker;
    }
  } catch {}
  return null;
}

export interface Entry {
  readonly kind: "file" | "dir" | "symlink" | "other";
  readonly size: number;
  readonly mtimeMs: number;
}

/** The file system as the move sees it; synchronous, because the data step runs before ready. */
export interface MigrationFs {
  /** Links are not followed; null when nothing is there. */
  entry(path: string): Entry | null;
  list(dir: string): string[];
  mkdir(path: string): void;
  /** A clone where the volume can (APFS), a real copy elsewhere; never over an existing file. */
  copyFile(from: string, to: string): void;
  copyLink(from: string, to: string): void;
  rename(from: string, to: string): void;
  /** Removes an empty directory, and only an empty one. */
  removeEmptyDir(path: string): void;
  /** Only ever called on paths the move itself made (the staging copy, the staged vault). */
  remove(path: string): void;
  readText(path: string): string | null;
  /** Temp file, fsync, rename. */
  writeTextAtomic(path: string, text: string): void;
  /** Flushes a directory's entries; best effort where the platform cannot. */
  syncDir(path: string): void;
}

function flush(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const nodeFs: MigrationFs = {
  entry(path) {
    try {
      const s = lstatSync(path);
      const kind = s.isFile()
        ? "file"
        : s.isDirectory()
          ? "dir"
          : s.isSymbolicLink()
            ? "symlink"
            : "other";
      return { kind, size: s.size, mtimeMs: s.mtimeMs };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  },
  list: (dir) => readdirSync(dir),
  mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  copyFile(from, to) {
    copyFileSync(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    // The copy must be on disk before the folder that holds it is renamed into place.
    flush(to);
  },
  copyLink: (from, to) => symlinkSync(readlinkSync(from), to),
  rename: (from, to) => renameSync(from, to),
  removeEmptyDir: (path) => rmdirSync(path),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  },
  writeTextAtomic(path, text) {
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
      flush(temp);
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  },
  syncDir(path) {
    try {
      flush(path);
    } catch {
      // Windows cannot open a directory for fsync; its rename is durable enough.
    }
  },
};

/** Whether another process holds the old database open: the old app still running. */
export type RunningProbe = (
  files: readonly string[],
) =>
  | { readonly state: "running"; readonly pids: readonly number[] }
  | { readonly state: "free" }
  | { readonly state: "unknown"; readonly reason: string };

/** Where the move reads from and writes to, or null: this run does not move anything. */
export interface IdentityPlan {
  readonly oldDir: string;
  readonly newDir: string;
}

/**
 * A run with its own data (MATTERS_USER_DATA or MATTERS_DB_PATH: dev, smoke, tests) behaves as
 * before and never looks at the real old folder. Only a dev build may point the move at an old
 * folder of its own (MATTERS_OLD_USER_DATA), and only together with a new folder of its own.
 */
export function identityPlan(o: {
  readonly devBuild: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appData: string;
  /** Where userData is for this run, after any override. */
  readonly userData: string;
}): IdentityPlan | null {
  if (o.env.MATTERS_DB_PATH) return null;
  const ownUserData = o.devBuild && !!o.env.MATTERS_USER_DATA;
  const ownOld = o.devBuild ? o.env.MATTERS_OLD_USER_DATA : undefined;
  if (ownOld)
    return ownUserData && ownOld !== o.userData ? { oldDir: ownOld, newDir: o.userData } : null;
  if (ownUserData) return null;
  const oldDir = join(o.appData, OLD_APP_NAME);
  return oldDir === o.userData ? null : { oldDir, newDir: o.userData };
}

export type DataOutcome =
  /** Nothing to do now: the marker says so, or there was nothing old to move. */
  | { readonly kind: "settled"; readonly state: MarkerState }
  /** Just copied; `state` says whether the passwords still have to follow. */
  | {
      readonly kind: "copied";
      readonly state: "credentials-pending" | "done";
      readonly files: number;
      readonly bytes: number;
      /** Where the leftovers of an earlier start that never got going were put, if there were any. */
      readonly setAside?: string;
    }
  /** The new folder already had data; nothing was copied (reported once). */
  | { readonly kind: "kept-existing" }
  /** Not now; nothing changed and the next start tries again. */
  | { readonly kind: "refused"; readonly reason: "running" | "changed"; readonly detail: string }
  | { readonly kind: "failed"; readonly message: string };

export interface DataStep extends IdentityPlan {
  readonly fs: MigrationFs;
  readonly probe: RunningProbe;
  readonly now: () => Date;
}

const markerText = (state: MarkerState, from: string, now: Date) =>
  JSON.stringify({ version: 1, state, from, at: now.toISOString() } satisfies Marker);

/** The marker in `dir`, "absent", or "unreadable" (which stops the move: we do not guess). */
export function readMarker(fs: MigrationFs, dir: string): Marker | "absent" | "unreadable" {
  const text = fs.readText(join(dir, MARKER));
  if (text === null) return "absent";
  return parseMarker(text) ?? "unreadable";
}

/** The files that tell whether the old app has its database open, and whether it wrote. */
function watchedFiles(fs: MigrationFs, oldDir: string): string[] {
  return fs
    .list(oldDir)
    .filter((n) => n === CREDENTIALS || n === OLD_DATABASE || n.startsWith(`${OLD_DATABASE}-`))
    .map((n) => join(oldDir, n))
    .filter((p) => fs.entry(p)?.kind === "file");
}

const fingerprint = (fs: MigrationFs, files: readonly string[]) =>
  files
    .map((p) => {
      const e = fs.entry(p);
      return `${p}:${e?.size ?? -1}:${e?.mtimeMs ?? -1}`;
    })
    .join("\n");

/** Copies a tree that the move made itself; the top level is filtered and renamed by the caller. */
function copyTree(
  fs: MigrationFs,
  from: string,
  to: string,
  stats: { files: number; bytes: number },
) {
  const entry = fs.entry(from);
  if (!entry) return;
  if (entry.kind === "dir") {
    fs.mkdir(to);
    for (const name of fs.list(from)) copyTree(fs, join(from, name), join(to, name), stats);
  } else if (entry.kind === "file") {
    fs.copyFile(from, to);
    stats.files++;
    stats.bytes += entry.size;
  } else if (entry.kind === "symlink") {
    fs.copyLink(from, to);
  }
  // Sockets and pipes belong to a running process; they are not data.
}

/**
 * Step one, before Electron is ready (Chromium must not create its own files in an empty new folder
 * first). It never throws: every outcome says what happened, and a crash at any point leaves either
 * no new folder (the staging copy is thrown away on the next start) or a complete one with its
 * marker, because the marker is written into the staging copy before the one rename that
 * publishes it.
 */
export function moveIdentityData(step: DataStep): DataOutcome {
  const { fs, oldDir, newDir } = step;
  const staging = newDir + STAGING_SUFFIX;
  // This run's lock entries while they wait in the copy; a failure puts them back.
  const carried: string[] = [];
  try {
    const marker = readMarker(fs, newDir);
    if (marker === "unreadable") {
      return { kind: "failed", message: `the move's marker ${join(newDir, MARKER)} is damaged` };
    }
    if (marker !== "absent") return { kind: "settled", state: marker.state };

    // A copy a crash left behind is ours and incomplete: it goes, and the copy starts over.
    if (fs.entry(staging)) fs.remove(staging);

    const old = fs.entry(oldDir)?.kind === "dir" ? watchedFiles(fs, oldDir) : [];
    const hasOldData = old.some((p) => p.endsWith(OLD_DATABASE) || p.endsWith(CREDENTIALS));
    const newEntries = fs.entry(newDir)?.kind === "dir" ? fs.list(newDir) : [];
    // Only a mailbox counts as data. Anything else in a folder without a marker is what an earlier
    // start left when it never got going (a refusal, a crash, a quit during the copy).
    const newHasData = newEntries.some(holdsMailbox);
    const debris = newEntries.some((n) => n !== ".DS_Store" && !isThisRunsLock(n));

    if (!hasOldData) {
      fs.mkdir(newDir);
      fs.writeTextAtomic(join(newDir, MARKER), markerText("fresh", oldDir, step.now()));
      return { kind: "settled", state: "fresh" };
    }
    if (newHasData) {
      // Somebody's data either way: neither folder is overwritten, and this is said once.
      fs.writeTextAtomic(join(newDir, MARKER), markerText("kept-existing", oldDir, step.now()));
      return { kind: "kept-existing" };
    }

    const running = step.probe(old.filter((p) => !p.endsWith(CREDENTIALS)));
    if (running.state === "running") {
      return { kind: "refused", reason: "running", detail: `process ${running.pids.join(", ")}` };
    }
    const before = fingerprint(fs, old);

    fs.mkdir(staging);
    const stats = { files: 0, bytes: 0 };
    let hasCredentials = false;
    for (const name of fs.list(oldDir)) {
      if (staysBehind(name)) continue;
      const target = copiedName(name);
      if (target === STAGED_CREDENTIALS && fs.entry(join(oldDir, name))?.kind === "file") {
        hasCredentials = true;
      }
      copyTree(fs, join(oldDir, name), join(staging, target), stats);
    }

    // The old app may have started, or written, while we copied: then this copy is not a snapshot.
    const again = step.probe(old.filter((p) => !p.endsWith(CREDENTIALS)));
    if (fingerprint(fs, old) !== before || again.state === "running") {
      fs.remove(staging);
      return {
        kind: "refused",
        reason: again.state === "running" ? "running" : "changed",
        detail: "the old data changed while it was being copied",
      };
    }

    const state = hasCredentials ? "credentials-pending" : "done";
    fs.writeTextAtomic(join(staging, MARKER), markerText(state, oldDir, step.now()));
    fs.syncDir(staging);
    // `app.getPath("userData")` made an empty folder already; a rename can only replace an empty one.
    // Leftovers of an earlier start are not deleted but put aside, only now that the copy is
    // complete: a refusal or a failure above leaves them exactly as they were.
    let setAside: string | undefined;
    for (const name of newEntries.filter(isThisRunsLock)) {
      fs.rename(join(newDir, name), join(staging, name));
      carried.push(name);
    }
    if (fs.entry(newDir)) {
      if (debris) {
        setAside = `${newDir}${SET_ASIDE_INFIX}${step.now().toISOString().replace(/[:.]/g, "-")}`;
        fs.rename(newDir, setAside);
      } else {
        if (fs.entry(join(newDir, ".DS_Store"))) fs.remove(join(newDir, ".DS_Store"));
        fs.removeEmptyDir(newDir);
      }
    }
    fs.rename(staging, newDir);
    return { kind: "copied", state, ...stats, ...(setAside ? { setAside } : {}) };
  } catch (error) {
    for (const name of carried) {
      try {
        if (fs.entry(newDir)?.kind === "dir" && !fs.entry(join(newDir, name))) {
          fs.rename(join(staging, name), join(newDir, name));
        }
      } catch {}
    }
    try {
      if (fs.entry(staging)) fs.remove(staging);
    } catch {}
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** What the helper hands back for each account: the decrypted JSON, or null if it could not. */
export type OldPlainVault = Readonly<Record<string, string | null>>;

export interface CredentialsStep {
  readonly newDir: string;
  readonly fs: MigrationFs;
  /** Decrypts the staged vault under the old identity, in a helper process; values stay in memory. */
  readonly readOld: (stagedPath: string, accountIds: readonly string[]) => Promise<OldPlainVault>;
  /** Encrypts under the new identity and writes `credentials.json` in one atomic replace. */
  readonly replaceAll: (credentials: Readonly<Record<string, Credential>>) => Promise<void>;
  readonly readBack: (accountId: string) => Promise<Credential | null>;
  readonly parse: (value: unknown) => Credential | null;
  readonly now: () => Date;
}

export type CredentialsOutcome =
  | { readonly kind: "done"; readonly moved: number; readonly dropped: number }
  | { readonly kind: "failed"; readonly message: string };

function same(a: Credential | null, b: Credential): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Step two, after ready and before the credential store is first used. Idempotent: until the marker
 * says "done" it can run again from the start, and writes the same file again. A password the old
 * app could not decrypt either is dropped (it would have been asked for again); when none of them
 * can be read, nothing is written and the step fails, because that is the old Keychain item refusing.
 */
export async function moveIdentityCredentials(step: CredentialsStep): Promise<CredentialsOutcome> {
  const { fs, newDir } = step;
  const staged = join(newDir, STAGED_CREDENTIALS);
  try {
    const marker = readMarker(fs, newDir);
    if (marker === "absent" || marker === "unreadable" || marker.state !== "credentials-pending") {
      return {
        kind: "failed",
        message: "the move's marker does not say the passwords are pending",
      };
    }
    const text = fs.readText(staged);
    if (text === null) return { kind: "failed", message: `${STAGED_CREDENTIALS} is missing` };
    const vault = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (vault?.version !== 1 || typeof vault.entries !== "object" || vault.entries === null) {
      return { kind: "failed", message: `${STAGED_CREDENTIALS} is not a credentials file` };
    }
    const ids = Object.keys(vault.entries);
    const plain = ids.length === 0 ? {} : await step.readOld(staged, ids);
    const credentials: Record<string, Credential> = {};
    for (const id of ids) {
      const raw = plain[id];
      if (typeof raw !== "string") continue;
      let parsed: Credential | null = null;
      try {
        parsed = step.parse(JSON.parse(raw));
      } catch {}
      if (parsed) credentials[id] = parsed;
    }
    const moved = Object.keys(credentials).length;
    if (ids.length > 0 && moved === 0) {
      return {
        kind: "failed",
        message: `none of the ${ids.length} saved passwords could be decrypted under the old name`,
      };
    }
    await step.replaceAll(credentials);
    for (const [id, credential] of Object.entries(credentials)) {
      if (!same(await step.readBack(id), credential)) {
        return { kind: "failed", message: "a password did not read back after it was saved again" };
      }
    }
    fs.writeTextAtomic(join(newDir, MARKER), markerText("done", marker.from, step.now()));
    // Our own copy, encrypted with the old key; the original stays in the old folder.
    fs.remove(staged);
    return { kind: "done", moved, dropped: ids.length - moved };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
