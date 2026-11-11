// What main does with a received file (ADR 0043, rules 10 to 14): open, preview and save. The page
// names a file by (message key, part id) and nothing else. Main checks both, asks the backend to
// make the copy exist, finds the one file in that directory of the cache and refuses anything
// else, so a compromised page can reach only files that are already in the cache. Everything it
// needs from the outside comes in through `ReceivedDeps`, so the rules can be tested without a
// window, a dialog or a disk.
import { basename, join, resolve, sep } from "node:path";
import type { FetchReceivedOutcome, ReceivedAnswer, ReceivedItem } from "@matters/contracts";
import { isMessageKey, isPartId, isRunnableFile, safeFileName } from "@matters/core";

/** A Save all of more files than this is not a person's doing. */
export const MAX_SAVE_ALL = 200;

export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

export interface ReceivedDeps {
  /** The root of the cache; every path main opens or copies from is inside it. */
  readonly cacheDir: string;
  /** Asks the backend to make the copy exist, downloading it if it is not there. */
  fetch(messageKey: number, partId: string): Promise<FetchReceivedOutcome>;
  /** Entries of a directory; empty when it does not exist. */
  list(dir: string): Promise<readonly DirEntry[]>;
  /** Copies a file, by clone where the file system can. Rejects with `code: "EEXIST"` unless `overwrite`. */
  copy(from: string, to: string, overwrite: boolean): Promise<void>;
  /** Marks the file as from the internet; rejects when it could not. */
  quarantine(path: string): Promise<void>;
  /** The system's default app opens it. Resolves with an error text, "" when it worked. */
  openPath(path: string): Promise<string>;
  /** Quick Look. Absent where the platform has none. */
  preview?(path: string): void;
  /** The save dialog; undefined when cancelled. */
  chooseSavePath(defaultName: string): Promise<string | undefined>;
  /** The folder dialog of Save all; undefined when cancelled. */
  chooseFolder(): Promise<string | undefined>;
  log(message: string, error?: unknown): void;
}

const refused = (
  reason: "runnable" | "quarantine" | "unsupported" | "invalid",
): ReceivedAnswer => ({
  kind: "refused",
  reason,
});

/** "report.pdf" is "report 2.pdf" the second time: the number goes before the extension. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? `${name} ${n}` : `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
}

/** Whether a path is inside a directory, once both are resolved; `..` cannot get out. */
export function isInside(root: string, path: string): boolean {
  return resolve(path).startsWith(resolve(root) + sep);
}

export class ReceivedFiles {
  private readonly deps: ReceivedDeps;

  constructor(deps: ReceivedDeps) {
    this.deps = deps;
  }

  /** Opens the file in its default app, unless it is the kind that runs programs. */
  async open(messageKey: unknown, partId: unknown): Promise<ReceivedAnswer> {
    const copy = await this.ensure(messageKey, partId);
    if ("kind" in copy) return copy;
    // The page does not offer Open for these, and main does not trust the page to have checked.
    if (isRunnableFile(basename(copy.path))) return refused("runnable");
    try {
      await this.deps.quarantine(copy.path);
    } catch (error) {
      // An unmarked file would be opened with no judgement from the system: do not open it.
      this.deps.log("could not mark a received file as downloaded; not opening it", error);
      return refused("quarantine");
    }
    const failure = await this.deps.openPath(copy.path);
    if (failure !== "") {
      this.deps.log(`no app opened a received file: ${failure}`);
      return { kind: "failed" };
    }
    return { kind: "opened" };
  }

  /** Quick Look runs nothing, so it is offered for every file. */
  async preview(messageKey: unknown, partId: unknown): Promise<ReceivedAnswer> {
    const { preview } = this.deps;
    if (!preview) return refused("unsupported");
    const copy = await this.ensure(messageKey, partId);
    if ("kind" in copy) return copy;
    try {
      preview(copy.path);
    } catch (error) {
      this.deps.log("Quick Look could not show a received file", error);
      return { kind: "failed" };
    }
    return { kind: "previewed" };
  }

