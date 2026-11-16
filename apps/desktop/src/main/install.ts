// One install of a newer version, when the person asked for it (ADR 0140). The steps and checks of
// `site/install.sh` (ADR 0139, rules 2 to 5), in the same order, stopping at the first failure
// with nothing installed: download the image and the checksums; the image's SHA-256 against
// `SHA256SUMS.txt`; the build record with `gh` when it is found; the image opened read-only; the
// lock of the folder; the app copied beside the old one; its signature seal and that it is that
// version of Matters; then the helper that swaps it in once the app has quit. Every side effect is
// handed in, so the order and the refusals can be tested without a network or a disk image.
import { join } from "node:path";
import {
  type DownloadLimits,
  GH_PLACES,
  INSTALL_BUNDLE_ID,
  INSTALL_LIMITS,
  INSTALL_NAMES,
  INSTALL_REPO,
  INSTALL_WORKFLOW,
  type InstallEvent,
  type InstallFailure,
  installFiles,
  mayInstall,
  readSums,
  sameSum,
} from "@matters/core";
import type { DownloadResult } from "./installDownload.ts";
import type { LockTaken } from "./installSwap.ts";

/** What a program run ended with. */
export interface RunResult {
  /** The exit code; null when it was stopped or could not start. */
  readonly code: number | null;
  readonly stdout: string;
}

export interface InstallDeps {
  download(
    url: string,
    path: string,
    limits: DownloadLimits,
    progress: (received: number, total: number | null) => void,
    signal: AbortSignal,
  ): Promise<DownloadResult>;
  sha256(path: string): Promise<string>;
  readText(path: string): string | null;
  /** Runs a program by its full path, with a fixed environment and a time limit. */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<RunResult>;
  /** Runs `gh`, which also needs a home folder for its cache. */
  runGh(file: string, args: readonly string[], timeoutMs: number): Promise<RunResult>;
  /** The first of `GH_PLACES` that is a program this user may run; null when none is. */
  findGh(places: readonly string[]): string | null;
  isDirectory(path: string): boolean;
  /** A new empty folder of this install's own, and its removal. */
  makeWork(): string;
  removeWork(path: string): void;
  takeLock(folder: string): LockTaken;
  clearLeftovers(folder: string): void;
  releaseLock(folder: string): void;
  removeTree(path: string): void;
  startSwap(pid: number, folder: string): Promise<boolean>;
  /** Hears each step (rule 5). */
  step(event: InstallEvent): void;
}

export interface InstallAsk {
  readonly version: string;
  readonly running: string;
  /** The folder the running `Matters.app` is in (rule 2). */
  readonly folder: string;
  readonly pid: number;
  readonly signal: AbortSignal;
  /** The release downloads; a window test's stand-in hands in its own. */
  readonly base?: string;
}

/** How long each program may take. */
const LIMIT_MS = {
  attach: 120_000,
  detach: 60_000,
  copy: 300_000,
  codesign: 120_000,
  plist: 10_000,
  gh: 120_000,
} as const;

const PROGRAMS = {
  hdiutil: "/usr/bin/hdiutil",
  ditto: "/usr/bin/ditto",
  codesign: "/usr/bin/codesign",
  plutil: "/usr/bin/plutil",
} as const;

/** Says which download failed in the terms of an install. */
const asFailure = (r: Extract<DownloadResult, { ok: false }>): InstallFailure => r.failure;

/**
 * Runs the install. Resolves with the failure that stopped it, or null when the helper was
 * started and the app should now quit. The folder of the app is touched only after every check
 * of the download passed, and only with its lock held; whatever was put there is removed when a
 * later step fails.
 */
