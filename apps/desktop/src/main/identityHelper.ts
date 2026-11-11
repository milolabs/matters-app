// The Electron side of the identity move (ADR 0105): the helper process that decrypts the old
// passwords under the old name, the parent's end of its channel, and the probe for an old app that
// still has its database open.
//
// safeStorage picks its Keychain item from `app.name` once, before ready (checked on Electron
// 45.2.1 on macOS: `app.setName` before ready selects "<name> Safe Storage"; after ready it no
// longer changes anything). A running process therefore cannot read with the old key and write
// with the new one. The helper is the same executable started for this one job: it takes the old
// name, decrypts, hands the values to its parent over an inherited pipe, and exits.
import { execFileSync, spawn } from "node:child_process";
import { fstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import {
  MARKER,
  OLD_APP_NAME,
  type OldPlainVault,
  parseMarker,
  type RunningProbe,
  STAGED_CREDENTIALS,
} from "./identityMigration.ts";

export const HELPER_FLAG = "--matters-identity-helper";
const VAULT_FLAG = "--matters-identity-vault=";
const SCRATCH_FLAG = "--matters-identity-scratch=";
const SCRATCH_PREFIX = "matters-identity-";
/** The helper's only output: a pipe its parent made. Never stdout, stderr, a file or a log. */
const CHANNEL_FD = 3;
const MAX_ANSWER_BYTES = 1 << 20;
/** A packaged build signed differently may show one Keychain prompt; give a person time to answer. */
const HELPER_TIMEOUT_MS = 120_000;

export const isIdentityHelper = (argv: readonly string[]): boolean => argv.includes(HELPER_FLAG);

/** The pipe from the parent, or null when fd 3 is not one (a person or a script ran the flag). */
function parentChannel(): Socket | null {
  try {
    const s = fstatSync(CHANNEL_FD);
    if (!s.isFIFO() && !s.isSocket()) return null;
  } catch {
    return null;
  }
  return new Socket({ fd: CHANNEL_FD, readable: false, writable: true });
}

/**
 * Only a vault the move staged, while its marker says the passwords are still pending: once the
 * move is done the helper decrypts nothing, whoever starts it.
 */
function pendingVault(argv: readonly string[]): string | null {
  const path = argv.find((a) => a.startsWith(VAULT_FLAG))?.slice(VAULT_FLAG.length);
  if (!path || basename(path) !== STAGED_CREDENTIALS) return null;
  try {
    const marker = parseMarker(readFileSync(join(dirname(path), MARKER), "utf8"));
    return marker?.state === "credentials-pending" ? path : null;
  } catch {
    return null;
  }
}

/** A fresh, empty folder of the parent's in the temp directory; anything else is refused. */
function scratchDir(argv: readonly string[]): string | null {
  const path = argv.find((a) => a.startsWith(SCRATCH_FLAG))?.slice(SCRATCH_FLAG.length);
  if (!path || dirname(path) !== tmpdir() || !basename(path).startsWith(SCRATCH_PREFIX)) {
    return null;
  }
  try {
    return readdirSync(path).length === 0 ? path : null;
  } catch {
    return null;
  }
}

/**
 * Helper mode: called first thing in main, before anything else touches the app's identity. It
 * opens no window, uses a scratch userData of its own (never the old folder, never the new one),
 * and writes nothing but its one answer to the parent's pipe. Whoever starts it gets nothing on
 * stdout or stderr; the answer exists only when fd 3 is a pipe and a move is pending.
 */
export function runIdentityHelper(argv: readonly string[]): void {
  // The parent made this folder and removes it once the helper is gone (Electron writes into its
  // userData until the very end, so the helper cannot clean up after itself). Without it the helper
  // stops here, before Chromium could put a single file into any app folder, old or new.
  const scratch = scratchDir(argv);
  if (!scratch) process.exit(64);
  app.setName(OLD_APP_NAME);
  app.setPath("userData", scratch);
  try {
    app.dock?.hide();
  } catch {}
  const finish = (code: number) => app.exit(code);
  setTimeout(() => finish(70), HELPER_TIMEOUT_MS).unref();
  void app.whenReady().then(async () => {
    const out = parentChannel();
    if (!out) return finish(64);
    const vaultPath = pendingVault(argv);
    if (!vaultPath) {
      out.end(JSON.stringify({ error: "nothing is pending" }), () => finish(65));
      return;
    }
    const entries: Record<string, string | null> = {};
    try {
      const vault = JSON.parse(readFileSync(vaultPath, "utf8")) as {
        entries: Record<string, unknown>;
      };
      for (const [id, blob] of Object.entries(vault.entries)) {
        if (typeof blob !== "string") {
          entries[id] = null;
          continue;
        }
        try {
          entries[id] = (await safeStorage.decryptStringAsync(Buffer.from(blob, "base64"))).result;
        } catch {
          entries[id] = null;
        }
      }
    } catch {
      out.end(JSON.stringify({ error: "the staged vault could not be read" }), () => finish(66));
      return;
    }
    out.end(JSON.stringify({ entries }), () => finish(0));
  });
}

/** What the helper inherits: none of the app's own hooks (smoke, test password, trace). */
function helperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("MATTERS_") || key.startsWith("ELECTRON_") || key === "NODE_OPTIONS")
      continue;
    out[key] = value;
  }
  return out;
}

