// Backup benchmark (ADR 0145, rule 6): what a backup and the checks of a restore cost on a
// generated mailbox, the one the launch benchmark builds (same generator, same sizes).
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/bench-backup.ts [--sizes 100000,500000] [--fresh]
//
// For each size it builds one database (cached under the temp directory, as bench-launch does),
// then measures:
//   - the copy: `VACUUM INTO` on a read-only connection in a process of its own (as the app runs
//     it), its time, the copy's size and the copying process's peak memory;
//   - the copy while this process writes, as a sync does: a batch every 50 ms on the writer
//     connection. The batches' time before and during the copy, and how large the log grew;
//   - the restore's checks of the copy: the schema read and compared, the integrity check, and the
//     preparation (migrations, the outbox held).
// It never touches a real database: every file is in the temp directory.
import { spawn } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  generateMailbox,
  seedDemoAccount,
  seedDemoFolders,
  seedDemoViews,
} from "../apps/desktop/src/backend/seed.ts";
import {
  checkBackup,
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  prepareRestore,
} from "../packages/adapter-sqlite/src/index.ts";
import { ingestDocuments, MESSAGE_KEY_SEQ_LIMIT, messageKey } from "../packages/core/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SIZES = (arg("sizes") ?? "100000,500000").split(",").map(Number);
const FRESH = process.argv.includes("--fresh");
const GENERATOR = 2;
const cacheRoot = join(tmpdir(), "matters-bench-backup");

async function buildDatabase(path: string, messages: number): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const storage = createSqliteStorage(path);
  const deps = {
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    uow: storage.uow,
  };
  const nextSeq = new Map<number, number>();
  const uniqueKey = (dateMs: number) => {
    for (let at = dateMs; ; at -= 1) {
      const seq = nextSeq.get(at) ?? 0;
      if (seq < MESSAGE_KEY_SEQ_LIMIT) {
        nextSeq.set(at, seq + 1);
        return { dateMs: at, key: messageKey(at, seq) };
      }
    }
  };
  let written = 0;
  for (let chunk = 0; written < messages; chunk++) {
    const count = Math.min(8000, messages - written);
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
    for (let i = 0; i < docs.length; i += 2000)
      await ingestDocuments(deps, docs.slice(i, i + 2000));
    written += count;
    process.stderr.write(`  ${written}/${messages}\r`);
  }
  await seedDemoAccount(storage.accounts);
  await seedDemoFolders(storage.store);
  await seedDemoViews(storage.views);
  storage.close();
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
  if (!FRESH && existsSync(stamp) && readFileSync(stamp, "utf8") === want && existsSync(path))
    return path;
  rmSync(dir, { recursive: true, force: true });
  console.error(`building a ${messages}-message database in ${dir}`);
  const t0 = performance.now();
  await buildDatabase(path, messages);
  writeFileSync(stamp, want);
  console.error(`  built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return path;
}

/** The copy in a process of its own, as the app runs it; resolves with its time and peak memory. */
function copyInChild(source: string, target: string): Promise<{ ms: number; peakRssMb: number }> {
  rmSync(target, { force: true });
  const child = join(here, "bench-backup-child.ts");
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const p = spawn(process.execPath, [child, source, target], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d) => {
      out += String(d);
    });
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`the copy exited with ${code}`));
      const { peakRssMb } = JSON.parse(out) as { peakRssMb: number };
      resolvePromise({ ms: performance.now() - started, peakRssMb });
    });
  });
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function measure(messages: number) {
  const source = await ensureDatabase(messages);
  const work = join(cacheRoot, `${messages}-run`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const live = join(work, "matters.db");
  // A clone of the cached database, so the writes below never change the cache.
  spawnSyncCopy(source, live);
  const size = statSync(live).size;

  // Quiet copy.
  const quiet = await copyInChild(live, join(work, "quiet.db"));
  const copySize = statSync(join(work, "quiet.db")).size;

  // Copy while the writer writes a batch every 50 ms, as a sync does.
  const writer = openDatabase(live);
  writer.exec("CREATE TABLE IF NOT EXISTS bench_writes (id INTEGER PRIMARY KEY, body TEXT)");
  const insert = writer.prepare("INSERT INTO bench_writes (body) VALUES (?)");
  const body = "x".repeat(2000);
  const batch = () => {
    const t = performance.now();
    writer.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 200; i++) insert.run(body);
    writer.exec("COMMIT");
    return performance.now() - t;
  };
  const before: number[] = [];
  for (let i = 0; i < 40; i++) {
    before.push(batch());
    await new Promise((r) => setTimeout(r, 50));
  }
  const during: number[] = [];
  let walMax = 0;
  let copying = true;
  const loop = (async () => {
    while (copying) {
      during.push(batch());
      try {
        walMax = Math.max(walMax, statSync(`${live}-wal`).size);
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const busy = await copyInChild(live, join(work, "busy.db"));
  copying = false;
  await loop;
  writer.close();

  // The restore's checks, on the quiet copy.
  let t = performance.now();
  const verdict = checkBackup(join(work, "quiet.db"));
  const checkMs = performance.now() - t;
  t = performance.now();
  prepareRestore(join(work, "quiet.db"), Date.now());
  const prepareMs = performance.now() - t;

  rmSync(work, { recursive: true, force: true });
  return {
    messages,
    databaseMb: Math.round(size / 1e6),
    copyMb: Math.round(copySize / 1e6),
    copyQuietS: +(quiet.ms / 1000).toFixed(1),
    copyPeakRssMb: quiet.peakRssMb,
    copyWhileWritingS: +(busy.ms / 1000).toFixed(1),
    batchesDuringCopy: during.length,
    writeBatchMsBefore: { p50: +pct(before, 50).toFixed(1), p99: +pct(before, 99).toFixed(1) },
    writeBatchMsDuring: { p50: +pct(during, 50).toFixed(1), p99: +pct(during, 99).toFixed(1) },
    walMaxMb: Math.round(walMax / 1e6),
    restoreCheck: verdict.kind,
    restoreCheckS: +(checkMs / 1000).toFixed(1),
    restorePrepareS: +(prepareMs / 1000).toFixed(1),
  };
}

function spawnSyncCopy(from: string, to: string): void {
  // APFS clone where possible: the cached database stays as it is.
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
}

for (const n of SIZES) console.log(JSON.stringify(await measure(n)));
