// ADR 0105 smoke: the app identity moves from the old name to Matters, end to end, in temporary
// folders only. Run: ELECTRON_RUN_AS_NODE=1 electron tools/smoke-identity.ts (needs
// `electron-vite build` first; the root `smoke:identity` script does both).
//
// 1. An old identity folder is made the way the old app left one: the built app runs on it with
//    its own data (a seeded database), then a small Electron script under the old name saves an
//    encrypted password and a localStorage value there.
// 2. With the old database held open by another process, the app refuses to move and changes
//    nothing.
// 3. The app starts on an empty new folder and moves: the mail is there without seeding, the
//    password reads back under the new name, the localStorage value has its new key.
// 4. A second start moves nothing. The old folder is byte-identical after every step.
//
// Smoke runs use the mock keychain, which answers for any name: this proves the steps, the files
// and the helper's channel, not that a name selects a Keychain item (ADR 0105 records that check).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "MATTERS_SMOKE_RESULT ";
const RUN_TIMEOUT_MS = 90_000;
const ACCOUNT = "smoke-identity-account";
const MARKER = "identity-migration.json";

interface Run {
  readonly result: Record<string, unknown> | undefined;
  readonly seeded: number | undefined;
  readonly exitCode: number | null;
  readonly log: string;
}

/** The built app in a smoke run; `env` says which folders it uses. */
function runApp(env: Record<string, string>): Promise<Run> {
  return new Promise((done) => {
    const { ELECTRON_RUN_AS_NODE: _drop, ...inherited } = process.env;
    const child = spawn(process.execPath, [join(root, "apps/desktop")], {
      env: {
        ...inherited,
        MATTERS_SMOKE: "1",
        // The cold phase holds no launch budget: the first start after a move does more.
        MATTERS_SMOKE_PHASE: "cold",
        MATTERS_SMOKE_TIMEOUT_MS: "80000",
        MATTERS_SEED: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d: Buffer) => {
      log += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      log += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const line = log.split("\n").find((l) => l.startsWith(PREFIX));
      const backend = /matters-backend: .*seeded=(\d+)/.exec(log);
      done({
        result: line
          ? (JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>)
          : undefined,
        seeded: backend ? Number(backend[1]) : undefined,
        exitCode,
        log,
      });
    });
  });
}

/** A tiny Electron app that plays the old app (writing) or looks at the new folder (reading). */
const SEED_SCRIPT = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";
const { SEED_MODE: mode, SEED_DIR: dir, SEED_OUT: out, SEED_PASSWORD: password } = process.env;
app.setName(mode === "old" ? "@unclosed/desktop" : "Matters");
app.setPath("userData", dir);
app.commandLine.appendSwitch("use-mock-keychain");
app.whenReady().then(async () => {
  const result = {};
  const win = new BrowserWindow({ show: false });
  await win.loadFile(join(import.meta.dirname, "page.html"));
  if (mode === "old") {
    const credential = { kind: "password", username: "smoke@example.com", password };
    const blob = await safeStorage.encryptStringAsync(JSON.stringify(credential));
    const vault = { version: 1, entries: { "${ACCOUNT}": Buffer.from(blob).toString("base64") } };
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(vault), { mode: 0o600 });
    await win.webContents.executeJavaScript('localStorage.setItem("unclosed.smokeIdentity", "333")');
  } else {
    const vault = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    const blob = vault.entries["${ACCOUNT}"];
    const text = blob ? (await safeStorage.decryptStringAsync(Buffer.from(blob, "base64"))).result : "{}";
    result.passwordMatches = JSON.parse(text).password === password;
    result.storage = await win.webContents.executeJavaScript(
      '({ next: localStorage.getItem("matters.smokeIdentity"), old: localStorage.getItem("unclosed.smokeIdentity") })',
    );
  }
  writeFileSync(out, JSON.stringify(result));
  win.close();
});
app.on("window-all-closed", () => app.quit());
`;

function runSeed(
  dir: string,
  mode: "old" | "read",
  scratch: string,
  password: string,
): Promise<Record<string, unknown>> {
  const scriptDir = join(scratch, "seed");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, "main.mjs"), SEED_SCRIPT);
  writeFileSync(join(scriptDir, "page.html"), "<!doctype html><title>seed</title>");
  const out = join(scriptDir, `${mode}.json`);
  rmSync(out, { force: true });
  return new Promise((done, fail) => {
    const { ELECTRON_RUN_AS_NODE: _drop, ...inherited } = process.env;
    const child = spawn(process.execPath, [join(scriptDir, "main.mjs")], {
      env: { ...inherited, SEED_MODE: mode, SEED_DIR: dir, SEED_OUT: out, SEED_PASSWORD: password },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!existsSync(out)) fail(new Error(`seed ${mode} wrote nothing (exit ${code}): ${err}`));
      else done(JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>);
    });
  });
}

/** Every path under `dir` with its kind, mode, mtime and content hash. */
function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (path: string) => {
    const s = lstatSync(path);
    const key = relative(dir, path) || ".";
    if (s.isSymbolicLink()) lines.push(`${key} link ${readlinkSync(path)}`);
    else if (s.isDirectory()) {
      lines.push(`${key} dir ${s.mode}`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      lines.push(`${key} file ${s.mode} ${s.size} ${s.mtimeMs} ${hash}`);
    }
  };
  walk(dir);
  return lines.join("\n");
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

function countMessages(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scratch = mkdtempSync(join(tmpdir(), "matters-identity-smoke-"));
const oldDir = join(scratch, "@unclosed", "desktop");
const newDir = join(scratch, "Matters");
const password = `smoke-${randomBytes(12).toString("hex")}`;
const failures: string[] = [];
const report: Record<string, unknown> = {};
const moveEnv = { MATTERS_USER_DATA: newDir, MATTERS_OLD_USER_DATA: oldDir };
const logs: Record<string, string> = {};
/** The helper's scratch folders (identityHelper.ts): its parent must remove every one. */
const helperScratch = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith("matters-identity-") && !n.includes("smoke"));
const scratchBefore = new Set(helperScratch());
try {
  // 1. The old identity, as the old app left it.
  mkdirSync(oldDir, { recursive: true });
  const first = await runApp({
    MATTERS_USER_DATA: oldDir,
    MATTERS_DB_PATH: join(oldDir, "unclosed.db"),
  });
  logs.first = first.log;
  if (!first.result) failures.push(`old: the app gave no result (exit ${first.exitCode})`);
  if (!first.seeded) failures.push("old: the database was not seeded");
  // A run with data of its own never moves anything (ADR 0105, D).
  if (existsSync(join(oldDir, MARKER))) failures.push("old: a run with overrides wrote a marker");
  if (first.log.includes("matters-identity:"))
    failures.push("old: a run with overrides moved data");
  await runSeed(oldDir, "old", scratch, password);
  const oldMessages = countMessages(join(oldDir, "unclosed.db"));
  report.oldMessages = oldMessages;
  if (!(oldMessages > 0)) failures.push("old: no messages in the old database");
  const before = snapshot(oldDir);

  // 2. The old app still has its database open: refused, nothing changes.
  const holder = spawn(
    process.execPath,
    ["-e", "require('node:fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000)"].concat(
      join(oldDir, "unclosed.db"),
    ),
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" },
  );
  await sleep(800);
  const refused = await runApp(moveEnv);
  holder.kill("SIGKILL");
  logs.refused = refused.log;
  report.refused = {
    exitCode: refused.exitCode,
    // What a refused start (smoke mode: no dialog) leaves in the new folder.
    leftInNewDir: existsSync(newDir) ? readdirSync(newDir) : null,
  };
  if (refused.exitCode === 0) failures.push("running: the app started while the old one was open");
  if (
    !refused.log.includes("matters-identity: Another copy of Matters still has your mailbox open")
  ) {
    failures.push("running: the refusal was not reported");
  }
  if (existsSync(join(newDir, MARKER)) || existsSync(`${newDir}.migrating`)) {
    failures.push("running: the refused start left a marker or a staging copy");
  }
  if (snapshot(oldDir) !== before) failures.push("running: the old folder changed");

  // 3. The move, over what a start that never got going might have left in the new folder.
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(newDir, "Local State"), '{"debris":true}');
  writeFileSync(join(newDir, "Preferences"), '{"debris":true}');
  const moved = await runApp(moveEnv);
  logs.moved = moved.log;
  report.moved = {
    exitCode: moved.exitCode,
    seeded: moved.seeded,
    lines: moved.log.split("\n").filter((l) => l.startsWith("matters-identity:")),
  };
  if (!moved.result) failures.push(`move: the app gave no result (exit ${moved.exitCode})`);
  if (moved.seeded !== 0)
    failures.push(`move: expected the copied mail, got seeded=${moved.seeded}`);
  if (!/matters-identity: copied \d+ files/.test(moved.log))
    failures.push("move: no copy reported");
  if (!moved.log.includes("matters-identity: moved 1 saved passwords")) {
    failures.push("move: the password was not moved");
  }
  const marker = existsSync(join(newDir, MARKER))
    ? (JSON.parse(readFileSync(join(newDir, MARKER), "utf8")) as { state?: string })
    : null;
  if (marker?.state !== "done") failures.push(`move: marker is ${JSON.stringify(marker)}`);
  for (const name of ["matters.db", "credentials.json", "Local Storage"]) {
    if (!existsSync(join(newDir, name))) failures.push(`move: ${name} is missing`);
  }
  for (const name of ["unclosed.db", "unclosed.db-wal", "credentials.unclosed.json"]) {
    if (existsSync(join(newDir, name))) failures.push(`move: ${name} should not be there`);
  }
  if (existsSync(`${newDir}.migrating`)) failures.push("move: the staging copy is still there");
  const aside = readdirSync(scratch).filter((n) => n.startsWith("Matters.set-aside-"));
  report.setAside = aside;
  if (aside.length !== 1) failures.push(`move: expected one set-aside folder, found ${aside}`);
  else {
    const kept = readdirSync(join(scratch, aside[0] ?? "")).sort();
    if (kept.join(",") !== "Local State,Preferences") {
      failures.push(`move: the set-aside folder holds ${kept}`);
    }
  }
  if (!/matters-identity: .* held no mailbox.*set aside/.test(moved.log)) {
    failures.push("move: the set-aside was not reported");
  }
  const newMessages = countMessages(join(newDir, "matters.db"));
  report.newMessages = newMessages;
  if (newMessages !== oldMessages) {
    failures.push(`move: ${newMessages} messages in the new database, ${oldMessages} in the old`);
  }
  if (snapshot(oldDir) !== before) failures.push("move: the old folder changed");

  // 4. A second start moves nothing.
  const again = await runApp(moveEnv);
  logs.again = again.log;
  if (!again.result) failures.push(`again: the app gave no result (exit ${again.exitCode})`);
  if (again.log.includes("matters-identity:")) failures.push("again: the second start moved data");
  if (snapshot(oldDir) !== before) failures.push("again: the old folder changed");

  // The password under the new name, the setting under its new key.
  const read = await runSeed(newDir, "read", scratch, password);
  report.read = read;
  if (read.passwordMatches !== true) failures.push("read: the password did not round-trip");
  const storage = read.storage as { next?: unknown; old?: unknown } | undefined;
  if (storage?.next !== "333" || storage.old !== null) {
    failures.push(`read: localStorage is ${JSON.stringify(storage)}`);
  }

  // The plain password is in no file of either folder and in no output of the app.
  const secret = Buffer.from(password);
  for (const file of [...filesUnder(oldDir), ...filesUnder(newDir)]) {
    if (readFileSync(file).includes(secret)) failures.push(`the password is on disk in ${file}`);
  }
  for (const [name, log] of Object.entries(logs)) {
    if (log.includes(password)) failures.push(`the password appears in the ${name} output`);
  }
  const left = helperScratch().filter((n) => !scratchBefore.has(n));
  if (left.length > 0) failures.push(`the helper left its scratch folder: ${left.join(", ")}`);
} catch (error) {
  failures.push(`driver: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: failures.length === 0, failures, ...report }, null, 2));
if (failures.length > 0) {
  for (const [name, log] of Object.entries(logs)) console.error(`--- ${name} output ---\n${log}`);
}
process.exit(failures.length === 0 ? 0 : 1);
