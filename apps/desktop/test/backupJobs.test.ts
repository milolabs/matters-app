import { constants, mkdtempSync, rmSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  checkBackup,
  consolidateDatabase,
  copyDatabase,
  currentConnections,
  openDatabase,
  prepareRestore,
} from "@matters/adapter-sqlite";
import { accountsToHold } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import { type BackupDeps, BackupJobs, type WorkerRun } from "../src/main/backupJobs.ts";
import { restorePaths, swapPendingRestore } from "../src/main/restore.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The worker's jobs, run here: the same adapter calls the worker process makes. */
function inline(job: Parameters<BackupDeps["work"]>[0]): unknown {
  switch (job.kind) {
    case "copy":
      copyDatabase(job.source, job.target);
      return { ok: true };
    case "consolidate":
      consolidateDatabase(job.path);
      return { ok: true };
    case "check": {
      const verdict = checkBackup(job.path);
      if (verdict.kind !== "restorable") return { ok: true, verdict };
      const { connections, ...prepared } = prepareRestore(job.path, 1);
      return {
        ok: true,
        verdict,
        prepared,
        holdAccounts: accountsToHold(connections, currentConnections(job.current)),
      };
    }
  }
}

function setup(over: Partial<BackupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "matters-backups-"));
  dirs.push(dir);
  const data = join(dir, "data");
  const out = join(dir, "Documents");
  const databasePath = join(data, "matters.db");
  const killed: string[] = [];
  const deps: BackupDeps = {
    databasePath,
    chooseSavePath: async (name) => join(out, name),
    chooseBackupFile: async () => join(out, "Matters backup 2026-11-16.db"),
    work: (job): WorkerRun => ({
      answer: new Promise((resolve) => setImmediate(() => resolve(inline(job)))),
      kill: () => void killed.push(job.kind),
    }),
    fs: {
      createPrivate: async (path) => (await open(path, "wx", 0o600)).close(),
      sync: async () => {},
      rename: (a, b) => rename(a, b),
      remove: (p) => rm(p, { force: true }),
      copyIn: async (a, b) => {
        await copyFile(a, b, constants.COPYFILE_EXCL);
        await chmod(b, 0o600);
      },
      size: (p) =>
        stat(p).then(
          (s) => s.size,
          () => 0,
        ),
      mkdir: async (p) => void (await mkdir(p, { recursive: true })),
      chmodPrivate: (p) => chmod(p, 0o600),
    },
    now: () => Date.UTC(2026, 10, 16, 15, 30),
    dayOf: () => "2026-11-16",
    log: () => {},
    ...over,
  };
  return { dir, data, out, databasePath, killed, deps };
}

async function seed(t: ReturnType<typeof setup>, viewName: string) {
  await mkdir(t.data, { recursive: true });
  await mkdir(t.out, { recursive: true });
  const db = openDatabase(t.databasePath);
  db.prepare(
    `INSERT INTO accounts (id, address, display_name, transport, imap_host, imap_port,
                           imap_security, imap_username, created_at_ms)
     VALUES ('a1', 'me@example.com', 'Me', 'imap', 'imap.example.com', 993, 'tls', 'me', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms)
     VALUES ('v1', ?, 'is:unread', 50, 1, 1)`,
  ).run(viewName);
  return db;
}

const viewsOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db.prepare("SELECT name FROM saved_views WHERE id = 'v1'").all() as { name: string }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
};

describe("Back Up… (ADR 0145, rules 6 and 7)", () => {
  it("writes one consistent copy under the day's name, readable by the person alone", async () => {
    const t = setup();
    const live = await seed(t, "Before");
    const jobs = new BackupJobs(t.deps);
    const answer = await jobs.backup();
    live.close();
    expect(answer).toMatchObject({ kind: "done", name: "Matters backup 2026-11-16.db" });
    const target = join(t.out, "Matters backup 2026-11-16.db");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(t.out)).toEqual(["Matters backup 2026-11-16.db"]);
    expect(checkBackup(target)).toMatchObject({ kind: "restorable" });
    expect(viewsOf(target)).toEqual(["Before"]);
  });

  it("leaves nothing under the name, and no temporary file, when stopped or when it fails", async () => {
    const t = setup();
    const live = await seed(t, "x");
    const stopping = setup({
      ...t.deps,
      work: (job) => ({
        answer: new Promise((resolve) => setTimeout(() => resolve(inline(job)), 20)),
        kill: () => void t.killed.push(job.kind),
      }),
    });
    const jobs = new BackupJobs(stopping.deps);
    const running = jobs.backup();
    await new Promise((r) => setTimeout(r, 5));
    expect(await jobs.state()).toMatchObject({ kind: "backingUp" });
    jobs.stop();
    expect(await running).toEqual({ kind: "stopped" });
    expect(t.killed).toEqual(["copy"]);
    expect(await readdir(t.out)).toEqual([]);

    const failing = new BackupJobs({
      ...t.deps,
      work: () => ({
        answer: Promise.resolve({ ok: false, message: "disk full" }),
        kill: () => {},
      }),
    });
    expect(await failing.backup()).toMatchObject({ kind: "failed" });
    expect(await readdir(t.out)).toEqual([]);
    live.close();
  });

  it("asks where first: a cancelled dialog writes nothing", async () => {
    const t = setup({ chooseSavePath: async () => undefined });
    await seed(t, "x").then((db) => db.close());
    expect(await new BackupJobs(t.deps).backup()).toEqual({ kind: "cancelled" });
  });
});

