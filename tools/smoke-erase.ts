// ADR 0138 smoke: Erase everything, end to end, in temporary folders only. Run:
// ELECTRON_RUN_AS_NODE=1 electron tools/smoke-erase.ts (needs `electron-vite build` first).
//
// 1. A seeded build runs on a data folder of its own and leaves what a run leaves; nothing in that
//    folder may belong to no holding (rule 2).
// 2. A fake earlier copy is made next to it, and the folder is marked as moved from it (ADR 0105).
// 3. With an erase order, the next start erases before anything opens: the data folder holds only
//    the "done" marker, the earlier copy is untouched, the app's temp folders in the run's own temp
//    folder are gone and another program's are not, and the key store was asked for this
//    identity's key only (a fake: no smoke run ever starts /usr/bin/security).
// 4. The start after that opens on an empty mailbox and does not bring the earlier copy back in.
// 5. An erase that includes the earlier copy leaves no folder at all and asks for both keys.
// 6. An order that cannot be read (EACCES) is neither a normal start nor an erase: the start says
//    so and ends, and nothing in the folder or the key store is touched.
//
// Account removal (rule 5) is checked by packages/adapter-sqlite/test/holdings.test.ts on a real
// database file, down to the file's bytes after compaction.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULT = "MATTERS_ERASE_RESULT ";
const UNREADABLE = "MATTERS_ERASE_UNREADABLE ";
const ORDER = "erase-order.json";
const MARKER = "identity-migration.json";

interface Run {
  readonly exitCode: number | null;
  readonly log: string;
  readonly result: Record<string, unknown> | undefined;
}

