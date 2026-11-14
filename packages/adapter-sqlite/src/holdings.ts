// What the database keeps, declared table by table (ADR 0138, rules 2 and 5). Every table has a
// group (what the review shows it under) and a scope: an account's rows go with the account,
// rows built from mail are pruned when no mail supports them any more, and the person's shared
// things stay. A table that is not declared here fails the test that lists the schema.
import type { Holding, HoldingGroup, TableScope } from "@matters/core";
import { type Database, exclusive, tallyAllPeople, transaction } from "./database.ts";
import { SQLITE_FILE_HOLDINGS } from "./fileHoldings.ts";

interface TableRule {
  readonly table: string;
  readonly group: HoldingGroup;
  readonly scope: TableScope;
  /** Deletes one account's rows (scope "account"). */
  readonly discard?: (db: Database, accountId: string) => void;
  /** Deletes what no remaining mail supports (scope "derived"). */
  readonly prune?: (db: Database) => void;
  /** Why nothing has to be done here: a cascade, a trigger, or an earlier rule does it. */
  readonly coveredBy?: string;
}

const byAccount =
  (table: string) =>
  (db: Database, accountId: string): void => {
    db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
  };

/** Rows of a thread that has no message left. */
const unsupportedThreads =
  (table: string) =>
  (db: Database): void => {
    db.prepare(
      `DELETE FROM ${table} WHERE thread_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = ${table}.thread_id)`,
    ).run();
  };

/** Thread ids of a JSON array of objects or strings, for a check against `messages`. */
function threadIdsIn(json: string | null, field: string | null): string[] {
  if (json === null) return [];
  try {
    const value = JSON.parse(json) as unknown;
    const list = Array.isArray(value)
      ? value
      : field !== null && typeof value === "object" && value !== null
        ? ((value as Record<string, unknown>)[field] ?? [])
        : [];
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) =>
      typeof item === "string"
        ? [item]
        : typeof item === "object" && item !== null && typeof item.threadId === "string"
          ? [item.threadId as string]
          : [],
    );
  } catch {
    return [];
  }
}

/**
 * An answer across all mail that cites a thread with no mail left goes whole: its text may quote
 * that mail. The question the person typed stays (their own words), and so does a talk with
 * anything left in it; an empty talk goes.
 */
function pruneTalkAll(db: Database): void {
  const hasThread = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1");
  const supported = (id: string) => hasThread.get(id) !== undefined;
  const rows = db
    .prepare(
      `SELECT id, quotes_json, hits_json, carry_json FROM agent_talk
        WHERE thread_id IS NULL
          AND (quotes_json IS NOT NULL OR hits_json IS NOT NULL OR carry_json IS NOT NULL)`,
    )
    .all() as unknown as {
    id: number;
    quotes_json: string | null;
    hits_json: string | null;
    carry_json: string | null;
  }[];
  const drop = db.prepare("DELETE FROM agent_talk WHERE id = ?");
  for (const row of rows) {
    const cited = [
      ...threadIdsIn(row.quotes_json, null),
      ...threadIdsIn(row.hits_json, null),
      ...threadIdsIn(row.carry_json, "threadIds"),
    ];
    if (cited.some((t) => !supported(t))) drop.run(row.id);
  }
  db.prepare(
    "DELETE FROM agent_talks WHERE NOT EXISTS (SELECT 1 FROM agent_talk e WHERE e.talk_id = agent_talks.id)",
  ).run();
}

/** A kept search of a prompt that names a thread with no mail left goes; the next run makes it. */
function prunePromptSearches(db: Database): void {
  const hasThread = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1");
  const rows = db
    .prepare("SELECT prompt_key, filters, threads_json FROM agent_prompt_searches")
    .all() as unknown as { prompt_key: string; filters: string; threads_json: string }[];
  const drop = db.prepare("DELETE FROM agent_prompt_searches WHERE prompt_key = ? AND filters = ?");
  for (const row of rows) {
    if (threadIdsIn(row.threads_json, null).some((t) => hasThread.get(t) === undefined)) {
      drop.run(row.prompt_key, row.filters);
    }
  }
}

/** People are built again from the mail that stays: nobody is kept who appears in none of it. */
function rebuildPeople(db: Database): void {
  db.prepare("DELETE FROM people_words").run();
  db.prepare("DELETE FROM people").run();
  tallyAllPeople(db);
}

/**
 * The words of the index, again from the index itself (as in migration 11), once the index has
 * been merged so that a removed message's words are really out of it.
 */
function rebuildTerms(db: Database): void {
  db.exec(`
    DELETE FROM message_terms;
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.message_vocab USING fts5vocab(main, message_fts, 'row');
    INSERT OR IGNORE INTO message_terms (term)
      SELECT CASE WHEN length(term) > 32 THEN substr(term, 1, 32) || char(1114110) ELSE term END
      FROM temp.message_vocab WHERE length(term) >= 2;
    DROP TABLE temp.message_vocab;
  `);
}

const cascade = "a foreign key on messages (ON DELETE CASCADE)";
const sharedRows = "the person's, across accounts";

