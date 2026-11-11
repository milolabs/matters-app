// ADR 0018, rule 7: the ADR 0012 budgets while a large initial sync runs. Starts the Docker
// IMAP test server, fills it with ~5,000 generated messages, starts the built app with a fresh
// database and the account pre-configured through the environment (the password goes into the
// app's safeStorage-backed vault, nowhere else), and lets the page measure search and
// open-thread latency while the sync runs. Needs Docker and `electron-vite build` first; the
// root `smoke:desktop:sync` script does both.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Admin } from "../packages/adapter-imap/test/support/admin.ts";
import { startImapTestServer } from "./imap-test-server/run.ts";
import { buildCorpus, liveMessage } from "./smoke-corpus.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULT = "MATTERS_SMOKE_RESULT ";
const SIGNAL = "MATTERS_SMOKE_SIGNAL ";
const COUNT = Number(process.env.MATTERS_SMOKE_MESSAGES ?? 5000);
const APP_TIMEOUT_MS = 240_000;
// Initial-sync throughput measured before the sync moved to its own thread (ADR 0019): ~2,200
// messages/s. The worker may not cost more than 20 % of it.
const MIN_MESSAGES_PER_SECOND = Number(process.env.MATTERS_SMOKE_MIN_RATE ?? 1760);

const dir = mkdtempSync(join(tmpdir(), "matters-smoke-sync-"));
const server = await startImapTestServer();
const failures: string[] = [];
let exitCode = 1;

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const p = join(path, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

try {
  const admin = await Admin.connect({
    host: server.host,
    port: server.port,
    user: server.user,
    pass: server.password,
  });
  const corpus = buildCorpus(COUNT);
  const fill = performance.now();
  for (const folder of new Set(corpus.map((m) => m.folder))) {
    if (folder !== "INBOX") await admin.createFolder(folder).catch(() => {});
  }
  for (const m of corpus) await admin.append(m.folder, m.raw, m.flags);
  console.error(
    `server filled: ${corpus.length} messages in ${Math.round(performance.now() - fill)} ms`,
  );

  const { ELECTRON_RUN_AS_NODE: _drop, MATTERS_SEED: _seed, ...env } = process.env;
  const child = spawn(process.execPath, [join(root, "apps/desktop")], {
    env: {
      ...env,
      MATTERS_SMOKE: "1",
      MATTERS_SMOKE_MODE: "sync",
      MATTERS_SMOKE_TIMEOUT_MS: String(APP_TIMEOUT_MS - 10_000),
      MATTERS_DB_PATH: join(dir, "matters.db"),
      MATTERS_USER_DATA: join(dir, "userData"),
      MATTERS_ALLOW_INSECURE_IMAP: "1",
      MATTERS_TEST_ACCOUNT: JSON.stringify({
        id: "acc-smoke",
        address: server.user,
        host: server.host,
        port: server.port,
        security: "none",
        username: server.user,
      }),
      MATTERS_TEST_PASSWORD: server.password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  let liveSent = 0;
  const onData = (d: Buffer) => {
    const text = d.toString();
    log += text;
    for (const line of text.split("\n")) {
      if (line.startsWith(`${SIGNAL}append-mail`) && liveSent === 0) {
        liveSent = 3;
        void (async () => {
          for (let n = 1; n <= 3; n++) await admin.append("INBOX", liveMessage(n), []);
        })();
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const killer = setTimeout(() => child.kill("SIGKILL"), APP_TIMEOUT_MS);
  const exit = await new Promise<number | null>((r) => child.on("close", r));
  clearTimeout(killer);
  await admin.close();

  const line = log.split("\n").find((l) => l.startsWith(RESULT));
  const result = line
    ? (JSON.parse(line.slice(RESULT.length)) as Record<string, unknown>)
    : undefined;
  if (!result) failures.push(`no result from the app (exit ${exit})`);
  else if (result.ok !== true) failures.push(`app: ${JSON.stringify(result.failures)}`);
  if (exit !== 0) failures.push(`exit code ${exit}`);

  // Throughput of the first full sync, as the backend logged it.
  const runs = [...log.matchAll(/synced account=\S+ scope=(\w+) documents=(\d+) ms=(\d+)/g)];
  const first = runs.find((m) => m[1] === "full" && Number(m[2]) > 0);
  const throughput = first
    ? {
        documents: Number(first[2]),
        ms: Number(first[3]),
        messagesPerSecond: Math.round(Number(first[2]) / (Number(first[3]) / 1000)),
      }
    : undefined;
  if (!throughput) failures.push("the backend never logged a finished full sync");
  else if (throughput.documents !== COUNT) {
    failures.push(`initial sync stored ${throughput.documents} messages, expected ${COUNT}`);
  } else if (COUNT >= 5000 && throughput.messagesPerSecond < MIN_MESSAGES_PER_SECOND) {
    failures.push(
      `initial sync ran at ${throughput.messagesPerSecond} messages/s, below ${MIN_MESSAGES_PER_SECOND}`,
    );
  }

  // The database holds everything, including the mail delivered during the run.
  const db = new DatabaseSync(join(dir, "matters.db"), { readOnly: true });
  const stored = (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
  db.close();
  if (stored !== COUNT + 3)
    failures.push(`database holds ${stored} messages, expected ${COUNT + 3}`);

  // The password reached the vault only: not a file, not a log.
  const secret = Buffer.from(server.password);
  for (const file of filesUnder(dir)) {
    if (readFileSync(file).includes(secret)) failures.push(`the password is on disk in ${file}`);
  }
  if (log.includes(server.password)) failures.push("the password appears in the app's output");

  console.log(
    JSON.stringify({ ok: failures.length === 0, failures, throughput, app: result }, null, 2),
  );
  if (failures.length > 0) console.error(`--- app output ---\n${log}`);
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  server.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
