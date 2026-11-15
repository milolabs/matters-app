// Erase everything (ADR 0138, rules 3, 4, 7 and 11). Confirming writes an order to the data
// folder and restarts; the next start finds it before anything opens a file and erases, step by
// step, from a throwaway data folder of its own. Every step is a delete that can run again, and
// while the order is there every start continues it.
//
// The decisions live here with the file system and the key store passed in, so tests run them on
// temporary folders and a fake key store. Nothing in here deletes a path outside what the guard
// allows: the data folder, the database's own files, the app's temp prefixes in the temp
// directory, and the earlier identity's folder.
import { randomBytes } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  type EraseResult,
  erasePlan,
  type Holding,
  type HoldingOutcome,
  isPermissionPageId,
  type LeftReason,
  type PermissionPageId,
} from "@matters/core";
import { ERASE_ORDER_FILE } from "./holdings.ts";
import { OWNER_SUFFIX } from "./instanceLock.ts";

/** Nothing is there: the only errors a look may read as "absent". Any other is a doubt. */
const missing = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

// ---------------------------------------------------------------------------------------------
// The order

export interface EraseOrder {
  readonly version: 1;
  /** When the person confirmed, ISO 8601. */
  readonly at: string;
  /** Whether the earlier identity's folder and key go too (rule 4). */
  readonly earlierCopy: boolean;
  /**
   * The providers' pages the result links to (rule 8), by name: the database is not opened during
   * an erase, so the review says which accounts signed in through a provider. No address.
   */
  readonly permissionPages: readonly PermissionPageId[];
}

export function parseEraseOrder(text: string): EraseOrder | null {
  try {
    const v = JSON.parse(text) as Partial<EraseOrder> | null;
    if (v?.version === 1 && typeof v.at === "string" && typeof v.earlierCopy === "boolean") {
      const pages = Array.isArray(v.permissionPages)
        ? v.permissionPages.filter(isPermissionPageId)
        : [];
      return { version: 1, at: v.at, earlierCopy: v.earlierCopy, permissionPages: pages };
    }
  } catch {}
  return null;
}

/** What the start found where the order would be: three cases, never confused with each other. */
export type EraseOrderRead =
  /** Nothing there (ENOENT, ENOTDIR): a normal start. */
  | { readonly kind: "none" }
  /** An order was read: this start erases. */
  | { readonly kind: "order"; readonly order: EraseOrder }
  /**
   * Whether an order is there could not be told (EACCES, EIO, ...): neither a normal start nor an
   * erase. `code` is the system's code, when it gave one.
   */
  | { readonly kind: "unreadable"; readonly code: string | null };

/**
 * The one look a normal start pays for (ADR 0138, Consequences): a read that fails with ENOENT. An
 * order that is there but cannot be parsed still counts: the file is there, so the person
 * confirmed, and the erase goes on without the earlier copy, the safe default. A read that fails
 * otherwise proves nothing either way: it is "unreadable", and nothing starts and nothing is
 * deleted.
 */
export function readEraseOrder(
  dataDir: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): EraseOrderRead {
  let text: string;
  try {
    text = read(join(dataDir, ERASE_ORDER_FILE));
  } catch (error) {
    if (missing(error)) return { kind: "none" };
    const code = (error as { code?: unknown } | null)?.code;
    return { kind: "unreadable", code: typeof code === "string" ? code : null };
  }
  return {
    kind: "order",
    order: parseEraseOrder(text) ?? {
      version: 1,
      at: new Date(0).toISOString(),
      earlierCopy: false,
      permissionPages: [],
    },
  };
}

/**
 * What a start does with what it read: each case has its own way, so an order that could not be
 * read is never taken for one that was (ADR 0138, Notes after review).
 */
export function startFor<T>(
  read: EraseOrderRead,
  on: {
    readonly none: () => T;
    readonly order: (order: EraseOrder) => T;
    readonly unreadable: (code: string | null) => T;
  },
): T {
  switch (read.kind) {
    case "none":
      return on.none();
    case "order":
      return on.order(read.order);
    case "unreadable":
      return on.unreadable(read.code);
  }
}