/** Every table of the schema, in the order an account's removal walks them. */
export const TABLE_RULES: readonly TableRule[] = [
  // Mail and the search index.
  {
    table: "accounts",
    group: "mail",
    scope: "account",
    discard: (db, id) => db.prepare("DELETE FROM accounts WHERE id = ?").run(id),
  },
  {
    table: "messages",
    group: "mail",
    scope: "account",
    // Not a plain DELETE: the store writes tombstones and the index entries go with them.
    coveredBy: "MessageStorePort.removeAccountMessages, before this list runs",
  },
  { table: "message_labels", group: "mail", scope: "account", coveredBy: cascade },
  {
    table: "message_locations",
    group: "mail",
    scope: "account",
    discard: byAccount("message_locations"),
  },
  // A Graph copy's handle with its location (ADR 0136, rule 6); `removeAccountMessages` clears
  // it too, and this keeps the account's rows going with it whoever removes the mail.
  {
    table: "location_items",
    group: "mail",
    scope: "account",
    discard: byAccount("location_items"),
  },
  { table: "message_refs", group: "mail", scope: "account", discard: byAccount("message_refs") },
  { table: "message_attachments", group: "mail", scope: "account", coveredBy: cascade },
  { table: "folders", group: "mail", scope: "account", discard: byAccount("folders") },
  { table: "cursors", group: "mail", scope: "account", discard: byAccount("cursors") },
  { table: "drafts", group: "mail", scope: "account", discard: byAccount("drafts") },
  {
    table: "send_operations",
    group: "mail",
    scope: "account",
    discard: byAccount("send_operations"),
  },
  {
    table: "flag_operations",
    group: "mail",
    scope: "account",
    discard: byAccount("flag_operations"),
  },
  {
    table: "move_operations",
    group: "mail",
    scope: "account",
    discard: byAccount("move_operations"),
  },
  {
    table: "body_blocks",
    group: "mail",
    scope: "derived",
    coveredBy: "removeBodies rewrites a block without the removed messages",
  },
  { table: "body_index", group: "mail", scope: "derived", coveredBy: "removeBodies" },
  { table: "html_blocks", group: "mail", scope: "derived", coveredBy: "removeBodies" },
  { table: "html_index", group: "mail", scope: "derived", coveredBy: "removeBodies" },
  { table: "html_kinds", group: "mail", scope: "derived", coveredBy: "removeBodies" },
  {
    table: "html_repack",
    group: "mail",
    scope: "derived",
    prune: (db) =>
      db
        .prepare(
          "DELETE FROM html_repack WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.key = html_repack.key)",
        )
        .run(),
  },
  { table: "html_repack_state", group: "mail", scope: "shared", coveredBy: "a position, no mail" },
  {
    table: "removed_messages",
    group: "mail",
    scope: "shared",
    coveredBy: "keys and change numbers only: the change feed needs them",
  },
  { table: "counters", group: "mail", scope: "shared", coveredBy: "counters, no mail" },
  { table: "schema_version", group: "mail", scope: "shared", coveredBy: "versions, no mail" },
  { table: "sqlite_sequence", group: "mail", scope: "shared", coveredBy: "SQLite's own counters" },
  {
    table: "message_fts",
    group: "mail",
    scope: "derived",
    coveredBy: "removeMessages; merged afterwards so the words leave the index",
  },
  { table: "message_fts_config", group: "mail", scope: "shared", coveredBy: "the index's own" },
  { table: "message_fts_data", group: "mail", scope: "derived", coveredBy: "message_fts" },
  { table: "message_fts_docsize", group: "mail", scope: "derived", coveredBy: "message_fts" },
  { table: "message_fts_idx", group: "mail", scope: "derived", coveredBy: "message_fts" },
  { table: "message_terms", group: "mail", scope: "derived", prune: rebuildTerms },
  // Attachments and files.
  { table: "attachments", group: "files", scope: "account", discard: byAccount("attachments") },
  { table: "attachment_text", group: "files", scope: "account", coveredBy: cascade },
  {
    table: "file_fts",
    group: "files",
    scope: "derived",
    coveredBy: "the trigger file_index_gone; merged afterwards",
  },
  { table: "file_fts_config", group: "files", scope: "shared", coveredBy: "the index's own" },
  { table: "file_fts_data", group: "files", scope: "derived", coveredBy: "file_fts" },
  { table: "file_fts_docsize", group: "files", scope: "derived", coveredBy: "file_fts" },
  { table: "file_fts_idx", group: "files", scope: "derived", coveredBy: "file_fts" },
  {
    table: "file_starts",
    group: "files",
    scope: "derived",
    coveredBy: "the trigger file_index_gone",
  },
  // What agents wrote.
  {
    table: "agent_analyses",
    group: "agents",
    scope: "derived",
    prune: unsupportedThreads("agent_analyses"),
  },
  {
    table: "agent_prepared",
    group: "agents",
    scope: "derived",
    prune: unsupportedThreads("agent_prepared"),
  },
  {
    table: "agent_feedback",
    group: "agents",
    scope: "derived",
    prune: unsupportedThreads("agent_feedback"),
  },
  {
    table: "agent_journal",
    group: "agents",
    scope: "derived",
    prune: unsupportedThreads("agent_journal"),
  },
  {
    table: "agent_instructions",
    group: "agents",
    scope: "derived",
    // A thread's instructions go with its mail; general ones (no thread) stay.
    prune: unsupportedThreads("agent_instructions"),
  },
  {
    table: "agent_talk",
    group: "agents",
    scope: "derived",
    prune: (db) => {
      unsupportedThreads("agent_talk")(db);
      pruneTalkAll(db);
    },
  },
  { table: "agent_talks", group: "agents", scope: "derived", coveredBy: "agent_talk's prune" },
  {
    table: "agent_prompt_verdicts",
    group: "agents",
    scope: "derived",
    prune: unsupportedThreads("agent_prompt_verdicts"),
  },
  { table: "agent_prompt_searches", group: "agents", scope: "derived", prune: prunePromptSearches },
  {
    table: "agent_bundle_reads",
    group: "agents",
    scope: "derived",
    // A cache of what a model said about threads: it is read again when needed.
    prune: (db) => db.prepare("DELETE FROM agent_bundle_reads").run(),
  },
  { table: "agent_ledger", group: "agents", scope: "account", discard: byAccount("agent_ledger") },
  {
    table: "agent_consents",
    group: "agents",
    scope: "account",
    discard: byAccount("agent_consents"),
  },
  { table: "agent_rules", group: "agents", scope: "shared", coveredBy: sharedRows },
  { table: "agent_settings", group: "agents", scope: "shared", coveredBy: sharedRows },
  { table: "agent_runtime_records", group: "agents", scope: "shared", coveredBy: sharedRows },
  // Views, people and settings.
  { table: "people", group: "settings", scope: "derived", prune: rebuildPeople },
  { table: "people_words", group: "settings", scope: "derived", coveredBy: "people's prune" },
  { table: "saved_views", group: "settings", scope: "shared", coveredBy: sharedRows },
  { table: "view_searches", group: "settings", scope: "shared", coveredBy: sharedRows },
  { table: "image_rules", group: "settings", scope: "shared", coveredBy: sharedRows },
  { table: "image_setting", group: "settings", scope: "shared", coveredBy: sharedRows },
  {
    table: "storage_samples",
    group: "settings",
    scope: "shared",
    coveredBy: "sizes and counts, no mail",
  },
];

