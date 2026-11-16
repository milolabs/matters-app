// Main's side of installing a newer version (ADR 0140): where this copy is (rule 2), the step of
// the install and who hears it (rule 5), one install at a time, the person's cancel, and the
// programs and files the install uses on this Mac. index.ts makes one and hands it main's parts.
import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  bundleOf,
  INSTALL_IDLE,
  INSTALL_NAMES,
  type InstallEvent,
  type InstallPlace,
  type InstallState,
  installBusy,
  installPlace,
  mayInstall,
  nextInstall,
  type OfferedRelease,
} from "@matters/core";
import { type InstallDeps, type RunResult, runInstall } from "./install.ts";
import { type DownloadRequestLike, downloadToFile, sha256File } from "./installDownload.ts";
import { clearLeftovers, releaseLock, SYSTEM_PATH, startSwap, takeLock } from "./installSwap.ts";
import type { InstallView } from "./release.ts";

/** Runs a program with a fixed environment and a time limit; never through a shell. */
export function runProgram(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd: "/", encoding: "utf8" },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
  });
}

const can = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where this copy runs from, and whether it can be replaced there (rule 2). The bundle is read
 * from the program's own path, links resolved. A window test hands in the folder of a stand-in
 * `Matters.app` instead, in a build that is not packaged.
 */
export function placeOfThisCopy(input: {
  readonly packaged: boolean;
  readonly executable: string;
  readonly testFolder: string | null;
}): InstallPlace {
  const named =
    input.testFolder !== null
      ? join(input.testFolder, INSTALL_NAMES.app)
      : bundleOf(input.executable);
  let bundle: string | null = null;
  try {
    bundle = named === null ? null : realpathSync(named);
  } catch {
    bundle = null;
  }
  return installPlace({
    release: input.packaged || input.testFolder !== null,
    platform: process.platform,
    arch: process.arch,
    bundle,
    folderWritable: bundle !== null && can(dirname(bundle), constants.W_OK),
    bundleWritable: bundle !== null && can(bundle, constants.W_OK),
  });
}

/** The programs and files an install uses on this Mac; the download goes through main's `net`. */
export function systemInstallDeps(
  open: (url: string) => DownloadRequestLike,
  tempDir: string,
  step: (event: InstallEvent) => void,
  testRun: boolean,
): InstallDeps {
  const env = { PATH: SYSTEM_PATH };
  return {
    // A stand-in is never sent on anywhere.
    download: (url, path, limits, progress, signal) =>
      downloadToFile(
        testRun ? { open, allowRedirect: () => false } : { open },
        url,
        path,
        limits,
        progress,
        signal,
      ),
    sha256: sha256File,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    run: (file, args, ms) => runProgram(file, args, ms, env),
    // gh keeps what it fetched of the signing keys under the home folder; it asks nothing.
    runGh: (file, args, ms) =>
      runProgram(file, args, ms, {
        ...env,
        HOME: homedir(),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      }),
    findGh: (places) =>
      places.find((place) => {
        try {
          return statSync(place).isFile() && can(place, constants.X_OK);
        } catch {
          return false;
        }
      }) ?? null,
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    makeWork: () => mkdtempSync(join(tempDir, "matters-install-")),
    removeWork: (path) => rmSync(path, { recursive: true, force: true }),
    takeLock,
    clearLeftovers,
    releaseLock,
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    startSwap: (pid, folder) => startSwap({ pid, folder }),
    step,
  };
}

export interface InstallerParts {
  /** Where this copy is; asked once, when Settings first opens, never on the way to the mail. */
  place(): InstallPlace;
  /** The deps of one install, with the listener of its steps. */
  deps(step: (event: InstallEvent) => void): InstallDeps;
  running(): string;
  pid(): number;
  /** The step changed; `progress` when only the bytes so far did. */
  told(progress: boolean): void;
  /** The helper was started: the app quits, and the helper opens the new one. */
  quit(): void;
  /** The release downloads, or a window test's stand-in. */
  readonly base?: string;
}

/** How often the bytes so far are told to the windows. */
const PROGRESS_EVERY_MS = 200;

export class Installer {
  private state: InstallState = INSTALL_IDLE;
  private place: InstallPlace | null = null;
  private abort: AbortController | null = null;
  private run: Promise<void> | null = null;
  private toldAt = 0;

  private readonly parts: InstallerParts;

  constructor(parts: InstallerParts) {
    this.parts = parts;
  }

  /** Settings opened: where this copy is, from now on. */
  knowPlace(): void {
    this.place ??= this.parts.place();
  }

  view(): InstallView {
    return { place: this.place, state: this.state };
  }

  busy(): boolean {
    return installBusy(this.state);
  }

  private step(event: InstallEvent): void {
    const before = this.state;
    this.state = nextInstall(this.state, event);
    if (this.state === before) return;
    const progress = event.kind === "progress";
    if (progress) {
      const now = Date.now();
      if (now - this.toldAt < PROGRESS_EVERY_MS) return;
      this.toldAt = now;
    }
    this.parts.told(progress);
  }

  /**
   * The person pressed Install (rule 1). Only for a newer version a release has, when this copy
   * can be replaced, and when no install runs. False when nothing was started.
   */
  start(newer: OfferedRelease | null): boolean {
    const place = this.place;
    const running = this.parts.running();
    if (this.busy() || newer === null || place === null || !place.ok) return false;
    if (!mayInstall(newer.version, running)) return false;
    const abort = new AbortController();
    this.abort = abort;
    this.step({ kind: "start", version: newer.version });
    this.run = runInstall(
      this.parts.deps((event) => this.step(event)),
      {
        version: newer.version,
        running,
        folder: place.folder,
        pid: this.parts.pid(),
        signal: abort.signal,
        ...(this.parts.base !== undefined ? { base: this.parts.base } : {}),
      },
    )
      .catch((error: unknown) => {
        console.error("the install stopped", error);
        return "download" as const;
      })
      .then((failure) => {
        this.abort = null;
        if (failure !== null) this.step({ kind: "fail", failure });
        else this.parts.quit();
      });
    return true;
  }

  /** The person pressed Cancel; it counts only while the image downloads (rule 5). */
  cancel(): void {
    if (this.state.step === "downloading") this.abort?.abort();
  }

  /**
   * The app quits: a download stops, and what an install put beside the old app is cleaned up
   * before the app goes, for at most `ms`.
   */
  async settle(ms: number): Promise<void> {
    if (this.run === null || this.state.step === "restarting") return;
    this.abort?.abort();
    await Promise.race([this.run, new Promise((resolve) => setTimeout(resolve, ms))]);
  }
}