/** Written aside, then renamed into place: a half-written order is never read. */
export function writeEraseOrder(dataDir: string, order: EraseOrder): void {
  const path = join(dataDir, ERASE_ORDER_FILE);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(order), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/** The order goes away without erasing: "Leave them and start again" (rule 11). */
export function dropEraseOrder(dataDir: string): void {
  rmSync(join(dataDir, ERASE_ORDER_FILE), { force: true });
}

// ---------------------------------------------------------------------------------------------
// The guard

export interface EraseRoots {
  /** Folders whose contents, and which themselves, may be deleted: the data folder, the earlier copy. */
  readonly folders: readonly string[];
  /** Single files that may be deleted: the database's own files when it lies elsewhere. */
  readonly files: readonly string[];
  /** The temp directory, where only names with one of `tempPrefixes` may go. */
  readonly tempDir: string;
  readonly tempPrefixes: readonly string[];
}

/** The real path of the deepest part of `path` that exists, with the rest appended. */
function realOf(path: string, real: (p: string) => string): string {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const r = real(head);
      return tail.length === 0 ? r : join(r, ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Where a delete of `path` lands, as the guard sees it: every link on the way followed, the last
 * part not (deleting a link removes the link).
 */
function targetOf(path: string, real: (p: string) => string): string {
  const absolute = resolve(path);
  return join(realOf(dirname(absolute), real), basename(absolute));
}

const inside = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/**
 * Whether the erase may delete `path`. `..` is resolved and every link on the way is followed
 * (except the last part, which `rm` removes as a link and never follows), so a link that leads
 * out of the data folder does not take the erase with it. A root of `/` or the home folder
 * itself is never accepted.
 */
export function eraseGuard(
  roots: EraseRoots,
  real: (p: string) => string = realpathSync,
  home?: string,
): (path: string) => boolean {
  const forbidden = new Set([resolve("/"), ...(home ? [realOf(home, real)] : [])]);
  const usable = (p: string) => p !== "" && !forbidden.has(p);
  const folders = roots.folders.map((f) => realOf(f, real)).filter(usable);
  const files = roots.files.map((f) => realOf(f, real)).filter(usable);
  const tempDir = realOf(roots.tempDir, real);
  return (path: string) => {
    if (path === "") return false;
    // The last part is not followed: deleting a link removes the link.
    const target = targetOf(path, real);
    if (forbidden.has(target)) return false;
    if (files.includes(target)) return true;
    if (folders.some((f) => inside(target, f))) return true;
    return (
      usable(tempDir) &&
      dirname(target) === tempDir &&
      roots.tempPrefixes.some((p) => p !== "" && basename(target).startsWith(p))
    );
  };
}

// ---------------------------------------------------------------------------------------------
// The ports

export interface EraseFs {
  /**
   * Kind and size of an entry, links not followed; null when nothing is there. Throws when it
   * cannot be looked at (EACCES, EIO): that is never "nothing there".
   */
  entry(
    path: string,
  ): { readonly kind: "file" | "dir" | "link" | "other"; readonly size: number } | null;
  /** Names in a folder; [] when there is no folder. Throws when it cannot be read. */
  list(dir: string): readonly string[];
  /** Bytes under a path, links not followed. */
  size(path: string): number;
  /** Removes a file, a link or a whole folder; throws with the system's code when it cannot. */
  remove(path: string): void;
  /**
   * Removes a folder only if it is empty, in one step: it throws (ENOTEMPTY) when something was
   * written into it since it was last looked at, so that is never taken with the folder.
   */
  removeEmptyDir(path: string): void;
  /** Writes a small file in one step. */
  writeAtomic(path: string, text: string): void;
}

function sizeOfSync(path: string): number {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) total += sizeOfSync(join(path, e.name));
  return total;
}

export const nodeEraseFs: EraseFs = {
  entry(path) {
    try {
      const s = lstatSync(path);
      return {
        kind: s.isFile() ? "file" : s.isDirectory() ? "dir" : s.isSymbolicLink() ? "link" : "other",
        size: s.size,
      };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  },
  size: sizeOfSync,
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 2 }),
  removeEmptyDir: (path) => rmdirSync(path),
  writeAtomic(path, text) {
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  },
};

/** The system's key store, as the erase sees it (rule 7). */
export interface KeychainPort {
  /** Deletes every item of the service. */
  remove(service: string): Promise<"deleted" | "absent" | "refused" | "unsupported">;
  /** Whether an item of the service is still there; null when this cannot be asked. */
  exists(service: string): Promise<boolean | null>;
}

export type RunTool = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly code: number | null }>;

