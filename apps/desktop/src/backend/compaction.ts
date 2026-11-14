// After an account is removed, its deleted rows still sit in the database's free pages, and its
// words in the index's old segments, until the file is rewritten (ADR 0138, rule 6). This merges
// the indexes and compacts, on the sync worker, when the disk has room for the rewrite.
import { stat, statfs } from "node:fs/promises";
import type { SqliteStorage } from "@matters/adapter-sqlite";
import type { CompactionPort } from "@matters/core";

export interface CompactionDeps {
  readonly storage: Pick<SqliteStorage, "accountData" | "storageSamples">;
  readonly dbPath: string;
  /** Bytes free for this process on the database's disk; null when it cannot be read. */
  readonly freeBytes?: (path: string) => Promise<number | null>;
  /** Bytes of the database and its log. */
  readonly databaseBytes?: (path: string) => Promise<number>;
}

async function freeOnDisk(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function sizeWithLog(path: string): Promise<number> {
  let total = 0;
  for (const file of [path, `${path}-wal`]) {
    try {
      total += (await stat(file)).size;
    } catch {
      // Not there: nothing to count.
    }
  }
  return total;
}

/** VACUUM writes a full copy before it drops the old one; the merge rewrites the index too. */
export function databaseCompaction(deps: CompactionDeps): CompactionPort {
  const free = deps.freeBytes ?? freeOnDisk;
  const size = deps.databaseBytes ?? sizeWithLog;
  return {
    async compactAfterRemoval() {
      if (deps.dbPath === ":memory:") return { kind: "compacted", freedBytes: 0 };
      const neededBytes = await size(deps.dbPath);
      const freeBytes = await free(deps.dbPath);
      if (freeBytes !== null && freeBytes < neededBytes) {
        return { kind: "lowDisk", neededBytes, freeBytes };
      }
      try {
        await deps.storage.accountData.mergeIndexes();
        const { freedBytes } = await deps.storage.storageSamples.compact();
        return { kind: "compacted", freedBytes };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // SQLite says SQLITE_FULL when the disk filled up meanwhile; nothing was lost.
        if (/full|disk/i.test(message)) {
          return { kind: "lowDisk", neededBytes, freeBytes: (await free(deps.dbPath)) ?? 0 };
        }
        return { kind: "failed", message };
      }
    },
  };
}
