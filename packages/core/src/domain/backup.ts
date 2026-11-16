// Backing up and restoring what Matters keeps (ADR 0145, rules 6 to 10): the rules as data. What a
// backup file may be restored is decided here from what the SQLite adapter read of it; the adapter
// reads, this judges. A file chosen to restore comes from anywhere, so nothing in it is trusted:
// its schema must be exactly the schema this build's own migrations make for its version.

/** One object of a database's schema, as `sqlite_schema` lists it. */
export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  /** The statement that made it; null for what SQLite makes itself (an automatic index). */
  readonly sql: string | null;
}

/**
 * The statement of an object with its white space made one space, outside quotes too: SQLite
 * keeps a statement as it was written, so two databases made by the same migrations have the same
 * text. Case and quotes are kept: `"x"` and `x` are not the same text, and the comparison stays
 * strict.
 */
export function normalizeSchemaSql(sql: string | null): string | null {
  return sql === null ? null : sql.replace(/\s+/g, " ").trim();
}

/** Tables SQLite makes and keeps itself; a database of ours may or may not have them. */
const SQLITE_OWN: ReadonlyMap<string, string> = new Map([
  ["sqlite_sequence", "CREATE TABLE sqlite_sequence(name,seq)"],
  ["sqlite_stat1", "CREATE TABLE sqlite_stat1(tbl,idx,stat)"],
  ["sqlite_stat4", "CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)"],
]);

const keyOf = (o: SchemaObject) => `${o.type}\u0000${o.name}`;

/** What a database's schema has that the expected one does not, and the other way round. */
export interface SchemaDifference {
  /** In the file and not in our schema of its version, or in it with another statement. */
  readonly unexpected: readonly SchemaObject[];
  /** In our schema of its version and not in the file. */
  readonly missing: readonly SchemaObject[];
}

/**
 * Compares a file's schema with the schema this build makes for the same version (ADR 0145,
 * rule 8). An object counts as the same when its type, name, table and statement (white space
 * aside) are the same. SQLite's own tables (`sqlite_sequence`, the statistics) are allowed with
 * the statements SQLite gives them, since they come and go with use.
 */
export function compareSchema(
  found: readonly SchemaObject[],
  expected: readonly SchemaObject[],
): SchemaDifference {
  const want = new Map(expected.map((o) => [keyOf(o), o]));
  const seen = new Set<string>();
  const unexpected: SchemaObject[] = [];
  for (const object of found) {
    const own = SQLITE_OWN.get(object.name);
    if (own !== undefined && object.type === "table") {
      if (normalizeSchemaSql(object.sql) !== own) unexpected.push(object);
      seen.add(keyOf(object));
      continue;
    }
    const match = want.get(keyOf(object));
    if (
      match === undefined ||
      match.tableName !== object.tableName ||
      normalizeSchemaSql(match.sql) !== normalizeSchemaSql(object.sql)
    ) {
      unexpected.push(object);
    }
    seen.add(keyOf(object));
  }
  const missing = expected.filter((o) => !seen.has(keyOf(o)) && !SQLITE_OWN.has(o.name));
  return { unexpected, missing };
}

/** What the SQLite adapter found when it opened a chosen file read-only (rule 8). */
export type BackupFindings =
  /** The file does not start as an SQLite database does, or SQLite would not open it. */
  | { readonly kind: "notSqlite" }
  /** SQLite opened it, and its integrity check found damage, or could not finish. */
  | { readonly kind: "damaged" }
  /** An SQLite database, whole, with no version of ours: not a database of Matters. */
  | { readonly kind: "foreign" }
  | {
      readonly kind: "read";
      readonly version: number;
      readonly objects: readonly SchemaObject[];
    };

/** Why a file is not restored, as one of a closed set the window has a phrase for. */
export type RestoreRefusal = "notSqlite" | "damaged" | "foreign" | "newer" | "schema";

export type RestoreVerdict =
  | {
      readonly kind: "restorable";
      readonly version: number;
      /** Older than this build: the normal migrations carry it forward before the swap. */
      readonly migrate: boolean;
    }
  | { readonly kind: "refused"; readonly reason: RestoreRefusal; readonly version?: number };

/**
 * Whether a file may be restored (ADR 0145, rule 8). It must be SQLite, whole, carry a version of
 * ours that this build knows (equal or older; newer is refused), and have exactly the schema our
 * own migrations make for that version: any object they do not make (a trigger, a view, an index,
 * a virtual table, a table) or make otherwise is a refusal, and so is one of ours that is missing.
 * `expectedFor` builds our schema of a version; it is asked only for a version this build knows.
 */
export function judgeBackup(
  findings: BackupFindings,
  latestVersion: number,
  expectedFor: (version: number) => readonly SchemaObject[],
): RestoreVerdict {
  if (findings.kind !== "read") return { kind: "refused", reason: findings.kind };
  const { version } = findings;
  if (!Number.isInteger(version) || version < 1) return { kind: "refused", reason: "foreign" };
  if (version > latestVersion) return { kind: "refused", reason: "newer", version };
  const difference = compareSchema(findings.objects, expectedFor(version));
  if (difference.unexpected.length > 0 || difference.missing.length > 0) {
    return { kind: "refused", reason: "schema", version };
  }
  return { kind: "restorable", version, migrate: version < latestVersion };
}