/** `security` says 44 when no item matches. */
const SECURITY_NOT_FOUND = 44;
/** A service with more items than this is reported, never deleted in a loop (rule 7). */
const MAX_ITEMS = 4;

/** macOS: `/usr/bin/security delete-generic-password` for the service (rule 7). */
export function macKeychain(run: RunTool): KeychainPort {
  return {
    async remove(service) {
      let deleted = 0;
      for (let i = 0; i < MAX_ITEMS; i++) {
        const { code } = await run("/usr/bin/security", ["delete-generic-password", "-s", service]);
        if (code === 0) {
          deleted++;
          continue;
        }
        if (code === SECURITY_NOT_FOUND) return deleted > 0 ? "deleted" : "absent";
        return "refused";
      }
      return "refused";
    },
    async exists(service) {
      // Without -g nothing secret is read, and the Keychain asks nothing.
      const { code } = await run("/usr/bin/security", ["find-generic-password", "-s", service]);
      if (code === 0) return true;
      if (code === SECURITY_NOT_FOUND) return false;
      return null;
    },
  };
}

/**
 * Windows keeps the key inside `Local State`, which goes with the folder; Linux keeps it in the
 * keyring, which the erase cannot reach from here and reports with where to find it (rule 7).
 */
export function otherKeychain(platform: NodeJS.Platform): KeychainPort {
  return {
    remove: async () => (platform === "win32" ? "absent" : "unsupported"),
    exists: async () => (platform === "win32" ? false : null),
  };
}

// ---------------------------------------------------------------------------------------------
// The run

export interface EraseTargets {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly tempDir: string;
  /** The earlier identity's folder (ADR 0105); null when this run has none (tests, dev). */
  readonly earlierDir: string | null;
  /** The services of the keys: this identity's, and the earlier one's (or null). */
  readonly keychain: { readonly current: string | null; readonly earlier: string | null };
  /** A folder the erase itself runs in (the throwaway data folder); never deleted by it. */
  readonly ownFolder?: string;
}

/** The database's claim (ADR 0110), taken by the erase before it deletes the database's files. */
export type DatabaseClaim =
  | { readonly kind: "claimed"; release(): void }
  | { readonly kind: "held"; readonly why: string };

export interface EraseDeps {
  readonly fs: EraseFs;
  readonly keychain: KeychainPort;
  readonly guard: (path: string) => boolean;
  readonly now: () => number;
  /**
   * Claims the database through its owner file (ADR 0110). `MATTERS_DB_PATH` can share one
   * database between two data folders, and the other run's lock is not this folder's: a database
   * a live run owns is never deleted under it. Throws ENOENT when its folder is not there.
   */
  readonly claimDatabase?: () => DatabaseClaim;
  /**
   * Real paths, as the guard resolves them; the held owner file is compared through it (defaults
   * to the system's).
   */
  readonly real?: (path: string) => string;
  /** Told before each holding and after it, for the window (rule 11). */
  readonly progress?: (event: EraseProgress) => void;
  /** The "done" marker the identity move reads (ADR 0105), when the earlier copy stays (rule 4). */
  readonly doneMarker?: (
    earlierDir: string,
    atMs: number,
  ) => { readonly name: string; readonly text: string };
}

export type EraseProgress =
  | { readonly kind: "step"; readonly step: string }
  | { readonly kind: "holding"; readonly holding: Holding; readonly outcome: HoldingOutcome };

/** The concrete paths of a holding in this run; [] for a key or one with nothing there. */
export function pathsOf(h: Holding, t: EraseTargets, fs: EraseFs): readonly string[] {
  const p = h.place;
  switch (p.kind) {
    case "data":
      return p.match === "exact"
        ? [join(t.dataDir, p.name)]
        : fs
            .list(t.dataDir)
            .filter((n) => n.startsWith(p.name) && n !== ERASE_ORDER_FILE)
            .map((n) => join(t.dataDir, n));
    case "database":
      return [t.databasePath + p.suffix];
    case "besideDatabase":
      return [join(dirname(t.databasePath), p.name)];
    case "temp":
      return fs
        .list(t.tempDir)
        .filter((n) => n.startsWith(p.prefix))
        .map((n) => join(t.tempDir, n))
        .filter((path) => path !== t.ownFolder);
    case "earlierFolder":
      return t.earlierDir === null ? [] : [t.earlierDir];
    case "keychain":
    case "table":
      return [];
  }
}

