// Launch benchmark: how long a person waits from starting the app to seeing their mail.
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/bench-launch.ts [--sizes 8000,100000,500000]
//   [--runs 7] [--modes first,repeat] [--json out.json] [--fresh] [--db copy.db] [--settle-ms 1000]
//   (--db measures a copy of a real database, with --modes repeat; ADR 0070, rule 5. Needs `electron-vite build` first; root script:
//   `bench:launch`, which does both).
//   The slow start (ADR 0103), each dev-only and inert in a packaged app, like the trace itself:
//     --never-ready    the page never says its first screen is ready, so the loading screen shows at
//                      the deadline and stays (ADR 0070 forced the page the same way).
//     --force-wait     the backend waits for the worker instead of reading at once (`reader-wait`).
//     --rewind-schema  each launch gets a clone of the database with its newest schema step undone,
//                      so the worker really updates it. Valid only while that step can run again on
//                      a database that already has it (version 46 can: it checks before it adds).
//     --theme dark|light, --shot file.png [--shot-ms 1500]  a picture of the loading screen.
//
// What is measured. For each mailbox size the tool builds one database (cached under the temp
// directory, so later runs and later sizes reuse it; --fresh rebuilds), then starts the built
// app `runs` times as a separate OS process with a real, visible window. The clock starts in
// this driver immediately before `spawn` and stops at the first frame in which the list's rows
// are painted (the page marks it after a requestAnimationFrame, from a message task that runs
// after that frame). All processes share one epoch clock (`performance.timeOrigin +
// performance.now()`), so the timeline is exact to well under a millisecond, with none of the
// Date.now() - process.uptime() guessing smoke mode relies on. Phases come from a dev-only trace
// hook (apps/desktop/src/backend/trace.ts) that main enables only when `!app.isPackaged` and this tool
// names a file; in a packaged app it writes nothing.
//
// Two cases are reported separately:
//   first launch  - a new, empty userData each run: no Chromium or V8 caches, no window state.
//   repeat launch - one userData, primed by an untimed launch, then `runs` timed ones.
//
// What this cannot do. A truly OS page-cache-cold start (after a reboot, or `purge` as root) can
// not be forced without sudo, so every number here has a warm page cache for the Electron binary,
// the app's files and the database: "first launch" means empty app caches, not an empty OS
// cache. A real cold boot is slower by whatever the disk costs. The app runs on this machine
// alongside whatever else it is doing; run nothing heavy during a measurement. The demo account
// of the generated mailbox points nowhere (it never connects), so no mail server is involved.
//
// The database is opened as any other: it is not seeded, MATTERS_SEED is not set.
import { spawn } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  generateMailbox,
  seedDemoAccount,
  seedDemoFolders,
  seedDemoViews,
} from "../apps/desktop/src/backend/seed.ts";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
} from "../packages/adapter-sqlite/src/index.ts";
import { ingestDocuments, MESSAGE_KEY_SEQ_LIMIT, messageKey } from "../packages/core/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SIZES = (arg("sizes") ?? "8000,100000,500000").split(",").map(Number);
const RUNS = Number(arg("runs") ?? 7);
const JSON_OUT = arg("json");
const FRESH = process.argv.includes("--fresh");
const MODES = (arg("modes") ?? "first,repeat").split(",");
// A database of your own instead of a generated one (a copy: the app writes to it), and how long
// after the rows to stay, for what comes after them: the open thread, the agent's column.
const DB = arg("db");
const SETTLE_MS = arg("settle-ms");
const NEVER_READY = process.argv.includes("--never-ready");
const FORCE_WAIT = process.argv.includes("--force-wait");
const REWIND = process.argv.includes("--rewind-schema");
const THEME = arg("theme");
const SHOT = arg("shot");
const SHOT_MS = arg("shot-ms");
const RUN_TIMEOUT_MS = 60_000;
/** Bump when the generator changes, so a cached database is rebuilt. */
const GENERATOR = 2;