export async function runInstall(
  deps: InstallDeps,
  ask: InstallAsk,
): Promise<InstallFailure | null> {
  if (!mayInstall(ask.version, ask.running)) return "older";
  const files = installFiles(ask.version, ask.base);
  if (files === null) return "older";
  const work = deps.makeWork();
  let volume: string | null = null;
  let locked = false;
  const incoming = join(ask.folder, INSTALL_NAMES.installing);
  try {
    const image = join(work, files.image);
    const got = await deps.download(
      files.imageUrl,
      image,
      INSTALL_LIMITS.image,
      (received, total) => deps.step({ kind: "progress", received, total }),
      ask.signal,
    );
    if (!got.ok) return asFailure(got);
    const sumsPath = join(work, "SHA256SUMS.txt");
    const sums = await deps.download(
      files.sumsUrl,
      sumsPath,
      INSTALL_LIMITS.sums,
      () => {},
      ask.signal,
    );
    if (!sums.ok) return asFailure(sums);

    // The image's line, and its sum. No line, or a different sum: stop.
    deps.step({ kind: "check", check: "checksum" });
    const line = readSums(deps.readText(sumsPath) ?? "", files.image);
    if (!line.ok) return "sums";
    if (!sameSum(await deps.sha256(image), line.sum)) return "checksum";

    // Where it was built, when gh is there; the checksum only says the download is whole.
    const gh = deps.findGh(GH_PLACES);
    if (gh !== null) {
      deps.step({ kind: "check", check: "build-record" });
      const recordPath = join(work, files.record);
      const record = await deps.download(
        files.recordUrl,
        recordPath,
        INSTALL_LIMITS.record,
        () => {},
        ask.signal,
      );
      if (!record.ok) return record.failure === "cancelled" ? "cancelled" : "build-record";
      const verified = await deps.runGh(
        gh,
        [
          "attestation",
          "verify",
          image,
          "--repo",
          INSTALL_REPO,
          "--signer-workflow",
          INSTALL_WORKFLOW,
          "--bundle",
          recordPath,
        ],
        LIMIT_MS.gh,
      );
      if (verified.code !== 0) return "build-record";
    }
    deps.step({ kind: "install", recorded: gh !== null });

    volume = join(work, "volume");
    const attached = await deps.run(
      PROGRAMS.hdiutil,
      ["attach", image, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", volume],
      LIMIT_MS.attach,
    );
    if (attached.code !== 0) {
      volume = null;
      return "image";
    }
    const source = join(volume, INSTALL_NAMES.app);
    if (!deps.isDirectory(source)) return "image";

    // One install into a folder at a time, with the script's lock.
    const lock = deps.takeLock(ask.folder);
    if (lock === "held") return "locked";
    if (lock === "failed") return "copy";
    locked = true;
    try {
      deps.clearLeftovers(ask.folder);
    } catch {
      return "copy";
    }

    // Copied beside the old one and checked there, so a failure leaves the old one as it is.
    const copied = await deps.run(PROGRAMS.ditto, [source, incoming], LIMIT_MS.copy);
    if (copied.code !== 0) return "copy";
    const sealed = await deps.run(
      PROGRAMS.codesign,
      ["--verify", "--deep", "--strict", incoming],
      LIMIT_MS.codesign,
    );
    if (sealed.code !== 0) return "signature";
    const plist = join(incoming, "Contents", "Info.plist");
    const read = (key: string) =>
      deps.run(PROGRAMS.plutil, ["-extract", key, "raw", "-o", "-", plist], LIMIT_MS.plist);
    const id = await read("CFBundleIdentifier");
    const version = await read("CFBundleShortVersionString");
    if (
      id.code !== 0 ||
      id.stdout.trim() !== INSTALL_BUNDLE_ID ||
      version.code !== 0 ||
      version.stdout.trim() !== files.version
    ) {
      return "not-matters";
    }

    await detach(deps, volume);
    volume = null;
    if (!(await deps.startSwap(ask.pid, ask.folder))) return "restart";
    // The helper holds the lock now, and the new app beside the old one is its to move.
    locked = false;
    deps.step({ kind: "restart" });
    return null;
  } finally {
    if (volume !== null) await detach(deps, volume);
    if (locked) {
      deps.removeTree(incoming);
      deps.releaseLock(ask.folder);
    }
    deps.removeWork(work);
  }
}

async function detach(deps: InstallDeps, volume: string): Promise<void> {
  const first = await deps.run(PROGRAMS.hdiutil, ["detach", volume, "-quiet"], LIMIT_MS.detach);
  if (first.code !== 0) {
    await deps.run(PROGRAMS.hdiutil, ["detach", volume, "-force", "-quiet"], LIMIT_MS.detach);
  }
}