function runApp(env: Record<string, string>, timeoutMs = 90_000): Promise<Run> {
  return new Promise((done) => {
    const { ELECTRON_RUN_AS_NODE: _drop, ...inherited } = process.env;
    const child = spawn(process.execPath, [join(root, "apps/desktop")], {
      env: { ...inherited, MATTERS_SMOKE: "1", MATTERS_SMOKE_PHASE: "cold", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d: Buffer) => {
      log += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      log += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const line = log.split("\n").find((l) => l.startsWith(RESULT));
      done({
        exitCode,
        log,
        result: line
          ? (JSON.parse(line.slice(RESULT.length)) as Record<string, unknown>)
          : undefined,
      });
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), "matters-erase-smoke-"));
const userData = join(scratch, "Matters");
const earlier = join(scratch, "@unclosed", "desktop");
const temp = join(scratch, "tmp");
const keychainLog = join(scratch, "keychain.log");
const failures: string[] = [];
const report: Record<string, unknown> = {};
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
/** A run that did not end on its own with 0 failed, whatever it printed before. */
const exited = (run: Run, what: string) =>
  check(run.exitCode === 0, `${what} failed (exit ${run.exitCode}): ${run.log.slice(-400)}`);
const order = (earlierCopy: boolean) =>
  writeFileSync(
    join(userData, ORDER),
    JSON.stringify({ version: 1, at: new Date().toISOString(), earlierCopy, permissionPages: [] }),
  );
const tempFolders = () => {
  mkdirSync(join(temp, "matters-agent-smoke1"), { recursive: true });
  writeFileSync(join(temp, "matters-agent-smoke1", "prompt.txt"), "a turn");
  mkdirSync(join(temp, "matters-codex-smoke2"), { recursive: true });
  mkdirSync(join(temp, "another-program"), { recursive: true });
  writeFileSync(join(temp, "another-program", "keep.txt"), "not Matters'");
};
const eraseEnv = {
  MATTERS_USER_DATA: userData,
  MATTERS_OLD_USER_DATA: earlier,
  MATTERS_ERASE_TEMP_DIR: temp,
  MATTERS_ERASE_KEYCHAIN_LOG: keychainLog,
  MATTERS_SMOKE_TIMEOUT_MS: "60000",
};

try {
  // 1. A seeded run on its own folder. No old folder is named: nothing is moved in.
  const seeded = await runApp({
    MATTERS_USER_DATA: userData,
    MATTERS_SEED: "1",
    MATTERS_SMOKE_TIMEOUT_MS: "70000",
  });
  check(seeded.exitCode === 0, `the seeded run failed (exit ${seeded.exitCode})`);
  const { ALL_HOLDINGS } = await import("../apps/desktop/src/main/holdings.ts");
  const { undeclaredEntries } = await import("../packages/core/src/domain/holdings.ts");
  const entries = readdirSync(userData).sort();
  const undeclared = undeclaredEntries(ALL_HOLDINGS, entries, "matters.db");
  report.seededEntries = entries.length;
  check(undeclared.length === 0, `undeclared entries in the data folder: ${undeclared.join(", ")}`);

  // A restore waiting for the next start and a database a restore set aside (ADR 0145): declared,
  // and erased with the mail. Fakes: no start between here and the erase runs the swap.
  const restore = join(userData, "restore");
  mkdirSync(join(restore, "set-aside", "20261116T153000Z"), { recursive: true });
  writeFileSync(join(restore, "pending.db"), "a restore waiting (a fake)");
  writeFileSync(join(restore, "pending.json"), "{}");
  writeFileSync(join(restore, "held.json"), '["acc1"]');
  writeFileSync(join(restore, "set-aside", "20261116T153000Z", "matters.db"), "set aside (a fake)");
  const withRestore = undeclaredEntries(ALL_HOLDINGS, readdirSync(userData).sort(), "matters.db");
  check(withRestore.length === 0, `the restore folder is not declared: ${withRestore.join(", ")}`);

  // 2. A fake earlier copy, and the marker a finished move leaves.
  mkdirSync(earlier, { recursive: true });
  writeFileSync(join(earlier, "unclosed.db"), "the old mailbox (a fake)");
  writeFileSync(
    join(userData, MARKER),
    JSON.stringify({ version: 1, state: "done", from: earlier, at: new Date().toISOString() }),
  );
  tempFolders();

  // 3. The erase, the earlier copy kept.
  order(false);
  const erase = await runApp(eraseEnv);
  report.erase = erase.result;
  check(erase.exitCode === 0, `the erase run failed (exit ${erase.exitCode})`);
  check(erase.result?.ok === true, `the erase left things: ${JSON.stringify(erase.result?.left)}`);
  check(
    JSON.stringify(readdirSync(userData)) === JSON.stringify([MARKER]),
    `the data folder holds more than the marker: ${readdirSync(userData).join(", ")}`,
  );
  check(
    JSON.parse(readFileSync(join(userData, MARKER), "utf8")).state === "done",
    "the marker is not done",
  );
  check(!existsSync(restore), "the waiting restore or the set-aside database stayed");
  check(existsSync(join(earlier, "unclosed.db")), "the earlier copy was touched");
  check(!existsSync(join(temp, "matters-agent-smoke1")), "an agent's temp folder stayed");
  check(!existsSync(join(temp, "matters-codex-smoke2")), "a codex temp folder stayed");
  check(existsSync(join(temp, "another-program", "keep.txt")), "another program's folder went");
  const asked = existsSync(keychainLog) ? readFileSync(keychainLog, "utf8") : "";
  check(/remove matters-smoke-key/.test(asked), "the key store was not asked for the key");
  check(!/remove matters-smoke-earlier-key/.test(asked), "the earlier key was asked for");

  // 4. The next start: an empty mailbox, and the earlier copy not brought back in.
  const next = await runApp({ ...eraseEnv, MATTERS_SMOKE_TIMEOUT_MS: "12000" }, 40_000);
  report.nextExit = next.exitCode;
  // Its smoke scenarios need mail, so on the empty mailbox it ends with 1; it must end on its own.
  check(next.exitCode !== null, `the next start did not end on its own: ${next.log.slice(-400)}`);
  check(!/matters-identity: copied/.test(next.log), "the next start copied the earlier copy in");
  check(!existsSync(join(userData, ORDER)), "the order came back");
  const dbPath = join(userData, "matters.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    report.nextAccounts = n("SELECT COUNT(*) AS n FROM accounts");
    report.nextMessages = n("SELECT COUNT(*) AS n FROM messages");
    db.close();
    check(report.nextAccounts === 0, "the next start has accounts");
    check(report.nextMessages === 0, "the next start has mail");
  } else {
    failures.push(`the next start made no database: ${next.log.slice(-400)}`);
  }

  // 5. The erase with the earlier copy: nothing at all is left, and both keys were asked for.
  rmSync(keychainLog, { force: true });
  order(true);
  const all = await runApp(eraseEnv);
  report.eraseAll = all.result;
  exited(all, "the full erase run");
  check(all.result?.ok === true, `the full erase left things: ${JSON.stringify(all.result?.left)}`);
  check(all.result?.earlierCopy === true, "the full erase did not take the earlier copy");
  check(!existsSync(userData), "the data folder stayed");
  check(!existsSync(earlier), "the earlier copy stayed");
  const askedAll = existsSync(keychainLog) ? readFileSync(keychainLog, "utf8") : "";
  check(/remove matters-smoke-earlier-key/.test(askedAll), "the earlier key was not asked for");

  // 6. An order that cannot be read: nothing starts, nothing goes.
  rmSync(keychainLog, { force: true });
  const blocked = join(scratch, "Blocked");
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, "credentials.json"), "a vault (a fake)");
  writeFileSync(join(blocked, ORDER), "{}");
  chmodSync(join(blocked, ORDER), 0o000);
  try {
    const unreadable = await runApp({ ...eraseEnv, MATTERS_USER_DATA: blocked }, 40_000);
    const line = unreadable.log.split("\n").find((l) => l.startsWith(UNREADABLE));
    report.unreadable = line ? JSON.parse(line.slice(UNREADABLE.length)) : undefined;
    check(unreadable.exitCode === 1, `the unreadable start ended with ${unreadable.exitCode}`);
    check(
      (report.unreadable as { code?: unknown } | undefined)?.code === "EACCES",
      `the unreadable start did not say why: ${unreadable.log.slice(-400)}`,
    );
    check(!unreadable.result, "the unreadable start erased");
    check(
      JSON.stringify(readdirSync(blocked).sort()) === JSON.stringify(["credentials.json", ORDER]),
      `the unreadable start changed the folder: ${readdirSync(blocked).join(", ")}`,
    );
    check(!existsSync(keychainLog), "the unreadable start asked the key store");
  } finally {
    chmodSync(join(blocked, ORDER), 0o600);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`smoke-erase failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("smoke-erase passed");