const reasonOf = (error: unknown): LeftReason => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EBUSY" || code === "ETXTBSY") return "busy";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "refused";
  return "failed";
};

async function eraseKey(h: Holding, t: EraseTargets, deps: EraseDeps): Promise<HoldingOutcome> {
  const service =
    h.place.kind === "keychain"
      ? h.place.which === "current"
        ? t.keychain.current
        : t.keychain.earlier
      : null;
  if (service === null) return { kind: "absent" };
  let answer: Awaited<ReturnType<KeychainPort["remove"]>>;
  try {
    answer = await deps.keychain.remove(service);
  } catch {
    answer = "refused";
  }
  const left = (reason: LeftReason): HoldingOutcome => ({
    kind: "left",
    reason,
    bytes: 0,
    where: service,
  });
  if (answer === "absent") return { kind: "absent" };
  if (answer !== "deleted") {
    return left(answer === "unsupported" ? "keychainUnsupported" : "keychainRefused");
  }
  // The check (rule 11), here and not at the end: the order is decided on what was found. A key
  // reported gone that is still there is left; when the store cannot be asked, its own yes stands.
  let still: boolean | null;
  try {
    still = await deps.keychain.exists(service);
  } catch {
    still = null;
  }
  return still === true ? left("keychainRefused") : { kind: "gone", bytes: 0 };
}

/**
 * The database's own files (ADR 0110), which no delete of another holding nor the sweep takes,
 * nor a folder above them, from the first deletion of the run to the release of the claim (or to
 * its end, when the claim was refused). `files` are their real paths, as the guard resolves them;
 * `around` the folders emptied around them, by real path, each with the path it was reached by,
 * removed once the claim is released and the files are gone.
 */
interface Keep {
  readonly files: ReadonlySet<string>;
  readonly real: (path: string) => string;
  readonly around: Map<string, string>;
}

interface Tally {
  gone: number;
  any: boolean;
  leftBytes: number;
  left: { reason: LeftReason; where: string } | null;
}

function erasePaths(
  paths: readonly string[],
  deps: EraseDeps,
  keep: Keep | null = null,
): HoldingOutcome {
  const tally: Tally = { gone: 0, any: false, leftBytes: 0, left: null };
  for (const path of paths) erasePath(path, deps, keep, tally);
  const kept = tally.left as { reason: LeftReason; where: string } | null;
  if (kept !== null)
    return { kind: "left", reason: kept.reason, where: kept.where, bytes: tally.leftBytes };
  return tally.any ? { kind: "gone", bytes: tally.gone } : { kind: "absent" };
}

/**
 * One path, removed and looked for again. The one chokepoint every delete of a holding and of the
 * sweep goes through: while the database is kept, its files are passed over (they go in the
 * database step, the owner file by the release), and a folder above them is emptied around them
 * instead of removed. Neither is left.
 */
function erasePath(path: string, deps: EraseDeps, keep: Keep | null, tally: Tally): void {
  const leave = (reason: LeftReason, where: string, bytes: number) => {
    tally.left = { reason, where };
    tally.leftBytes += bytes;
  };
  // A kept file is not even looked at here: the database step and the release look for them.
  const target = keep === null ? null : targetOf(path, keep.real);
  if (keep !== null && target !== null && keep.files.has(target)) return;
  let entry: ReturnType<EraseFs["entry"]>;
  try {
    entry = deps.fs.entry(path);
  } catch (error) {
    // It could not be looked at: maybe there, never "absent".
    tally.any = true;
    leave(reasonOf(error), path, 0);
    return;
  }
  if (entry === null) return;
  if (keep !== null && target !== null) {
    if (entry.kind === "dir" && [...keep.files].some((f) => inside(f, target))) {
      tally.any = true;
      if (!deps.guard(path)) {
        leave("outsideReach", path, deps.fs.size(path));
        return;
      }
      let names: readonly string[];
      try {
        names = deps.fs.list(path);
      } catch (error) {
        leave(reasonOf(error), path, 0);
        return;
      }
      if (!keep.around.has(target)) keep.around.set(target, path);
      for (const name of names) erasePath(join(path, name), deps, keep, tally);
      return;
    }
  }
  tally.any = true;
  const bytes = entry.kind === "dir" ? deps.fs.size(path) : entry.kind === "file" ? entry.size : 0;
  if (!deps.guard(path)) {
    leave("outsideReach", path, bytes);
    return;
  }
  try {
    deps.fs.remove(path);
  } catch (error) {
    leave(reasonOf(error), path, bytes);
    return;
  }
  // Looked for again: a delete that said yes and left the file is not "gone".
  let still: boolean;
  try {
    still = deps.fs.entry(path) !== null;
  } catch {
    still = true;
  }
  if (still) leave("busy", path, bytes);
  else tally.gone += bytes;
}

