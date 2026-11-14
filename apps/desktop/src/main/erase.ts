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

/**
 * The one look a normal start pays for (ADR 0138, Consequences): a read that fails with ENOENT. An
 * order that cannot be parsed still counts: the person confirmed something, and the erase goes on
 * without the earlier copy, the safe default.
 */
export function readEraseOrder(dataDir: string): EraseOrder | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, ERASE_ORDER_FILE), "utf8");
  } catch {
    return null;
  }
  return (
    parseEraseOrder(text) ?? {
      version: 1,
      at: new Date(0).toISOString(),
      earlierCopy: false,
      permissionPages: [],
    }
  );
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
    const absolute = resolve(path);
    // The last part is not followed: deleting a link removes the link.
    const target = join(realOf(dirname(absolute), real), basename(absolute));
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
  /** Kind and size of an entry, links not followed; null when nothing is there. */
  entry(
    path: string,
  ): { readonly kind: "file" | "dir" | "link" | "other"; readonly size: number } | null;
  /** Names in a folder; [] when it cannot be read. */
  list(dir: string): readonly string[];
  /** Bytes under a path, links not followed. */
  size(path: string): number;
  /** Removes a file, a link or a whole folder; throws with the system's code when it cannot. */
  remove(path: string): void;
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
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  size: sizeOfSync,
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 2 }),
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

export interface EraseDeps {
  readonly fs: EraseFs;
  readonly keychain: KeychainPort;
  readonly guard: (path: string) => boolean;
  readonly now: () => number;
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
  if (answer === "deleted") return { kind: "gone", bytes: 0 };
  if (answer === "absent") return { kind: "absent" };
  return {
    kind: "left",
    reason: answer === "unsupported" ? "keychainUnsupported" : "keychainRefused",
    bytes: 0,
    where: service,
  };
}

function erasePaths(paths: readonly string[], deps: EraseDeps): HoldingOutcome {
  let gone = 0;
  let any = false;
  let leftBytes = 0;
  let left: { reason: LeftReason; where: string } | null = null;
  const leave = (reason: LeftReason, where: string, bytes: number) => {
    left = { reason, where };
    leftBytes += bytes;
  };
  for (const path of paths) {
    const entry = deps.fs.entry(path);
    if (entry === null) continue;
    any = true;
    const bytes =
      entry.kind === "dir" ? deps.fs.size(path) : entry.kind === "file" ? entry.size : 0;
    if (!deps.guard(path)) {
      leave("outsideReach", path, bytes);
      continue;
    }
    try {
      deps.fs.remove(path);
    } catch (error) {
      leave(reasonOf(error), path, bytes);
      continue;
    }
    // Looked for again: a delete that said yes and left the file is not "gone".
    if (deps.fs.entry(path) !== null) leave("busy", path, bytes);
    else gone += bytes;
  }
  const kept = left as { reason: LeftReason; where: string } | null;
  if (kept !== null)
    return { kind: "left", reason: kept.reason, where: kept.where, bytes: leftBytes };
  return any ? { kind: "gone", bytes: gone } : { kind: "absent" };
}

/**
 * Runs the erase, in the order of the plan (rule 3), and checks what it did (rule 11): every path
 * and key is looked for again. Entries of the data folder that no holding claimed go before the
 * order, so the folder ends empty; the order goes last, and only when nothing was left: a start
 * after a partial erase tries again. When the earlier copy stays, the identity move's "done"
 * marker is written before the order goes, so that the move never brings it back (rule 4).
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
  for (const { step, holdings: inStep } of erasePlan(holdings, { earlierCopy })) {
    deps.progress?.({ kind: "step", step });
    if (step === "order") {
      // What no holding claimed: the folder is removed whole, not file by file (rule 3).
      const stray = deps.fs
        .list(t.dataDir)
        .filter((n) => n !== ERASE_ORDER_FILE)
        .map((n) => join(t.dataDir, n));
      if (stray.length > 0) {
        note(
          {
            id: "desktop.undeclared",
            group: "caches",
            step: "order",
            place: { kind: "data", name: "", match: "prefix" },
          },
          erasePaths(stray, deps),
        );
      }
      const left = outcomes.some((o) => o.outcome.kind === "left");
      if (left) break;
      if (
        !earlierCopy &&
        t.earlierDir !== null &&
        deps.fs.entry(t.earlierDir) !== null &&
        deps.doneMarker
      ) {
        const marker = deps.doneMarker(t.earlierDir, deps.now());
        deps.fs.writeAtomic(join(t.dataDir, marker.name), marker.text);
      }
      for (const h of inStep) note(h, erasePaths(pathsOf(h, t, deps.fs), deps));
      // Empty now: the folder itself goes too (it stays with the marker in it).
      if (deps.fs.list(t.dataDir).length === 0 && deps.guard(t.dataDir)) {
        try {
          deps.fs.remove(t.dataDir);
        } catch {
          // An empty folder left behind holds nothing.
        }
      }
      continue;
    }
    for (const h of inStep) {
      if (h.place.kind === "keychain") note(h, await eraseKey(h, t, deps));
      else note(h, erasePaths(pathsOf(h, t, deps.fs), deps));
    }
  }
  // The check (rule 11): keys asked again; a key reported gone that is still there is left.
  for (const o of outcomes) {
    if (o.holding.place.kind !== "keychain" || o.outcome.kind !== "gone") continue;
    const service = o.holding.place.which === "current" ? t.keychain.current : t.keychain.earlier;
    if (service !== null && (await deps.keychain.exists(service)) === true) {
      o.outcome = { kind: "left", reason: "keychainRefused", bytes: 0, where: service };
    }
  }
  return { startedAtMs, endedAtMs: deps.now(), earlierCopy, outcomes };
}