const cacheRoot = join(tmpdir(), "matters-bench-launch");

// --- the database -----------------------------------------------------------------------------

const CHUNK = 8_000;
const BATCH = 2_000;

async function buildDatabase(path: string, messages: number): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const storage = createSqliteStorage(path);
  const deps = {
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    uow: storage.uow,
  };
  let written = 0;
  // Keys are dateMs * 1024 + seq (ADR 0006) and must be unique across chunks.
  const nextSeq = new Map<number, number>();
  const uniqueKey = (dateMs: number): { dateMs: number; key: number } => {
    let at = dateMs;
    for (;;) {
      const seq = nextSeq.get(at) ?? 0;
      if (seq < MESSAGE_KEY_SEQ_LIMIT) {
        nextSeq.set(at, seq + 1);
        return { dateMs: at, key: messageKey(at, seq) };
      }
      at -= 1;
    }
  };
  for (let chunk = 0; written < messages; chunk++) {
    const count = Math.min(CHUNK, messages - written);
    // ~4 messages a thread, like the demo mailbox; every chunk is its own set of threads.
    const docs = generateMailbox({
      messages: count,
      threads: Math.max(1, Math.floor(count / 4)),
      seed: chunk + 1,
    }).map((d) => ({
      ...d,
      message: {
        ...d.message,
        ...uniqueKey(d.message.dateMs),
        providerId: `c${chunk}-${d.message.providerId}`,
        threadId: `c${chunk}-${d.message.threadId}`,
        messageIdHeader: `<c${chunk}-${d.message.providerId}@bench.example>`,
      },
    }));
    for (let i = 0; i < docs.length; i += BATCH) {
      await ingestDocuments(deps, docs.slice(i, i + BATCH));
    }
    written += count;
    process.stderr.write(`  ${written}/${messages}\r`);
  }
  await seedDemoAccount(storage.accounts);
  await seedDemoFolders(storage.store);
  await seedDemoViews(storage.views);
  storage.close();
  // Leave one self-contained file, as an app that quit cleanly does.
  const db = new DatabaseSync(path);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  process.stderr.write("\n");
}

async function ensureDatabase(messages: number): Promise<string> {
  const dir = join(cacheRoot, String(messages));
  const path = join(dir, "matters.db");
  const stamp = join(dir, "stamp.json");
  const want = JSON.stringify({ messages, schema: LATEST_SCHEMA_VERSION, generator: GENERATOR });
  if (!FRESH && existsSync(stamp) && readFileSync(stamp, "utf8") === want && existsSync(path)) {
    return path;
  }
  rmSync(dir, { recursive: true, force: true });
  const t0 = performance.now();
  console.error(`building a ${messages}-message database in ${dir}`);
  await buildDatabase(path, messages);
  writeFileSync(stamp, want);
  console.error(
    `  built in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${(statSync(path).size / 1e6).toFixed(0)} MB`,
  );
  return path;
}

// --- one launch -------------------------------------------------------------------------------

type Timeline = Record<string, number>;

interface Launch {
  readonly timeline: Timeline;
  readonly exitCode: number | null;
}

const now = () => performance.timeOrigin + performance.now();

/**
 * A clone of the database (APFS makes it cheap) whose newest schema step is undone, so that the app
 * has a real update to run (--rewind-schema). The clone sits next to the userData and goes with it.
 */
function rewound(dbPath: string, dir: string): string {
  const path = join(dir, "rewound.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix))
      copyFileSync(dbPath + suffix, path + suffix, constants.COPYFILE_FICLONE);
  }
  const db = new DatabaseSync(path);
  db.prepare("DELETE FROM schema_version WHERE version = ?").run(LATEST_SCHEMA_VERSION);
  db.close();
  return path;
}