/**
 * The folders emptied around the database's files, once the claim is released and they are gone:
 * deepest first, each only while it is empty and the guard allows it. What a run started since
 * has written keeps its folder; an empty folder that cannot be removed holds nothing.
 */
function removeAround(keep: Keep, deps: EraseDeps): void {
  const depth = (p: string) => p.split(sep).length;
  const folders = [...keep.around.entries()].sort(([a], [b]) => depth(b) - depth(a));
  for (const [, path] of folders) {
    try {
      if (deps.fs.list(path).length === 0 && deps.guard(path)) deps.fs.removeEmptyDir(path);
    } catch {}
  }
}

/** A holding's paths, erased; a folder that could not be listed is left, never "absent". */
function eraseHolding(
  h: Holding,
  t: EraseTargets,
  deps: EraseDeps,
  keep: Keep | null = null,
): HoldingOutcome {
  let paths: readonly string[];
  try {
    paths = pathsOf(h, t, deps.fs);
  } catch (error) {
    const where = h.place.kind === "temp" ? t.tempDir : t.dataDir;
    return { kind: "left", reason: reasonOf(error), bytes: 0, where };
  }
  return erasePaths(paths, deps, keep);
}

/** The erase's own claim on the database, held from before the first deletion to the end of the sweep. */
interface HeldClaim {
  readonly claim: { release(): void };
  /** The owner file's holdings, noted when the claim is released and the file looked for again. */
  readonly owners: readonly Holding[];
}

const isOwner = (h: Holding) => h.place.kind === "database" && h.place.suffix === OWNER_SUFFIX;

/**
 * The database's claim (ADR 0110), taken before the first deletion of the run (taking it deletes
 * nothing). `refused` is why the database's files may not be touched: another live run holds it,
 * or whether one does could not be told. Neither: no folder to claim in, or nothing to claim with.
 */
function claimAtStart(deps: EraseDeps): {
  readonly claim: { release(): void } | null;
  readonly refused: LeftReason | null;
} {
  if (!deps.claimDatabase) return { claim: null, refused: null };
  try {
    const c = deps.claimDatabase();
    return c.kind === "held" ? { claim: null, refused: "inUse" } : { claim: c, refused: null };
  } catch (error) {
    // No folder to claim in: no database in it either, which the deletes confirm.
    return { claim: null, refused: missing(error) ? null : reasonOf(error) };
  }
}

/**
 * The database's files. When the claim was refused, none of them is touched and each is left with
 * the reason. Under the erase's own claim they are erased; the claim is not released here but at
 * the end of the sweep (no other run can claim the database and write files the sweep would
 * take), and its owner file goes last, by `settleClaim`. `ownerKeep` keeps only the owner file.
 */
function eraseDatabase(
  inStep: readonly Holding[],
  t: EraseTargets,
  deps: EraseDeps,
  note: (h: Holding, o: HoldingOutcome) => void,
  claimed: boolean,
  refused: LeftReason | null,
  ownerKeep: Keep | null,
): void {
  for (const h of claimed ? inStep.filter((h) => !isOwner(h)) : inStep) {
    if (refused !== null) {
      const paths = h.place.kind === "database" ? [t.databasePath + h.place.suffix] : [];
      note(h, leaveAll(paths, refused, deps));
      continue;
    }
    note(h, eraseHolding(h, t, deps, ownerKeep));
  }
}

/**
 * Releases the erase's claim, which removes its own owner file and no other (ADR 0110), then looks
 * for the file again: gone, or left. One a later start wrote meanwhile is that start's, and a look
 * that fails is a thing left. Never throws.
 */
