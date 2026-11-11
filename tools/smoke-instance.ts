// ADR 0110 smoke: one running copy per data folder, with the built app in temporary folders only.
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/smoke-instance.ts (needs `electron-vite build` first;
// the root `smoke:instance` script does both).
//
// 1. A second start on the same userData leaves at once with 0 and its stderr line; the first runs on.
// 2. A start on another userData with the same database (`MATTERS_DB_PATH`) is refused with 1.
// 3. The first copy is killed (-9): its owner file stays, and the next start takes it over and runs.
// 4. A quit by signal (SIGTERM goes through before-quit and will-quit, as Cmd+Q does) removes the
//    owner file.
//
// Every start is a smoke run (`MATTERS_SMOKE=1`): the mock keychain, and no dialog for a refused
// start (the dialog of a non-smoke start is not driven here). The first copy brings its window
// forward once, in step 1: that is what a second start does.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** A refused start leaves before the database, the backend and any window. */
const QUICK_EXIT_MS = 10_000;

interface Started {
  readonly child: ChildProcess;
  log(): string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
}

function start(userData: string, dbPath: string): Started {
  const { ELECTRON_RUN_AS_NODE: _drop, ...inherited } = process.env;
  const child = spawn(process.execPath, [join(root, "apps/desktop")], {
    env: {
      ...inherited,
      MATTERS_SMOKE: "1",
      MATTERS_SMOKE_PHASE: "cold",
      MATTERS_SMOKE_TIMEOUT_MS: "70000",
      MATTERS_SEED: "1",
      MATTERS_USER_DATA: userData,
      MATTERS_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d: Buffer) => {
    log += d;
  });
  child.stderr?.on("data", (d: Buffer) => {
    log += d;
  });
  const startedAt = Date.now();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>(
    (done) =>
      child.on("close", (code, signal) => done({ code, signal, ms: Date.now() - startedAt })),
  );
  return { child, log: () => log, exited };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

const alive = (p: Started) => p.child.exitCode === null && p.child.signalCode === null;

function ownerPid(dbPath: string): number | null {
  try {
    return (JSON.parse(readFileSync(`${dbPath}.owner`, "utf8")) as { pid?: number }).pid ?? null;
  } catch {
    return null;
  }
}

/** Every descendant of `pid`, deepest last: a main process killed with -9 leaves them behind. */
function descendants(pid: number): number[] {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  } catch {
    return [];
  }
  const kids = out.split("\n").filter(Boolean).map(Number);
  return kids.flatMap((k) => [k, ...descendants(k)]);
}

function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}

const dir = mkdtempSync(join(tmpdir(), "matters-smoke-instance-"));
const userData = join(dir, "userData");
const dbPath = join(dir, "matters.db");
const failures: string[] = [];
const report: Record<string, unknown> = {};
const running: Started[] = [];
const orphans: number[] = [];
try {
  const first = start(userData, dbPath);
  running.push(first);
  const up = await until(
    () => ownerPid(dbPath) === first.child.pid && /matters-backend: /.test(first.log()),
    30_000,
  );
  if (!up) throw new Error(`the first copy did not come up:\n${first.log()}`);

  // 1. Same userData, same database.
  const second = start(userData, dbPath);
  running.push(second);
  const s = await Promise.race([second.exited, sleep(QUICK_EXIT_MS).then(() => null)]);
  report.sameFolder = s;
  if (s === null) failures.push("same folder: the second start did not leave");
  else {
    if (s.code !== 0) failures.push(`same folder: the second start exited with ${s.code}, not 0`);
    if (!second.log().includes("matters-instance: another copy of Matters runs on")) {
      failures.push("same folder: the second start did not say why it left");
    }
    if (second.log().includes("matters-backend:"))
      failures.push("same folder: the second start started a backend");
  }
  if (!alive(first)) failures.push("same folder: the first copy stopped");
  if (ownerPid(dbPath) !== first.child.pid)
    failures.push("same folder: the owner file changed hands");

  // 2. Another userData, the same database.
  const other = start(join(dir, "userData-other"), dbPath);
  running.push(other);
  const o = await Promise.race([other.exited, sleep(QUICK_EXIT_MS).then(() => null)]);
  report.sameDatabase = o;
  if (o === null) failures.push("same database: the start on another folder did not leave");
  else {
    if (o.code !== 1) failures.push(`same database: exited with ${o.code}, not 1`);
    if (!other.log().includes(`matters-instance: ${dbPath} is in use by another copy of Matters`)) {
      failures.push("same database: the refusal was not reported");
    }
    if (!other.log().includes("data folder")) {
      failures.push("same database: the refusal did not name the other copy's data folder");
    }
    if (other.log().includes("matters-backend:"))
      failures.push("same database: the refused start started a backend");
  }
  if (!alive(first)) failures.push("same database: the first copy stopped");
  if (ownerPid(dbPath) !== first.child.pid)
    failures.push("same database: the owner file changed hands");

  // 3. The first copy dies without a word; the next start takes over.
  const firstPid = first.child.pid ?? 0;
  const left = descendants(firstPid);
  first.child.kill("SIGKILL");
  await first.exited;
  // Its backend and helpers may outlive it (ADR 0110, Consequences): reported, not under test.
  orphans.push(...left);
  await sleep(2_000);
  report.leftAfterKill = left.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }).length;
  if (ownerPid(dbPath) !== firstPid)
    failures.push("crash: the killed copy's owner file was not left");
  const after = start(userData, dbPath);
  running.push(after);
  const took = await until(
    () => ownerPid(dbPath) === after.child.pid && /matters-backend: /.test(after.log()),
    30_000,
  );
  report.takeOver = { took, exited: alive(after) ? null : after.child.exitCode };
  if (!took) failures.push("crash: the next start did not take the database over");
  if (after.log().includes("matters-instance:")) failures.push("crash: the next start was refused");

  // 4. A quit removes the owner file.
  after.child.kill("SIGTERM");
  const q = await Promise.race([after.exited, sleep(20_000).then(() => null)]);
  report.quit = q;
  if (q === null) failures.push("quit: SIGTERM did not end the app");
  else if (existsSync(`${dbPath}.owner`)) failures.push("quit: the owner file is still there");
} catch (error) {
  failures.push(`driver: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const p of running) {
    if (alive(p)) {
      orphans.push(...descendants(p.child.pid ?? 0));
      p.child.kill("SIGKILL");
      await p.exited;
    }
  }
  killAll(orphans);
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: failures.length === 0, failures, ...report }, null, 2));
if (failures.length > 0) {
  running.forEach((p, i) => {
    console.error(`--- start ${i + 1} output ---\n${p.log()}`);
  });
}
process.exit(failures.length === 0 ? 0 : 1);
