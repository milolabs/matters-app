// The backup and restore work (ADR 0145, rules 6 and 8), in a process of its own that main starts
// for one job and ends when it is done or the person stops it. Neither a backup of a large
// database nor the integrity check of a chosen file runs on a thread that answers a window, and a
// stop is immediate: main ends the process, whatever SQLite is in the middle of, and removes what
// it wrote. It gets paths from main and nothing from a page, opens the database read-only for a
// backup, and holds no secrets.
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import {
  checkBackup,
  consolidateDatabase,
  copyDatabase,
  currentConnections,
  prepareRestore,
} from "@matters/adapter-sqlite/backup";
import { accountsToHold } from "@matters/core";

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;

/**
 * A file in WAL mode opens read-only only beside its log and shared memory, which a copy does not
 * have; its own file is whole up to the last checkpoint. Our copy (never the person's file) is
 * marked as a rollback-journal database instead: bytes 18 and 19 of the header, 2 to 1.
 */
function asRollback(path: string): void {
  const fd = openSync(path, "r+");
  try {
    const header = Buffer.alloc(2);
    if (readSync(fd, header, 0, 2, 18) === 2 && header[0] === 2 && header[1] === 2) {
      writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
    }
  } finally {
    closeSync(fd);
  }
}

type Job =
  | { readonly kind: "copy"; readonly source: string; readonly target: string }
  | { readonly kind: "check"; readonly path: string; readonly current: string }
  | { readonly kind: "consolidate"; readonly path: string };

function run(job: Job): unknown {
  switch (job.kind) {
    case "copy":
      copyDatabase(job.source, job.target);
      return { ok: true };
    case "consolidate":
      consolidateDatabase(job.path);
      return { ok: true };
    case "check": {
      asRollback(job.path);
      const verdict = checkBackup(job.path);
      if (verdict.kind !== "restorable") return { ok: true, verdict };
      const { connections, ...prepared } = prepareRestore(job.path, Date.now());
      const holdAccounts = accountsToHold(connections, currentConnections(job.current));
      return { ok: true, verdict, prepared, holdAccounts };
    }
  }
}

parentPort.on("message", ({ data }) => {
  const job = data as Job;
  let answer: unknown;
  try {
    answer = run(job);
  } catch (error) {
    answer = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  parentPort.postMessage(answer);
});