function settleClaim(
  held: HeldClaim,
  t: EraseTargets,
  deps: EraseDeps,
  note: (h: Holding, o: HoldingOutcome) => void,
): void {
  const path = t.databasePath + OWNER_SUFFIX;
  try {
    held.claim.release();
  } catch {
    // Looked at below: what is still there is left.
  }
  let outcome: HoldingOutcome;
  try {
    const after = deps.fs.entry(path);
    outcome =
      after === null
        ? { kind: "gone", bytes: 0 }
        : { kind: "left", reason: "inUse", bytes: after.size, where: path };
  } catch (error) {
    outcome = { kind: "left", reason: reasonOf(error), bytes: 0, where: path };
  }
  for (const h of held.owners) {
    try {
      note(h, outcome);
    } catch {}
  }
}

/** Paths not touched, each left with `reason` when it is (or may be) there. */
function leaveAll(paths: readonly string[], reason: LeftReason, deps: EraseDeps): HoldingOutcome {
  let bytes = 0;
  let where: string | null = null;
  for (const path of paths) {
    let entry: ReturnType<EraseFs["entry"]> | undefined;
    try {
      entry = deps.fs.entry(path);
    } catch {
      entry = undefined;
    }
    if (entry === null) continue;
    where = path;
    bytes += entry?.kind === "file" ? entry.size : 0;
  }
  return where === null ? { kind: "absent" } : { kind: "left", reason, bytes, where };
}

/** Whether the earlier identity's folder is (or may be) still there. */
function earlierThere(t: Pick<EraseTargets, "earlierDir">, fs: EraseFs): boolean {
  if (t.earlierDir === null) return false;
  try {
    return fs.entry(t.earlierDir) !== null;
  } catch {
    return true;
  }
}

/**
 * Writes the identity move's "done" marker while the earlier copy is there, so that the move never
 * brings it back (rule 4). Throws when it cannot be written.
 */
function keepEarlierOut(
  t: Pick<EraseTargets, "dataDir" | "earlierDir">,
  deps: Pick<EraseDeps, "fs" | "now" | "doneMarker">,
): void {
  if (t.earlierDir === null || !deps.doneMarker || !earlierThere(t, deps.fs)) return;
  const marker = deps.doneMarker(t.earlierDir, deps.now());
  deps.fs.writeAtomic(join(t.dataDir, marker.name), marker.text);
}

/**
 * "Leave them and start again" (rule 11): the order goes, and with it every retry. The marker that
 * keeps the earlier copy out goes in first, on this path too; when it cannot be written, or the
 * order cannot be removed, the order stays and the next start erases again. True when it went.
 */