/** The one phrase the window says for a refusal (ADR 0145, rule 8). */
export function restoreRefusalText(reason: RestoreRefusal): string {
  switch (reason) {
    case "notSqlite":
      return "This file is not a backup of Matters: it is not a database.";
    case "damaged":
      return "This backup is damaged, so Matters did not use it.";
    case "foreign":
      return "This database was not made by Matters, so Matters did not use it.";
    case "newer":
      return "This backup was made by a newer version of Matters. Update Matters, then restore it.";
    case "schema":
      return "This backup holds things a backup of Matters never has, so Matters did not use it.";
  }
}

/** The connection of an account as a backup and this Mac each record it (rule 9). */
export interface AccountConnection {
  readonly id: string;
  readonly address: string;
  readonly transport: string;
  readonly imapHost: string | null;
  readonly imapPort: number | null;
  readonly imapSecurity: string | null;
  readonly imapUsername: string | null;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly smtpSecurity: string | null;
  readonly smtpUsername: string | null;
}

const CONNECTION_FIELDS = [
  "address",
  "transport",
  "imapHost",
  "imapPort",
  "imapSecurity",
  "imapUsername",
  "smtpHost",
  "smtpPort",
  "smtpSecurity",
  "smtpUsername",
] as const satisfies readonly (keyof AccountConnection)[];

/**
 * The accounts of a restored database whose saved password or sign-in this Mac does not use until
 * the person enters it again (ADR 0145, rule 9): the vault holds a credential per account id, so
 * an account of the backup with an id that is here too, but another server, user name or address,
 * would otherwise send this Mac's password for that id to the backup's server. An account the
 * database here does not have gets nothing from the vault anyway, so it is not listed.
 */
export function accountsToHold(
  restored: readonly AccountConnection[],
  current: readonly AccountConnection[],
): readonly string[] {
  const here = new Map(current.map((a) => [a.id, a]));
  return restored
    .filter((a) => {
      const mine = here.get(a.id);
      if (mine === undefined) return false;
      return CONNECTION_FIELDS.some((field) => {
        const x = a[field];
        const y = mine[field];
        return typeof x === "string" && typeof y === "string"
          ? x.toLowerCase() !== y.toLowerCase()
          : x !== y;
      });
    })
    .map((a) => a.id);
}

/** `Matters backup 2026-11-16.db`: the name a backup is offered under (rule 7). */
export function backupFileName(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `Matters backup ${day}.db` : "Matters backup.db";
}

/**
 * The name of a set-aside database's folder (rule 9): when the swap ran, to the second, in UTC,
 * `2026-11-16T153000Z`, so names sort by time and never hold a character a folder cannot.
 */
export function setAsideName(atMs: number): string {
  return new Date(atMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** The time a set-aside folder's name says, or null when the name is not one of ours. */
export function setAsideTime(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, ...number[]];
  const ms = Date.UTC(y as number, (mo as number) - 1, d, h, mi, s);
  return Number.isNaN(ms) || setAsideName(ms) !== name ? null : ms;
}

/**
 * How saving a letter's source ended (ADR 0145, rule 3), the same set a received file has
 * (ADR 0043, rule 9) and the account's own trouble: `signIn` when it needs its password or its
 * sign-in again.
 */
export type SourceOutcome =
  | "saved"
  | "cancelled"
  | "gone"
  | "offline"
  | "signIn"
  | "exists"
  | "failed";

/** The phrase for one letter that was not saved (ADR 0145, rule 3). */
export function sourceProblemText(outcome: Exclude<SourceOutcome, "saved" | "cancelled">): string {
  switch (outcome) {
    case "gone":
      return "This message is no longer on the server, so it could not be saved as a file.";
    case "offline":
      return "The server could not be reached, so the message was not saved. Try again when you're online.";
    case "signIn":
      return "The account needs its password or sign-in again, so the message was not saved.";
    case "exists":
      return "A file of that name is already there, so the message was not saved.";
    case "failed":
      return "The message could not be saved as a file.";
  }
}

/**
 * The line for a folder of several letters (rule 3): what was saved and what was not, with the
 * first reason. Null when all were saved or the save was cancelled before any was.
 */
export function sourcesSummaryText(outcomes: readonly SourceOutcome[]): string | null {
  const saved = outcomes.filter((o) => o === "saved").length;
  const problems = outcomes.filter(
    (o): o is Exclude<SourceOutcome, "saved" | "cancelled"> => o !== "saved" && o !== "cancelled",
  );
  if (outcomes.length === 1) {
    const only = outcomes[0];
    return only === undefined || only === "saved" || only === "cancelled"
      ? null
      : sourceProblemText(only);
  }
  const stopped = outcomes.includes("cancelled");
  if (problems.length === 0 && !stopped) return null;
  const letters = (n: number) => (n === 1 ? "1 letter" : `${n} letters`);
  const head = `${letters(saved)} of ${outcomes.length} saved.`;
  if (problems.length === 0) return `${head} Stopped before the rest.`;
  const first = problems[0] as Exclude<SourceOutcome, "saved" | "cancelled">;
  const why: Record<typeof first, string> = {
    gone: "no longer on the server",
    offline: "the server could not be reached",
    signIn: "the account needs its password or sign-in again",
    exists: "a file of that name was already there",
    failed: "it could not be written",
  };
  return `${head} ${letters(problems.length)} not: ${why[first]}.`;
}