function launch(source: string, userData: string): Promise<Launch> {
  const dbPath = REWIND ? rewound(source, join(userData, "..")) : source;
  return new Promise((done) => {
    const traceFile = join(
      userData,
      "..",
      `trace-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
    );
    // The app must start as Electron, not as a plain Node runtime.
    const { ELECTRON_RUN_AS_NODE: _a, MATTERS_SEED: _b, MATTERS_SMOKE: _c, ...env } = process.env;
    const t0 = now();
    const child = spawn(process.execPath, [join(root, "apps/desktop")], {
      env: {
        ...env,
        MATTERS_DB_PATH: dbPath,
        MATTERS_USER_DATA: userData,
        MATTERS_TRACE_FILE: traceFile,
        MATTERS_TRACE_EXIT: "1",
        ...(SETTLE_MS ? { MATTERS_TRACE_EXIT_MS: SETTLE_MS } : {}),
        ...(NEVER_READY ? { MATTERS_TRACE_NEVER_READY: "1" } : {}),
        ...(FORCE_WAIT ? { MATTERS_TRACE_WAIT: "1" } : {}),
        ...(THEME ? { MATTERS_TRACE_THEME: THEME } : {}),
        ...(SHOT ? { MATTERS_TRACE_SHOT: resolve(SHOT) } : {}),
        ...(SHOT_MS ? { MATTERS_TRACE_SHOT_MS: SHOT_MS } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (d: Buffer) => {
      errors += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const timeline: Timeline = { spawn: 0 };
      if (existsSync(traceFile)) {
        for (const line of readFileSync(traceFile, "utf8").split("\n")) {
          const [name, at] = line.split(" ");
          // The first time a phase was reached is the one that counts.
          if (name && at && timeline[name] === undefined) timeline[name] = Number(at) - t0;
        }
        rmSync(traceFile, { force: true });
      }
      if (exitCode !== 0 && errors) console.error(errors.split("\n").slice(0, 8).join("\n"));
      if (REWIND) {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
      }
      done({ timeline, exitCode });
    });
  });
}

// --- statistics -------------------------------------------------------------------------------

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] as number;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const fmt = (n: number) => String(Math.round(n)).padStart(5);

/** The first moment something other than the window's background was painted. */
const firstPaint = (t: Timeline): number | undefined => {
  const candidates = [t["first-paint"], t["first-contentful-paint"]].filter(
    (x): x is number => x !== undefined,
  );
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
};

const PHASES = [
  "process-created",
  "main-start",
  "main-ready",
  "window-created",
  "backend-fork",
  "backend-spawned",
  "page-load-start",
  "backend-script-start",
  "backend-imports-done",
  "worker-script-start",
  "worker-imports-done",
  "worker-db-open",
  "worker-ready",
  "reader-open",
  "reader-open-early",
  "reader-wait",
  "boot-stage-opening",
  "boot-stage-updating",
  "boot-stage-ready",
  "script-start-received",
  "publisher-ready",
  "backend-ready",
  "page-dom-ready",
  "renderer-script-start",
  "port-received",
  "first-request",
  "first-answer",
  "rows-in-dom",
  "window-ready-to-show",
  "first-paint",
  "first-contentful-paint",
  "rows-painted",
  "page-load-finished",
  "read-thread-script-start",
  "read-thread-ready",
  "read-thread-answer",
  "stores-ready",
  "first-screen",
  "window-shown",
  "boot-shown",
  "boot-hidden",
  "boot-shot",
  "thread-open",
  "agent-ready",
];

interface Summary {
  readonly size: number;
  readonly mode: "first" | "repeat";
  readonly runs: number;
  readonly failed: number;
  readonly paint: { median: number; p95: number; min: number };
  readonly rows: { median: number; p95: number; min: number };
  readonly phases: Record<string, number>;
  /** Launches that showed the loading screen, and how long it was on screen (ADR 0103). */
  readonly loader: { shown: number; median?: number; min?: number };
}

function summarise(size: number, mode: "first" | "repeat", launches: Launch[]): Summary {
  const good = launches.filter((l) => l.exitCode === 0 && l.timeline["rows-painted"] !== undefined);
  const stat = (xs: number[]) => ({
    median: median(xs),
    p95: quantile(xs, 0.95),
    min: Math.min(...xs),
  });
  const rows = good.map((l) => l.timeline["rows-painted"] as number);
  const paint = good.map((l) => firstPaint(l.timeline) ?? (l.timeline["rows-painted"] as number));
  const phases: Record<string, number> = {};
  for (const name of [
    ...PHASES,
    "LOAF-start",
    "LOAF-renderStart",
    "LOAF-styleLayoutStart",
    "LOAF-end",
  ]) {
    const xs = good.map((l) => l.timeline[name]).filter((x): x is number => x !== undefined);
    if (xs.length > 0) phases[name] = median(xs);
  }
  const seen = good.filter((l) => l.timeline["boot-shown"] !== undefined);
  const onScreen = seen
    .map((l) => (l.timeline["boot-hidden"] ?? Number.NaN) - (l.timeline["boot-shown"] as number))
    .filter((x) => Number.isFinite(x));
  return {
    loader: {
      shown: seen.length,
      ...(onScreen.length > 0 ? { median: median(onScreen), min: Math.min(...onScreen) } : {}),
    },
    size,
    mode,
    runs: good.length,
    failed: launches.length - good.length,
    paint: stat(paint),
    rows: stat(rows),
    phases,
  };
}

function print(s: Summary): void {
  console.log(`\n== ${s.size} messages, ${s.mode} launch (${s.runs} runs, ${s.failed} failed) ==`);
  console.log("                                  median    p95    min   (ms from spawn)");
  console.log(
    `launch -> first paint of anything ${fmt(s.paint.median)} ${fmt(s.paint.p95)} ${fmt(s.paint.min)}`,
  );
  console.log(
    `launch -> list rows painted       ${fmt(s.rows.median)} ${fmt(s.rows.p95)} ${fmt(s.rows.min)}`,
  );
  if (s.loader.shown > 0) {
    const how =
      s.loader.median === undefined
        ? "and it stayed"
        : `on screen ${Math.round(s.loader.median)} ms median, ${Math.round(s.loader.min ?? 0)} ms least`;
    console.log(`loading screen shown in ${s.loader.shown} of ${s.runs} runs, ${how}`);
  }
  console.log("phase timeline (median):");
  for (const [name, at] of Object.entries(s.phases).sort((a, b) => a[1] - b[1])) {
    console.log(`  ${fmt(at)}  ${name}`);
  }
}

// --- main -------------------------------------------------------------------------------------

const results: Summary[] = [];
const scratch = mkdtempSync(join(tmpdir(), "matters-bench-run-"));
try {
  for (const size of SIZES) {
    const dbPath = DB ?? (await ensureDatabase(size));
    console.error(`${size}: ${(statSync(dbPath).size / 1e6).toFixed(0)} MB`);

    if (MODES.includes("first")) {
      const first: Launch[] = [];
      for (let i = 0; i < RUNS; i++) {
        const userData = join(scratch, `first-${size}-${i}`, "userData");
        mkdirSync(userData, { recursive: true });
        first.push(await launch(dbPath, userData));
        rmSync(join(userData, ".."), { recursive: true, force: true });
      }
      results.push(summarise(size, "first", first));
      print(results[results.length - 1] as Summary);
    }

    if (MODES.includes("repeat")) {
      const userData = join(scratch, `repeat-${size}`, "userData");
      mkdirSync(userData, { recursive: true });
      await launch(dbPath, userData); // priming launch, not counted
      const repeat: Launch[] = [];
      for (let i = 0; i < RUNS; i++) repeat.push(await launch(dbPath, userData));
      results.push(summarise(size, "repeat", repeat));
      print(results[results.length - 1] as Summary);
      rmSync(join(userData, ".."), { recursive: true, force: true });
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
process.exit(results.some((r) => r.failed > 0 || r.runs === 0) ? 1 : 0);