export function leaveErase(
  t: Pick<EraseTargets, "dataDir" | "earlierDir">,
  deps: Pick<EraseDeps, "fs" | "now" | "doneMarker">,
): boolean {
  try {
    keepEarlierOut(t, deps);
    dropEraseOrder(t.dataDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the erase, in the order of the plan (rule 3), and checks what it did (rule 11): every path
 * and key is looked for again as it goes. Entries of the data folder that no holding claimed go
 * before the order, so the folder ends empty; the order goes last, and only when every outcome is
 * known and nothing was left: a start after a partial erase tries again. A look that fails is a
 * thing left, never one gone. When the earlier copy stays, the identity move's "done" marker is
 * written before the order goes, so that the move never brings it back (rule 4). The database's
 * claim (ADR 0110) is taken before the first deletion and held until the sweep is done. From the
 * first deletion on, no delete but the database step's takes the database's files, nor a folder
 * above them: under the erase's own claim until the release (the owner file goes last, by
 * releasing it, then the folders emptied around them, before the order); when the claim is
 * refused, for the whole run. On every other way out the claim is released too. It does not
 * throw: what it could not do is in the result.
 */
export async function runErase(
  order: EraseOrder,
  holdings: readonly Holding[],
  t: EraseTargets,
  deps: EraseDeps,
): Promise<EraseResult> {
  const startedAtMs = deps.now();
  const earlierCopy = order.earlierCopy && t.earlierDir !== null;
  const outcomes: { holding: Holding; outcome: HoldingOutcome }[] = [];
  const note = (holding: Holding, outcome: HoldingOutcome) => {
    outcomes.push({ holding, outcome });
    deps.progress?.({ kind: "holding", holding, outcome });
  };
  // The database's claim, from before the first deletion until the sweep is done (ADR 0110):
  // while it is held no other run can claim the database and write files the sweep would take.
  let held: HeldClaim | null = null;
  // The database's files and the folders above them, which no other delete takes while the
  // claim is held, or for the whole run when it was refused.
  let kept: Keep | null = null;
  let ownerKeep: Keep | null = null;
  let refused: LeftReason | null = null;
  const keep = () => (held !== null || refused !== null ? kept : null);
  const settle = () => {
    const h = held;
    held = null;
    if (h !== null) settleClaim(h, t, deps, note);
  };
  try {
    const plan = erasePlan(holdings, { earlierCopy });
    const real = deps.real ?? realpathSync;
    const family = holdings.flatMap((h) =>
      h.place.kind === "database" ? [{ h, path: t.databasePath + h.place.suffix }] : [],
    );
    const start = claimAtStart(deps);
    refused = start.refused;
    if (start.claim !== null) {
      const owners = plan.flatMap((s) => (s.step === "database" ? s.holdings : [])).filter(isOwner);
      held = { claim: start.claim, owners };
    }
    if (held !== null || refused !== null) {
      const around = new Map<string, string>();
      const target = (p: string) => targetOf(p, real);
      kept = { files: new Set(family.map((f) => target(f.path))), real, around };
      const owner = target(t.databasePath + OWNER_SUFFIX);
      ownerKeep = held === null ? null : { files: new Set([owner]), real, around };
    }
    for (const { step, holdings: inStep } of plan) {
      deps.progress?.({ kind: "step", step });
      if (step === "order") {
        // Something left: the sweep below would take it too, a database another run owns included.
        if (outcomes.some((o) => o.outcome.kind === "left")) break;
        // What no holding claimed: the folder is removed whole, not file by file (rule 3). The
        // database's files, and any folder above them, are passed over: the owner file goes by
        // releasing the claim, below, and the folders after it.
        const undeclared: Holding = {
          id: "desktop.undeclared",
          group: "caches",
          step: "order",
          place: { kind: "data", name: "", match: "prefix" },
        };
        let stray: string[] = [];
        try {
          stray = deps.fs
            .list(t.dataDir)
            .filter((n) => n !== ERASE_ORDER_FILE)
            .map((n) => join(t.dataDir, n));
        } catch (error) {
          note(undeclared, { kind: "left", reason: reasonOf(error), bytes: 0, where: t.dataDir });
        }
        if (stray.length > 0) note(undeclared, erasePaths(stray, deps, keep()));
        if (outcomes.some((o) => o.outcome.kind === "left")) break;
        try {
          keepEarlierOut(t, deps);
        } catch (error) {
          // Without the marker the move would bring the earlier copy back: the order stays.
          note(
            {
              id: "desktop.doneMarker",
              group: "settings",
              step: "order",
              place: { kind: "data", name: "", match: "prefix" },
            },
            { kind: "left", reason: reasonOf(error), bytes: 0, where: t.dataDir },
          );
          break;
        }
        // The owner file last of all the erase deletes; the order only once it is known gone.
        settle();
        if (outcomes.some((o) => o.outcome.kind === "left")) break;
        // The folders kept only for the database's files, now that they are gone.
        const around = kept as Keep | null;
        if (around !== null) removeAround(around, deps);
        for (const h of inStep) note(h, eraseHolding(h, t, deps));
        // Empty now: the folder itself goes too (it stays with the marker in it, or with what a
        // run started since the claim was released has written).
        try {
          if (deps.fs.list(t.dataDir).length === 0 && deps.guard(t.dataDir))
            deps.fs.removeEmptyDir(t.dataDir);
        } catch {
          // An empty folder left behind holds nothing.
        }
        continue;
      }
      if (step === "database") {
        eraseDatabase(inStep, t, deps, note, held !== null, refused, ownerKeep);
        continue;
      }
      for (const h of inStep) {
        if (h.place.kind === "keychain") note(h, await eraseKey(h, t, deps));
        else note(h, eraseHolding(h, t, deps, keep()));
      }
    }
  } finally {
    // Every other way out (something left, a step that threw): released, and its file looked for.
    settle();
  }
  return { startedAtMs, endedAtMs: deps.now(), earlierCopy, outcomes };
}