  /**
   * Asks where first, so a cancelled dialog costs no download, then makes the copy exist and
   * copies it there. The name offered is the page's hint, cleaned; the dialog decides the rest.
   */
  async save(messageKey: unknown, partId: unknown, nameHint: unknown): Promise<ReceivedAnswer> {
    if (!isMessageKey(messageKey) || !isPartId(partId)) return refused("invalid");
    const hint = typeof nameHint === "string" ? nameHint : "";
    const target = await this.deps.chooseSavePath(safeFileName(hint));
    if (target === undefined) return { kind: "cancelled" };
    const copy = await this.ensure(messageKey, partId);
    if ("kind" in copy) return copy;
    try {
      // The dialog has already asked about replacing a file that is there.
      await this.deps.copy(copy.path, target, true);
    } catch (error) {
      this.deps.log("could not save a received file", error);
      return { kind: "failed" };
    }
    await this.mark(target);
    return { kind: "saved", count: 1, skipped: 0 };
  }

  /**
   * Save all: one folder, and a name already taken there (or by an earlier file of this very
   * save) gets ` 2`, ` 3`. Nothing is ever overwritten: the copy refuses to, and the next number
   * is tried.
   */
  async saveAll(items: unknown): Promise<ReceivedAnswer> {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_SAVE_ALL) {
      return refused("invalid");
    }
    const wanted: ReceivedItem[] = [];
    for (const item of items as unknown[]) {
      const { messageKey, partId } = (item ?? {}) as Partial<ReceivedItem>;
      if (!isMessageKey(messageKey) || !isPartId(partId)) return refused("invalid");
      wanted.push({ messageKey, partId });
    }
    const folder = await this.deps.chooseFolder();
    if (folder === undefined) return { kind: "cancelled" };

    let saved = 0;
    let firstFailure: ReceivedAnswer | null = null;
    for (const item of wanted) {
      const copy = await this.ensure(item.messageKey, item.partId);
      if ("kind" in copy) {
        firstFailure ??= copy;
        continue;
      }
      const placed = await this.placeIn(folder, copy.path);
      if (placed === null) {
        firstFailure ??= { kind: "failed" };
        continue;
      }
      await this.mark(placed);
      saved++;
    }
    if (saved === 0 && firstFailure) return firstFailure;
    return { kind: "saved", count: saved, skipped: wanted.length - saved };
  }

  /** Copies into `folder` under the first free name; the destination of the copy, or null. */
  private async placeIn(folder: string, from: string): Promise<string | null> {
    const name = basename(from);
    for (let n = 1; n <= MAX_SAVE_ALL * 2; n++) {
      const to = join(folder, numberedName(name, n));
      try {
        await this.deps.copy(from, to, false);
        return to;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "EEXIST") continue;
        this.deps.log("could not save a received file", error);
        return null;
      }
    }
    return null;
  }

  /** A save that cannot be marked is still a save; the mark is for Gatekeeper, and the user chose to save. */
  private async mark(path: string): Promise<void> {
    try {
      await this.deps.quarantine(path);
    } catch (error) {
      this.deps.log("could not mark a saved file as downloaded", error);
    }
  }

  /**
   * Validates the key and makes the copy exist; the path of the one file in its directory, or the
   * answer to give instead. Anything but exactly one regular file there is refused.
   */
  private async ensure(
    messageKey: unknown,
    partId: unknown,
  ): Promise<{ readonly path: string } | ReceivedAnswer> {
    if (!isMessageKey(messageKey) || !isPartId(partId)) return refused("invalid");
    const outcome = await this.deps.fetch(messageKey, partId);
    if (outcome.kind !== "done") return { kind: outcome.kind };
    const dir = join(this.deps.cacheDir, String(messageKey), partId);
    if (!isInside(this.deps.cacheDir, dir)) return refused("invalid");
    const files = (await this.deps.list(dir)).filter(
      (e) => e.isFile && !e.isSymlink && !e.name.startsWith("."),
    );
    const only = files.length === 1 ? files[0] : undefined;
    if (!only || only.name !== basename(only.name)) {
      this.deps.log(`the cache holds ${files.length} files where one was expected`);
      return { kind: "failed" };
    }
    const path = join(dir, only.name);
    return isInside(this.deps.cacheDir, path) ? { path } : refused("invalid");
  }
}