/** The database's holdings: its files, and every table. */
export const SQLITE_HOLDINGS: readonly Holding[] = [
  ...SQLITE_FILE_HOLDINGS,
  ...TABLE_RULES.map(
    (r): Holding => ({
      id: `sqlite.${r.table}`,
      group: r.group,
      place: { kind: "table", table: r.table, scope: r.scope },
      step: "database",
    }),
  ),
];

/** The tables of the schema, shadow tables of the indexes included. */
export function schemaTables(db: Database): readonly string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

/**
 * The account's rows in every table, and what no mail supports any more (ADR 0138, rule 5), in
 * one transaction. Run after the account's messages have gone (the unit of work of
 * `removeAccount`), or on its own: every step can run again.
 */
export function discardAccountRows(db: Database, accountId: string): void {
  transaction(db, () => {
    for (const r of TABLE_RULES) r.discard?.(db, accountId);
    for (const r of TABLE_RULES) r.prune?.(db);
  });
}

/**
 * Merges the two indexes into one segment each, so that the words of removed messages are no
 * longer in their pages (a contentless index only marks them deleted), and builds the words of
 * the index again from it. Costs a rewrite of the index; part of removing an account only.
 */
export function mergeIndexes(db: Database): void {
  transaction(db, () => {
    db.exec("INSERT INTO message_fts (message_fts) VALUES ('optimize')");
    db.exec("INSERT INTO file_fts (file_fts) VALUES ('optimize')");
    rebuildTerms(db);
  });
}

/** Bytes of the database by holding group, from `dbstat`; free pages count to mail. */
export function measureTableGroups(db: Database): Readonly<Record<HoldingGroup, number>> {
  const groups: Record<HoldingGroup, number> = {
    signIns: 0,
    mail: 0,
    files: 0,
    agents: 0,
    settings: 0,
    caches: 0,
  };
  const tableGroup = new Map(TABLE_RULES.map((r) => [r.table, r.group]));
  // An index's pages count to its table.
  const rows = db
    .prepare(
      `SELECT s.tbl_name AS tbl, SUM(d.pgsize) AS bytes
         FROM dbstat d JOIN sqlite_schema s ON s.name = d.name GROUP BY s.tbl_name`,
    )
    .all() as unknown as { tbl: string; bytes: number }[];
  for (const r of rows) groups[tableGroup.get(r.tbl) ?? "mail"] += r.bytes;
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const free = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number })
    .freelist_count;
  groups.mail += free * pageSize;
  return groups;
}

/** Discards one account's rows through the list above; the port `removeAccount` drives. */
export class SqliteAccountData {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async discardAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => discardAccountRows(this.db, accountId));
  }

  async mergeIndexes(): Promise<void> {
    await exclusive(this.db, () => mergeIndexes(this.db));
  }
}
