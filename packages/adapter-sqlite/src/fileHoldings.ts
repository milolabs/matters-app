// The database's files, declared apart from its tables so that main can read the list without
// loading the database code (ADR 0138, rule 2).
import type { Holding } from "@matters/core";

/** The files named after the database: the log, the shared memory, the owner (ADR 0110). */
export const DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal", ".owner"] as const;

export const SQLITE_FILE_HOLDINGS: readonly Holding[] = DATABASE_SUFFIXES.map(
  (suffix): Holding => ({
    id: `sqlite.file${suffix}`,
    group: "mail",
    place: { kind: "database", suffix },
    step: "database",
  }),
);