/**
 * The parent's end: starts the helper and reads its answer from fd 3. The plain values live only in
 * this process's memory, on their way to being encrypted again.
 */
export function readOldCredentials(stagedPath: string): Promise<OldPlainVault> {
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const args = [
    ...(app.isPackaged ? [] : [app.getAppPath()]),
    HELPER_FLAG,
    `${VAULT_FLAG}${stagedPath}`,
    `${SCRATCH_FLAG}${scratch}`,
    // A smoke run's mock keychain (index.ts) must be the helper's too.
    ...(app.commandLine.hasSwitch("use-mock-keychain") ? ["--use-mock-keychain"] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
      env: helperEnv(process.env),
    });
    const answer: Buffer[] = [];
    let answerBytes = 0;
    let errTail = "";
    const channel = child.stdio[CHANNEL_FD];
    channel?.on("data", (chunk: Buffer) => {
      answerBytes += chunk.length;
      if (answerBytes > MAX_ANSWER_BYTES) child.kill("SIGKILL");
      else answer.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), HELPER_TIMEOUT_MS + 5000);
    const cleanUp = () => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
    };
    child.once("error", (error) => {
      cleanUp();
      reject(error);
    });
    child.once("close", (code) => {
      cleanUp();
      let parsed: { entries?: unknown; error?: unknown } | null = null;
      try {
        parsed = JSON.parse(Buffer.concat(answer).toString("utf8"));
      } catch {}
      if (code !== 0 || !parsed || typeof parsed.entries !== "object" || parsed.entries === null) {
        const why = typeof parsed?.error === "string" ? parsed.error : `exit ${code}`;
        reject(new Error(`the helper could not read the old passwords (${why}) ${errTail.trim()}`));
        return;
      }
      const entries: Record<string, string | null> = {};
      for (const [id, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
        entries[id] = typeof value === "string" ? value : null;
      }
      resolve(entries);
    });
  });
}

/** The pids in lsof's `-F p` output: one `p<pid>` line per process. */
const lsofPids = (out: string): number[] =>
  out
    .split("\n")
    .filter((l) => l.startsWith("p"))
    .map((l) => Number(l.slice(1)));

/**
 * macOS: lsof lists who has the files open. It exits 1 as soon as one of the files is open nowhere
 * (the old app may hold the database and not its -shm), so its output decides, not its exit code.
 */
function lsofProbe(files: readonly string[]): ReturnType<RunningProbe> {
  try {
    const out = execFileSync("/usr/sbin/lsof", ["-F", "p", "--", ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    return fromPids(lsofPids(out));
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string };
    if (e.status === 1) return fromPids(lsofPids(e.stdout ?? ""));
    return { state: "unknown", reason: "lsof did not answer" };
  }
}

/** Linux: every process's open descriptors, from /proc. */
function procProbe(files: readonly string[]): ReturnType<RunningProbe> {
  const wanted = new Set(files);
  const pids: number[] = [];
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          if (wanted.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
            pids.push(Number(pid));
            break;
          }
        } catch {}
      }
    }
  } catch {
    return { state: "unknown", reason: "/proc could not be read" };
  }
  return fromPids(pids);
}

function fromPids(all: readonly number[]): ReturnType<RunningProbe> {
  const pids = [...new Set(all)].filter((p) => Number.isFinite(p) && p !== process.pid);
  return pids.length > 0 ? { state: "running", pids } : { state: "free" };
}

/**
 * Whether the old app still has its database open. Windows has no probe here; there the move
 * relies on the check that the old files did not change while they were copied.
 */
export const probeOldApp: RunningProbe = (files) => {
  if (files.length === 0) return { state: "free" };
  if (process.platform === "darwin") return lsofProbe(files);
  if (process.platform === "linux") return procProbe(files);
  return { state: "unknown", reason: `no probe on ${process.platform}` };
};