describe("Restore from a Backup… (ADR 0145, rules 8 to 10)", () => {
  it("backs up, changes, restores at the next start, and keeps what was there set aside", async () => {
    const t = setup();
    const live = await seed(t, "Before");
    const jobs = new BackupJobs(t.deps);
    expect(await jobs.backup()).toMatchObject({ kind: "done" });
    live.prepare("UPDATE saved_views SET name = 'After' WHERE id = 'v1'").run();
    live.close();

    const ready = await jobs.restore();
    expect(ready).toMatchObject({
      kind: "ready",
      pending: { accounts: 1, heldSends: 0, holdAccounts: [] },
    });
    expect((await jobs.overview()).pending).not.toBeNull();
    // The person's file is untouched, and nothing changed yet.
    expect(viewsOf(join(t.out, "Matters backup 2026-11-16.db"))).toEqual(["Before"]);
    expect(viewsOf(t.databasePath)).toEqual(["After"]);

    // The next start.
    expect(swapPendingRestore(t.databasePath)).toMatchObject({ kind: "swapped" });
    const restored = openDatabase(t.databasePath);
    restored.close();
    expect(viewsOf(t.databasePath)).toEqual(["Before"]);
    const overview = await jobs.overview();
    expect(overview.pending).toBeNull();
    expect(overview.setAside).toHaveLength(1);
    const aside = join(
      restorePaths(t.databasePath).setAside,
      overview.setAside[0]?.name ?? "",
      "matters.db",
    );
    expect(viewsOf(aside)).toEqual(["After"]);

    // And it can be undone: the set-aside database is put back the same way.
    expect(await jobs.restoreSetAside(overview.setAside[0]?.name)).toMatchObject({ kind: "ready" });
  });

  it("refuses a file that is not a backup of Matters, and keeps nothing of it", async () => {
    const t = setup();
    await seed(t, "x").then((db) => db.close());
    await writeFile(
      join(t.out, "Matters backup 2026-11-16.db"),
      "not a database at all, really not",
    );
    const answer = await new BackupJobs(t.deps).restore();
    expect(answer).toMatchObject({ kind: "refused", reason: "notSqlite" });
    expect(await readdir(restorePaths(t.databasePath).dir)).toEqual([]);
  });

  it("refuses a backup carrying a trigger of its own", async () => {
    const t = setup();
    const live = await seed(t, "x");
    const jobs = new BackupJobs(t.deps);
    await jobs.backup();
    live.close();
    const crafted = new DatabaseSync(join(t.out, "Matters backup 2026-11-16.db"));
    crafted.exec("CREATE TRIGGER planted AFTER INSERT ON messages BEGIN DELETE FROM accounts; END");
    crafted.close();
    expect(await jobs.restore()).toMatchObject({ kind: "refused", reason: "schema" });
    expect(await readdir(restorePaths(t.databasePath).dir)).toEqual([]);
  });

  it("holds an account whose server in the backup is not the one here", async () => {
    const t = setup();
    const live = await seed(t, "x");
    const jobs = new BackupJobs(t.deps);
    await jobs.backup();
    live.close();
    const crafted = new DatabaseSync(join(t.out, "Matters backup 2026-11-16.db"));
    crafted.exec("UPDATE accounts SET imap_host = 'imap.evil.example' WHERE id = 'a1'");
    crafted.close();
    expect(await jobs.restore()).toMatchObject({
      kind: "ready",
      pending: { holdAccounts: ["a1"] },
    });
  });

  it("holds what waited in the outbox of the backup (rule 10)", async () => {
    const t = setup();
    const live = await seed(t, "x");
    live
      .prepare(
        `INSERT INTO send_operations (id, account_id, draft_id, summary, state, approval_json,
         attempts, not_before_ms, created_at_ms, updated_at_ms)
       VALUES ('s1', 'a1', 'd1', 'Lunch', 'pending', '{}', 0, 0, 0, 0)`,
      )
      .run();
    const jobs = new BackupJobs(t.deps);
    await jobs.backup();
    live.close();
    expect(await jobs.restore()).toMatchObject({ kind: "ready", pending: { heldSends: 1 } });
    swapPendingRestore(t.databasePath);
    const db = new DatabaseSync(t.databasePath, { readOnly: true });
    expect(db.prepare("SELECT state FROM send_operations").get()).toEqual({ state: "held" });
    db.close();
  });

  it("takes a waiting restore back without touching the database in use", async () => {
    const t = setup();
    const live = await seed(t, "Mine");
    const jobs = new BackupJobs(t.deps);
    await jobs.backup();
    live.close();
    await jobs.restore();
    await jobs.cancelPending();
    expect(swapPendingRestore(t.databasePath)).toEqual({ kind: "none" });
    expect(viewsOf(t.databasePath)).toEqual(["Mine"]);
    expect(await readFile(t.databasePath)).toBeDefined();
  });
});
