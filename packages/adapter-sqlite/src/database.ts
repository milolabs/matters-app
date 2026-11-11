import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MAX_VIEWS, type Participant, splitByPause, type UnitOfWorkPort } from "@matters/core";
import { backfillFileIndex } from "./fileIndex.ts";
import { PeopleTally, peopleWriter } from "./people.ts";
import { joinStoredRepliesBySubject, rethreadStoredMail } from "./threadJoin.ts";

export type Database = DatabaseSync;

const STARTER_VIEWS = [
  ["starter-unread", "Unread", "is:unread"],
  ["starter-starred", "Starred", "is:starred"],
  ["starter-attachments", "Attachments", "has:attachment"],
] as const;

interface Migration {
  readonly version: number;
  readonly sql: string;
  /** Runs after `sql`, in the same transaction, for what SQL cannot do (e.g. folding text). */
  readonly run?: (db: Database) => void;
}

/** ADR 0086, rule 15: the entries of all mail, in id order, cut into talks at each long pause. */
function splitTalkAll(db: Database): void {
  const rows = db
    .prepare("SELECT id, at_ms FROM agent_talk WHERE thread_id IS NULL ORDER BY id")
    .all() as unknown as { id: number; at_ms: number }[];
  const parts = splitByPause(rows.map((r) => r.at_ms));
  const spans = new Map<number, { first: number; last: number; ids: number[] }>();
  rows.forEach((row, i) => {
    const part = parts[i] ?? 0;
    const span = spans.get(part);
    if (span === undefined) spans.set(part, { first: row.at_ms, last: row.at_ms, ids: [row.id] });
    else {
      span.first = Math.min(span.first, row.at_ms);
      span.last = Math.max(span.last, row.at_ms);
      span.ids.push(row.id);
    }
  });
  const insert = db.prepare("INSERT INTO agent_talks (started_at_ms, last_at_ms) VALUES (?, ?)");
  const assign = db.prepare("UPDATE agent_talk SET talk_id = ? WHERE id = ?");
  for (const span of spans.values()) {
    const talkId = insert.run(span.first, span.last).lastInsertRowid;
    for (const id of span.ids) assign.run(talkId, id);
  }
}

/** ADR 0029. After any views the user has; a name already taken or a full list is left alone. */
function addStarterViews(db: Database): void {
  const now = Date.now();
  const taken = db.prepare("SELECT 1 FROM saved_views WHERE lower(name) = lower(?)");
  const stats = db
    .prepare("SELECT count(*) AS n, coalesce(max(position), -1) AS last FROM saved_views")
    .get() as { n: number; last: number };
  const insert = db.prepare(
    "INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let count = stats.n;
  let position = stats.last;
  for (const [id, name, query] of STARTER_VIEWS) {
    if (count >= MAX_VIEWS || taken.get(name) !== undefined) continue;
    insert.run(id, name, query, ++position, now, now);
    count++;
  }
}

/**
 * ADR 0044, rule 4: the view everyone starts with, first among the tabs. It runs once, so a view
 * the user deletes stays deleted. The tabs that exist move down by one; a full list or a name
 * already taken is left alone.
 */
function addInboxView(db: Database): void {
  const taken = db.prepare("SELECT 1 FROM saved_views WHERE lower(name) = lower(?)");
  const count = (db.prepare("SELECT count(*) AS n FROM saved_views").get() as { n: number }).n;
  if (count >= MAX_VIEWS || taken.get("Inbox") !== undefined) return;
  const now = Date.now();
  db.exec("UPDATE saved_views SET position = position + 1");
  db.prepare(
    "INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("starter-inbox", "Inbox", "in:inbox", 0, now, now);
}

/** ADR 0028: every participant of every message, in key order, folded into `people`. */
function backfillPeople(db: Database): void {
  const tally = new PeopleTally();
  const rows = db
    .prepare("SELECT date_ms, from_json, to_json, cc_json FROM messages ORDER BY key")
    .iterate() as Iterable<{
    date_ms: number;
    from_json: string;
    to_json: string;
    cc_json: string;
  }>;
  for (const r of rows) {
    tally.add(r.date_ms, [
      JSON.parse(r.from_json) as Participant,
      ...(JSON.parse(r.to_json) as Participant[]),
      ...(JSON.parse(r.cc_json) as Participant[]),
    ]);
  }
  peopleWriter(db).apply(tally);
  // After the rows: building an index once is cheaper than keeping it while they go in.
  db.exec("CREATE INDEX people_rank ON people (count DESC, last_ms DESC, address)");
}

/** Append only. Each migration runs in its own transaction together with its version row. */
/**
 * The key a message is a copy of (ADR 0092, rule 4): the smallest smaller key of the same account,
 * Message-ID and mailboxes; NULL when there is none. Correlated with the row being set.
 */
const COPY_OF_SQL = `
  SELECT MIN(o.key) FROM messages o
   WHERE o.account_id = messages.account_id
     AND o.message_id_header = messages.message_id_header
     AND o.mailboxes = messages.mailboxes
     AND o.key < messages.key`;

/** Sets `copy_of` again for every row of one account and Message-ID. */
const recopy = (row: "new" | "old") => `
    UPDATE messages SET copy_of = (${COPY_OF_SQL})
     WHERE ${row}.message_id_header != ''
       AND account_id = ${row}.account_id AND message_id_header = ${row}.message_id_header;`;

const COPY_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS messages_copy_insert AFTER INSERT ON messages BEGIN${recopy("new")}
  END;
  CREATE TRIGGER IF NOT EXISTS messages_copy_delete AFTER DELETE ON messages BEGIN${recopy("old")}
  END;
  CREATE TRIGGER IF NOT EXISTS messages_copy_update AFTER UPDATE OF mailboxes, message_id_header, account_id
    ON messages BEGIN${recopy("old")}${recopy("new")}
  END;`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO counters (name, value) VALUES ('change_seq', 0);

      CREATE TABLE messages (
        key INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id_header TEXT NOT NULL,
        date_ms INTEGER NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        flags INTEGER NOT NULL,
        has_attachments INTEGER NOT NULL,
        change_seq INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX messages_identity ON messages (account_id, provider_id);
      CREATE INDEX messages_thread ON messages (thread_id, key);
      CREATE INDEX messages_change_seq ON messages (change_seq);

      CREATE TABLE message_labels (
        label_id TEXT NOT NULL,
        message_key INTEGER NOT NULL REFERENCES messages (key) ON DELETE CASCADE,
        pos INTEGER NOT NULL,
        label_fold TEXT NOT NULL,
        PRIMARY KEY (label_id, message_key)
      ) WITHOUT ROWID;
      CREATE INDEX message_labels_message ON message_labels (message_key);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE message_fts USING fts5(
        sender, recipients, cc, subject, body,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61',
        prefix = '2 3'
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE cursors (
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        cursor_json TEXT NOT NULL,
        PRIMARY KEY (account_id, folder_id)
      ) WITHOUT ROWID;

      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before_ms INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT
      );
      CREATE INDEX outbox_due ON outbox (state, not_before_ms, id);
    `,
  },
  {
    version: 4,
    // ADR 0009: the bodies of a thread live in zstd blocks; body_index locates each message
    // inside its block (byte offset and length in the uncompressed UTF-8 concatenation).
    sql: `
      CREATE TABLE body_blocks (
        id INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        block_no INTEGER NOT NULL,
        raw_bytes INTEGER NOT NULL,
        data BLOB NOT NULL,
        UNIQUE (thread_id, block_no)
      );

      CREATE TABLE body_index (
        key INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        block_no INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        length INTEGER NOT NULL
      );
      CREATE INDEX body_index_block ON body_index (thread_id, block_no);
    `,
  },
  {
    version: 5,
    // Tombstones for removed messages, so `changesSince` can report removals.
    sql: `
      CREATE TABLE removed_messages (
        key INTEGER PRIMARY KEY,
        change_seq INTEGER NOT NULL
      );
      CREATE INDEX removed_messages_change_seq ON removed_messages (change_seq);
    `,
  },
  {
    version: 6,
    // ADR 0016: a message and its copies in folders are separate; a location belongs to one key.
    sql: `
      CREATE TABLE message_locations (
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_key INTEGER NOT NULL REFERENCES messages (key) ON DELETE CASCADE,
        PRIMARY KEY (account_id, folder_id, uid_validity, uid)
      ) WITHOUT ROWID;
      CREATE INDEX message_locations_message ON message_locations (message_key);
    `,
  },
  {
    version: 7,
    // ADR 0018: accounts the user added; no secrets (passwords live in the main process).
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        display_name TEXT NOT NULL,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL,
        imap_security TEXT NOT NULL,
        imap_username TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX accounts_address ON accounts (lower(address));
      CREATE INDEX messages_account ON messages (account_id);
    `,
  },
  {
    version: 8,
    // ADR 0020: drafts, the send queue (replaces the generic one, which never had a producer)
    // and the outgoing server of an account.
    sql: `
      DROP TABLE outbox;

      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        thread_id TEXT,
        content_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX drafts_thread ON drafts (account_id, thread_id);

      CREATE TABLE send_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        state TEXT NOT NULL,
        state_text TEXT,
        approval_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        not_before_ms INTEGER NOT NULL,
        message_id TEXT,
        mime BLOB,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        unknown_since_ms INTEGER,
        warning TEXT
      ) WITHOUT ROWID;
      CREATE INDEX send_operations_due ON send_operations (state, not_before_ms);
      CREATE INDEX send_operations_draft ON send_operations (draft_id);

      ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
      ALTER TABLE accounts ADD COLUMN smtp_security TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_username TEXT;
    `,
  },
  {
    version: 9,
    // ADR 0024: a message's HTML, as sent, in zstd blocks of its own: text blocks stay small
    // for search and for opening a thread. Kinds are apart so reading them unpacks nothing.
    sql: `
      CREATE TABLE html_blocks (
        id INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        block_no INTEGER NOT NULL,
        raw_bytes INTEGER NOT NULL,
        data BLOB NOT NULL,
        UNIQUE (thread_id, block_no)
      );

      CREATE TABLE html_index (
        key INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        block_no INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        length INTEGER NOT NULL
      );
      CREATE INDEX html_index_block ON html_index (thread_id, block_no);

      CREATE TABLE html_kinds (
        key INTEGER PRIMARY KEY,
        designed INTEGER NOT NULL
      );
    `,
  },
  {
    version: 10,
    // ADR 0025: indexes for the filters a query plan can be driven by. The partial ones hold
    // only the rarer side of a flag; their WHERE text is what the planner matches.
    sql: `
      CREATE INDEX messages_unread ON messages (key) WHERE flags & 1 = 0;
      CREATE INDEX messages_starred ON messages (key) WHERE flags & 2 = 2;
      CREATE INDEX messages_draft ON messages (key) WHERE flags & 8 = 8;
      CREATE INDEX messages_attachments ON messages (key) WHERE has_attachments = 1;
      CREATE INDEX message_labels_fold ON message_labels (label_fold, message_key);
    `,
  },
  {
    version: 11,
    // ADR 0025: the words of the index, so a prefix of 4+ characters can be expanded into an OR
    // of exact terms (FTS5 builds a merged doclist for a prefix it has no index for). Always
    // covers the indexed tokens of 4+ characters: a word of up to 32 as it is, a longer one as
    // its first 32 characters plus U+10FFFE (searchPlan.ts, `termEntry`). The backfill reads the
    // index's own vocabulary and counts code points, which never exceed UTF-16 units.
    sql: `
      CREATE TABLE message_terms (term TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE VIRTUAL TABLE temp.message_vocab USING fts5vocab(main, message_fts, 'row');
      INSERT OR IGNORE INTO message_terms (term)
        SELECT CASE WHEN length(term) > 32 THEN substr(term, 1, 32) || char(1114110) ELSE term END
        FROM temp.message_vocab WHERE length(term) >= 2;
      DROP TABLE temp.message_vocab;
    `,
  },
  {
    version: 12,
    // ADR 0027: saved views, a name and query text. Positions order the tabs.
    sql: `
      CREATE TABLE saved_views (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
    `,
  },
  {
    version: 13,
    // ADR 0028: people for query suggestions. `people` keeps the latest name of an address, how
    // many messages named it and the date of the latest; `people_words` the folded words
    // (name and address, at most 16) it is found by. Written with the index, never deleted
    // from; the backfill reads the participants of every message once, and then builds
    // `people_rank`, the order a common prefix is answered in.
    sql: `
      CREATE TABLE people (
        address TEXT PRIMARY KEY,
        name TEXT,
        count INTEGER NOT NULL,
        last_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE people_words (
        word TEXT NOT NULL,
        address TEXT NOT NULL,
        PRIMARY KEY (word, address)
      ) WITHOUT ROWID;
    `,
    run: backfillPeople,
  },
  {
    version: 14,
    // ADR 0029: the first views everyone starts with. A migration runs once, so a view the user
    // deletes stays deleted.
    sql: "",
    run: addStarterViews,
  },
  {
    version: 15,
    // ADR 0030: recent searches per view. No foreign key: `All mail` has no row in saved_views.
    sql: `
      CREATE TABLE view_searches (
        view_id TEXT NOT NULL,
        query TEXT NOT NULL,
        last_ms INTEGER NOT NULL,
        PRIMARY KEY (view_id, query)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 16,
    // ADR 0037: the sender's verdict (pass, fail, unknown) is stored with the message. Mail from
    // before reads as unknown until a sync writes it again. Rules are global to the computer,
    // so they carry no account, and they are not in the change log. The primary key is the one
    // lookup an opened message makes.
    sql: `
      ALTER TABLE messages ADD COLUMN sender_auth TEXT NOT NULL DEFAULT 'unknown';

      CREATE TABLE image_rules (
        scope TEXT NOT NULL CHECK (scope IN ('address', 'domain')),
        value TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, value)
      ) WITHOUT ROWID;

      CREATE TABLE image_setting (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        general TEXT NOT NULL CHECK (general IN ('ask', 'always'))
      );
      INSERT INTO image_setting (id, general) VALUES (1, 'ask');
    `,
  },
  {
    version: 17,
    // ADR 0039: the read state the server does not have yet, one row per message (the latest
    // request wins). Not the send queue: that one is about one draft and never repeats. No foreign
    // key: a deleted message leaves a row that the push finds without a copy and drops. `rev`
    // tells a push that a newer request replaced its own while it was on the wire.
    sql: `
      CREATE TABLE flag_operations (
        message_key INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        seen INTEGER NOT NULL CHECK (seen IN (0, 1)),
        previous_seen INTEGER NOT NULL CHECK (previous_seen IN (0, 1)),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX flag_operations_due ON flag_operations (next_attempt_ms);
      CREATE INDEX flag_operations_account ON flag_operations (account_id);
    `,
  },
  {
    version: 18,
    // ADR 0040 and 0041: the files of drafts and what a send needs to know about them. The
    // bytes live in the data directory, never here; a row says which copy, in what state, and
    // where the original was. `rowid` keeps the order files were added in. `state` is indexed
    // with the draft because every claim of a send asks "is a file of this draft still being
    // read". The server's message limit sits on the account, the lane's input (`encoded_bytes`)
    // on the operation, as does the path of a spool file in place of the `mime` BLOB. Sends
    // that were running keep meaning "may have gone out": the mark did not exist before.
    sql: `
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reading', 'ready', 'failed', 'tooLarge')),
        reason TEXT,
        sha256 TEXT,
        source_path TEXT,
        source_mtime_ms REAL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX attachments_draft ON attachments (draft_id, state);
      CREATE INDEX attachments_state ON attachments (state);
      CREATE INDEX attachments_account ON attachments (account_id);

      ALTER TABLE send_operations ADD COLUMN encoded_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE send_operations ADD COLUMN data_ended INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE send_operations ADD COLUMN auto_retries INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE send_operations ADD COLUMN mime_bytes INTEGER;
      ALTER TABLE send_operations ADD COLUMN spool_path TEXT;
      ALTER TABLE send_operations ADD COLUMN state_action TEXT;
      UPDATE send_operations SET data_ended = 1 WHERE state = 'running';
      UPDATE send_operations SET mime_bytes = length(mime) WHERE mime IS NOT NULL;
      CREATE INDEX send_operations_account ON send_operations (account_id, state);

      ALTER TABLE accounts ADD COLUMN max_message_bytes INTEGER;
    `,
  },
  {
    version: 19,
    // ADR 0042: the addresses of a message's Reply-To, as JSON. NULL means not known yet, which
    // is what every message stored before this is; '[]' means none. The partial index holds
    // only the unknown rows, so a sync that asks "which messages of this folder still do not
    // know" reads nothing once they all do, however large the mailbox. Newest first, by
    // account: the query walks it and looks each message's locations up by key.
    sql: `
      ALTER TABLE messages ADD COLUMN reply_to_json TEXT;
      CREATE INDEX messages_reply_to_unknown ON messages (account_id, key DESC)
        WHERE reply_to_json IS NULL;
    `,
  },
  {
    version: 20,
    // ADR 0043: the files of a message, one row per file part, read with its thread. Inline parts
    // are kept (a later decision about `cid:` images wants them) but not listed. The rows go with
    // the message.
    //
    // `attachments_known` says whether the structure has been read. The column is added with
    // DEFAULT 1, which costs no rewrite of a large table: every stored message starts as known,
    // and only those that claim attachments are put back to unknown, which is what the backfill
    // looks for. A message with no attachments is known already; if it was wrong, the paperclip
    // never said so either.
    //
    // The partial index holds only those unknown rows, so the backfill's question ("which messages
    // of this folder still do not know") reads nothing once they all do, however large the
    // mailbox. Newest first, by account, as for Reply-To (version 19).
    sql: `
      ALTER TABLE messages ADD COLUMN attachments_known INTEGER NOT NULL DEFAULT 1;
      UPDATE messages SET attachments_known = 0 WHERE has_attachments = 1;

      CREATE TABLE message_attachments (
        message_key INTEGER NOT NULL REFERENCES messages (key) ON DELETE CASCADE,
        part_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_id TEXT,
        inline INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_key, part_id)
      ) WITHOUT ROWID;

      CREATE INDEX messages_attachments_unknown ON messages (account_id, key DESC)
        WHERE has_attachments = 1 AND attachments_known = 0;
    `,
  },
  {
    version: 21,
    // ADR 0044: where mail is. `folders` keeps what each folder is, written at every sync (the
    // names differ: Trash, Kosz, [Gmail]/Trash). `messages.mailboxes` is a bit set of roles
    // (inbox 1, sent 2, drafts 4, trash 8, spam 16, archive 32, other 64) kept wherever labels or
    // locations are written. Until the first sync has listed the folders it is read from the
    // labels alone: the system labels by their names, every other label as `other`, which hides
    // nothing from `All mail` that was not a Trash or Spam label by name already. `SUM(DISTINCT)`
    // of distinct powers of two is their OR.
    //
    // `messages_visible` is the order of `All mail`: every message not in Trash or Spam, newest
    // first, so a walk down it never reads a deleted row however many there are. Built after the
    // backfill, which is cheaper than keeping it while the rows are written.
    //
    // `move_operations` is `flag_operations` for moves (ADR 0039, 0044): one row per message,
    // the latest request wins and keeps the first "before" (labels and mailboxes), `rev` tells a
    // push that a newer request replaced its own. No foreign key: a deleted message leaves a row
    // that the push finds without a copy and drops.
    sql: `
      ALTER TABLE messages ADD COLUMN mailboxes INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE folders (
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        exclusive INTEGER NOT NULL CHECK (exclusive IN (0, 1)),
        PRIMARY KEY (account_id, folder_id)
      ) WITHOUT ROWID;

      UPDATE messages SET mailboxes = coalesce((
        SELECT SUM(DISTINCT CASE l.label_fold
                 WHEN 'inbox' THEN 1
                 WHEN 'sent' THEN 2
                 WHEN 'draft' THEN 4
                 WHEN 'drafts' THEN 4
                 WHEN 'trash' THEN 8
                 WHEN 'spam' THEN 16
                 ELSE 64 END)
          FROM message_labels l WHERE l.message_key = messages.key), 0);
      CREATE INDEX messages_visible ON messages (key) WHERE mailboxes & 24 = 0;

      CREATE TABLE move_operations (
        message_key INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('archive', 'delete', 'spam', 'move', 'purge')),
        target TEXT NOT NULL,
        labels_before_json TEXT NOT NULL,
        mailboxes_before INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX move_operations_due ON move_operations (next_attempt_ms);
      CREATE INDEX move_operations_account ON move_operations (account_id);
      CREATE INDEX move_operations_operation ON move_operations (operation_id);
    `,
    run: addInboxView,
  },
  {
    version: 22,
    // ADR 0045: where a forwarded file came from, `(message key, part id)`, so Try again can start
    // from the message and not from a cache path that may be gone. Kept apart from `source_path`,
    // which stays "where the user's own file was" and nothing else; a row has one or the other.
    // Rows from before are ordinary files: both columns are null. No foreign key: a deleted message
    // leaves a draft's file with an origin that the next download answers "gone".
    sql: `
      ALTER TABLE attachments ADD COLUMN origin_message_key INTEGER;
      ALTER TABLE attachments ADD COLUMN origin_part_id TEXT
        CHECK ((origin_message_key IS NULL) = (origin_part_id IS NULL));
    `,
  },
  {
    version: 23,
    // ADR 0052, rule 4: whether a message came from a list or a program, by its headers. NULL
    // means not known, which is what every message stored before this is; 0 and 1 are answers.
    // Old rows are not rewritten: ADD COLUMN with no default costs nothing on a large table, and
    // a later re-parse may fill the column in. No index: the candidates query reads the flag of
    // the messages of a few threads it has already found by key.
    sql: `
      ALTER TABLE messages ADD COLUMN automated INTEGER CHECK (automated IN (0, 1));
    `,
  },
  {
    version: 24,
    // ADR 0051, 0052: what agents found and made, and what the person agreed to. None of it holds
    // mail beyond the quotes of an analysis, which are the person's own mail kept on their machine.
    //
    // `agent_analyses`: one row per thread as it stood at its last message, by analyzer version.
    // The primary key is what `getAnalysis` asks. `agent_analyses_latest` serves `listAnalyses`
    // ("the newest analysis of each thread for a version"): both the outer scan and the
    // correlated max read it, so the list costs the number of threads analysed, whatever the
    // mailbox. Facts are one JSON array, read whole.
    //
    // `agent_prepared`: a draft or a question for a thread at its last message; a new message
    // makes a new key and so makes the old one stale without deleting it.
    //
    // `agent_feedback` and `agent_ledger` are logs in the order written.
    //
    // `agent_settings` is a single row of JSON: a handful of fields read together at startup.
    // `agent_consents` is per account and runtime; `agent_runtime_records` is what the test of a
    // runtime found.
    sql: `
      CREATE TABLE agent_analyses (
        thread_id TEXT NOT NULL,
        last_message_key INTEGER NOT NULL,
        analyzer_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('onYou', 'waiting', 'fyi', 'none')),
        headline TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        stakes TEXT NOT NULL CHECK (stakes IN ('none', 'money', 'contract')),
        confidence REAL NOT NULL,
        analyzed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, last_message_key, analyzer_version)
      ) WITHOUT ROWID;
      CREATE INDEX agent_analyses_latest
        ON agent_analyses (analyzer_version, thread_id, last_message_key DESC);

      CREATE TABLE agent_prepared (
        thread_id TEXT NOT NULL,
        last_message_key INTEGER NOT NULL,
        work_json TEXT NOT NULL,
        prepared_at_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, last_message_key)
      ) WITHOUT ROWID;

      CREATE TABLE agent_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        last_message_key INTEGER NOT NULL,
        sender_address TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('notImportant', 'later')),
        at_ms INTEGER NOT NULL,
        until_ms INTEGER
      );

      CREATE TABLE agent_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('analysis', 'prepare', 'consent', 'revoke')),
        threads INTEGER NOT NULL
      );
      CREATE INDEX agent_ledger_recent ON agent_ledger (at_ms DESC, id DESC);

      CREATE TABLE agent_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );

      CREATE TABLE agent_consents (
        account_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        granted_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, runtime_id)
      ) WITHOUT ROWID;

      CREATE TABLE agent_runtime_records (
        runtime_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
        plan TEXT,
        problem TEXT,
        tested_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 25,
    // ADR 0054: feedback can be `closed`, with the reason the agent gave. SQLite cannot change a
    // CHECK in place, so the table is rebuilt: same columns and ids, the wider CHECK, and a
    // nullable `reason`. The counter of AUTOINCREMENT is carried over so ids are never reused.
    // Nothing else refers to the table, and it holds one row per click, so the copy is small.
    sql: `
      CREATE TABLE agent_feedback_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        last_message_key INTEGER NOT NULL,
        sender_address TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('notImportant', 'later', 'closed')),
        at_ms INTEGER NOT NULL,
        until_ms INTEGER,
        reason TEXT
      );
      INSERT INTO agent_feedback_new (id, thread_id, last_message_key, sender_address, kind, at_ms, until_ms)
        SELECT id, thread_id, last_message_key, sender_address, kind, at_ms, until_ms FROM agent_feedback;
      DELETE FROM sqlite_sequence WHERE name = 'agent_feedback_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'agent_feedback_new', seq FROM sqlite_sequence WHERE name = 'agent_feedback';
      DROP TABLE agent_feedback;
      ALTER TABLE agent_feedback_new RENAME TO agent_feedback;
    `,
  },
  {
    version: 26,
    // ADR 0054, rule 6: the local journal. One row per thing the person or the agent closed, set
    // aside or put off, with who decided and on what grounds; written in the same transaction as
    // the feedback row, so the two never disagree. `undone_at_ms` marks a line the person took
    // back; the line stays. `agent_journal_thread` serves `removeForThreads`, so removal is a
    // lookup and not a scan of the log.
    //
    // Backfilled from `agent_feedback`, so nothing already closed is invisible: a row with a reason
    // was the agent's, the rest the person's. The headline is the one of the analysis the feedback
    // was about, any version (LIMIT 1), or none. `words` stays empty: it was never stored. Undo
    // before this version left no trace, so no backfilled line is marked undone.
    sql: `
      CREATE TABLE agent_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('closed', 'notImportant', 'later')),
        actor TEXT NOT NULL CHECK (actor IN ('person', 'agent')),
        thread_id TEXT NOT NULL,
        last_message_key INTEGER NOT NULL,
        sender_address TEXT NOT NULL,
        headline TEXT,
        words TEXT,
        reason TEXT,
        until_ms INTEGER,
        undone_at_ms INTEGER
      );
      CREATE INDEX agent_journal_thread ON agent_journal (thread_id);

      INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address,
                                 headline, reason, until_ms)
        SELECT f.at_ms, f.kind, CASE WHEN f.reason IS NOT NULL THEN 'agent' ELSE 'person' END,
               f.thread_id, f.last_message_key, f.sender_address,
               (SELECT a.headline FROM agent_analyses a
                 WHERE a.thread_id = f.thread_id AND a.last_message_key = f.last_message_key
                 LIMIT 1),
               f.reason, f.until_ms
          FROM agent_feedback f ORDER BY f.id;
    `,
  },
  {
    version: 27,
    // ADR 0054, rule 7: rules in code, and a journal that can hold them. `agent_rules` keeps one row
    // per rule; a removed rule keeps its row (`removed_at_ms`) so its journal line has something to
    // point at, and a partial UNIQUE index allows one active rule per scope and subject while a
    // removed one can be added again.
    //
    // A rule line has no thread, sender or message, and the journal's CHECK on `action` has to allow
    // `ruleAdded`. SQLite cannot change a CHECK or a NOT NULL in place, so `agent_journal` is
    // rebuilt: same rows and ids, `thread_id`, `last_message_key` and `sender_address` nullable, and
    // `rule_id` and `subject` added. The AUTOINCREMENT counter is carried over so ids are never
    // reused (see 25), and the index is recreated.
    //
    // `removeForThreads` matches lines by `thread_id`, so it never touches a rule line, and it never
    // touches `agent_rules`: a rule holds an address and the person's own words, never mail.
    sql: `
      CREATE TABLE agent_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('sender', 'domain', 'type')),
        subject TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('noReply')),
        actor TEXT NOT NULL CHECK (actor IN ('person', 'agent')),
        words TEXT,
        at_ms INTEGER NOT NULL,
        removed_at_ms INTEGER
      );
      CREATE UNIQUE INDEX agent_rules_active ON agent_rules (scope, subject) WHERE removed_at_ms IS NULL;

      CREATE TABLE agent_journal_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('closed', 'notImportant', 'later', 'ruleAdded')),
        actor TEXT NOT NULL CHECK (actor IN ('person', 'agent')),
        thread_id TEXT,
        last_message_key INTEGER,
        sender_address TEXT,
        headline TEXT,
        words TEXT,
        reason TEXT,
        until_ms INTEGER,
        undone_at_ms INTEGER,
        rule_id INTEGER,
        subject TEXT
      );
      INSERT INTO agent_journal_new (id, at_ms, action, actor, thread_id, last_message_key,
                                     sender_address, headline, words, reason, until_ms, undone_at_ms)
        SELECT id, at_ms, action, actor, thread_id, last_message_key, sender_address, headline,
               words, reason, until_ms, undone_at_ms FROM agent_journal;
      DELETE FROM sqlite_sequence WHERE name = 'agent_journal_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'agent_journal_new', seq FROM sqlite_sequence WHERE name = 'agent_journal';
      DROP TABLE agent_journal;
      ALTER TABLE agent_journal_new RENAME TO agent_journal;
      CREATE INDEX agent_journal_thread ON agent_journal (thread_id);
    `,
  },
  {
    version: 28,
    // ADR 0054, rule 7: instructions for the model. `agent_instructions` keeps one row per
    // instruction; a removed one keeps its row (`removed_at_ms`) so its journal line has something
    // to point at, and a partial UNIQUE index allows one active instruction per scope, thread and
    // text while a removed one can be added again. `thread_id` is set for scope `thread` only and
    // `words` holds what the person typed when the agent wrote it.
    //
    // The journal's CHECK on `action` has to allow `instructionAdded`, and a line points at its
    // instruction by `instruction_id`. `agent_journal` is rebuilt as in 25 and 27: same rows and
    // ids, the AUTOINCREMENT counter carried over, the index recreated. A line of a thread-scoped
    // instruction carries the thread's id, so `removeForThreads` finds it like any other.
    //
    // The ledger's CHECK on `purpose` has to allow `remember`, the turn that keeps what the person
    // typed. It is rebuilt the same way, keeping its rows and its index.
    sql: `
      CREATE TABLE agent_instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('general', 'understand', 'write', 'thread')),
        text TEXT NOT NULL,
        thread_id TEXT,
        actor TEXT NOT NULL CHECK (actor IN ('person', 'agent')),
        words TEXT,
        at_ms INTEGER NOT NULL,
        removed_at_ms INTEGER
      );
      CREATE UNIQUE INDEX agent_instructions_active
        ON agent_instructions (scope, ifnull(thread_id, ''), text) WHERE removed_at_ms IS NULL;
      CREATE INDEX agent_instructions_thread ON agent_instructions (thread_id);

      CREATE TABLE agent_journal_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('closed', 'notImportant', 'later', 'ruleAdded', 'instructionAdded')),
        actor TEXT NOT NULL CHECK (actor IN ('person', 'agent')),
        thread_id TEXT,
        last_message_key INTEGER,
        sender_address TEXT,
        headline TEXT,
        words TEXT,
        reason TEXT,
        until_ms INTEGER,
        undone_at_ms INTEGER,
        rule_id INTEGER,
        subject TEXT,
        instruction_id INTEGER
      );
      INSERT INTO agent_journal_new (id, at_ms, action, actor, thread_id, last_message_key,
                                     sender_address, headline, words, reason, until_ms,
                                     undone_at_ms, rule_id, subject)
        SELECT id, at_ms, action, actor, thread_id, last_message_key, sender_address, headline,
               words, reason, until_ms, undone_at_ms, rule_id, subject FROM agent_journal;
      DELETE FROM sqlite_sequence WHERE name = 'agent_journal_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'agent_journal_new', seq FROM sqlite_sequence WHERE name = 'agent_journal';
      DROP TABLE agent_journal;
      ALTER TABLE agent_journal_new RENAME TO agent_journal;
      CREATE INDEX agent_journal_thread ON agent_journal (thread_id);

      CREATE TABLE agent_ledger_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('analysis', 'prepare', 'remember', 'consent', 'revoke')),
        threads INTEGER NOT NULL
      );
      INSERT INTO agent_ledger_new (id, at_ms, runtime_id, account_id, purpose, threads)
        SELECT id, at_ms, runtime_id, account_id, purpose, threads FROM agent_ledger;
      DELETE FROM sqlite_sequence WHERE name = 'agent_ledger_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'agent_ledger_new', seq FROM sqlite_sequence WHERE name = 'agent_ledger';
      DROP TABLE agent_ledger;
      ALTER TABLE agent_ledger_new RENAME TO agent_ledger;
      CREATE INDEX agent_ledger_recent ON agent_ledger (at_ms DESC, id DESC);
    `,
  },
  {
    version: 29,
    // ADR 0057: who the person has written to, read from their Sent mail. The partial index holds
    // only that mail (bit 2 of `mailboxes`), so the question costs what was sent, not the mailbox.
    sql: `
      CREATE INDEX messages_sent ON messages (key) WHERE mailboxes & 2 != 0;
    `,
  },
  {
    version: 30,
    // ADR 0058: what ignoring a thing costs, and what names the matter of a thread. NULL on the
    // readings of an earlier analyzer version, which are not shown any more.
    sql: `
      ALTER TABLE agent_analyses ADD COLUMN consequence TEXT;
      ALTER TABLE agent_analyses ADD COLUMN case_name TEXT;
      ALTER TABLE agent_analyses ADD COLUMN anchors_json TEXT;
    `,
  },
  {
    version: 31,
    // ADR 0059: what a model said blocks what in a bundle, keyed by which threads at which messages
    // it was asked about. A new message makes a new key; old rows are harmless and few.
    sql: `
      CREATE TABLE agent_bundle_reads (
        signature TEXT PRIMARY KEY,
        edges_json TEXT NOT NULL,
        read_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 32,
    // ADR 0065: how many older threads of its series a feedback hid as well, as it was at the time.
    // NULL when none, and on the lines from before this, which said nothing about it.
    sql: `
      ALTER TABLE agent_journal ADD COLUMN also_covers INTEGER;
    `,
  },
  {
    version: 33,
    // ADR 0064, rule 3: the talk with the agent, kept on this machine. `thread_id` is NULL for the
    // talk of all mail. `quotes_json` holds the citations an answer was accepted with; `query` and
    // `hits_json` are the search and the threads of an answer of kind `found`. The ledger's CHECK on `purpose` has to allow `talk`; it is rebuilt as in 28, keeping
    // its rows, its ids and its index.
    sql: `
      CREATE TABLE agent_talk (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        at_ms INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('you', 'agent')),
        kind TEXT CHECK (kind IN ('answer', 'draft', 'question', 'closed', 'found')),
        text TEXT NOT NULL,
        quotes_json TEXT,
        runtime_name TEXT,
        model TEXT,
        threads INTEGER,
        query TEXT,
        hits_json TEXT
      );
      CREATE INDEX agent_talk_thread ON agent_talk (thread_id, id);

      CREATE TABLE agent_ledger_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('analysis', 'prepare', 'remember', 'talk', 'consent', 'revoke')),
        threads INTEGER NOT NULL
      );
      INSERT INTO agent_ledger_new (id, at_ms, runtime_id, account_id, purpose, threads)
        SELECT id, at_ms, runtime_id, account_id, purpose, threads FROM agent_ledger;
      DELETE FROM sqlite_sequence WHERE name = 'agent_ledger_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'agent_ledger_new', seq FROM sqlite_sequence WHERE name = 'agent_ledger';
      DROP TABLE agent_ledger;
      ALTER TABLE agent_ledger_new RENAME TO agent_ledger;
      CREATE INDEX agent_ledger_recent ON agent_ledger (at_ms DESC, id DESC);
    `,
  },
  {
    version: 34,
    // ADR 0066: what a reading says the thread asks of the person. `intent` is its own column so
    // that it can be read and counted without parsing; `reading_json` holds the rest (the passage
    // that shows the intent, the amount, the end of an offer, the passage that makes it personal,
    // the status) as one object, read whole. No CHECK on either: a newer build may write values
    // this one does not know, and they read as absent. NULL on readings of an earlier analyzer
    // version, which are not shown any more.
    //
    // `agent_feedback` learns why a thing was closed (rule 7): `outcome` ('done', 'notRelevant',
    // 'taken', 'declined'), and for a decline the folded name of the matter and its amount, so that
    // the same offer stays closed in the same year. Added by ALTER with no CHECK, so no table is
    // rebuilt and a newer build's values are read safely. NULL on feedback from before.
    sql: `
      ALTER TABLE agent_analyses ADD COLUMN intent TEXT;
      ALTER TABLE agent_analyses ADD COLUMN reading_json TEXT;
      ALTER TABLE agent_feedback ADD COLUMN outcome TEXT;
      ALTER TABLE agent_feedback ADD COLUMN case_key TEXT;
      ALTER TABLE agent_feedback ADD COLUMN amount_value REAL;
    `,
  },
  {
    version: 35,
    // ADR 0066, rule 6: whether a message is from a list or a program. `automated` is NULL for
    // almost all stored mail, since only mail parsed after the column existed has it. The partial
    // index holds only those unknown rows, so the sync's question ("which messages of this folder
    // still do not know") reads nothing once they all do, however large the mailbox. Newest first,
    // by account, as for Reply-To (version 19).
    sql: `
      CREATE INDEX messages_automated_unknown ON messages (account_id, key DESC)
        WHERE automated IS NULL;
    `,
  },
  {
    version: 36,
    // ADR 0068, rule 3: a rule can be about a kind of mail (`category`), which only a reading can say, so
    // it hides at read time. SQLite cannot change a CHECK in place, so `agent_rules` is rebuilt as
    // `agent_feedback` was in 25: same rows and ids, the wider CHECK, the AUTOINCREMENT counter carried
    // over so ids are never reused, and the partial unique index recreated. The journal points at
    // rules by id only, so it is untouched.
    sql: `
      CREATE TABLE agent_rules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('sender', 'domain', 'type', 'category')),
        subject TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('noReply')),
        actor TEXT NOT NULL CHECK (actor IN ('person', 'agent')),
        words TEXT,
        at_ms INTEGER NOT NULL,
        removed_at_ms INTEGER
      );
      INSERT INTO agent_rules_new (id, scope, subject, action, actor, words, at_ms, removed_at_ms)
        SELECT id, scope, subject, action, actor, words, at_ms, removed_at_ms FROM agent_rules;
      DELETE FROM sqlite_sequence WHERE name = 'agent_rules_new';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'agent_rules_new', seq FROM sqlite_sequence WHERE name = 'agent_rules';
      DROP TABLE agent_rules;
      ALTER TABLE agent_rules_new RENAME TO agent_rules;
      CREATE UNIQUE INDEX agent_rules_active ON agent_rules (scope, subject) WHERE removed_at_ms IS NULL;
    `,
  },
  {
    version: 37,
    // ADR 0074: files found by name. `file_fts` is a contentless trigram index with one row per
    // message (rowid = message key) over the folded names of its files; `file_starts` holds the
    // one- and two-character starts of their words, for texts too short for a trigram. The
    // backfill reads `message_attachments` once, in key order. A trigger drops both when a
    // message goes; `setAttachments` keeps them current otherwise.
    sql: `
      CREATE VIRTUAL TABLE file_fts USING fts5(
        names, content = '', contentless_delete = 1, tokenize = 'trigram'
      );
      CREATE TABLE file_starts (
        prefix TEXT NOT NULL,
        message_key INTEGER NOT NULL,
        PRIMARY KEY (prefix, message_key)
      ) WITHOUT ROWID;
      CREATE INDEX file_starts_message ON file_starts (message_key);
      CREATE TRIGGER file_index_gone AFTER DELETE ON messages BEGIN
        DELETE FROM file_starts WHERE message_key = old.key;
        DELETE FROM file_fts WHERE rowid = old.key;
      END;
    `,
    run: backfillFileIndex,
  },
  {
    version: 38,
    // ADR 0080: what a question across all mail leaves for the next one of the talk (the
    // hypothesis, the threads read, the queries run), as JSON on the answer. NULL on the rest.
    sql: `
      ALTER TABLE agent_talk ADD COLUMN carry_json TEXT;
    `,
  },
  {
    version: 39,
    // ADR 0083: what the loop did for an answer (searches run, threads opened in full), as JSON
    // on the answer. NULL on the rest, and on every answer of the trail of ADR 0080.
    sql: `
      ALTER TABLE agent_talk ADD COLUMN loop_json TEXT;
    `,
  },
  {
    version: 40,
    // ADR 0086: talks across all mail. `agent_talks` holds one row per talk; `title` is NULL until
    // the model or the person names it, and the list then names it by its first question.
    // `title_by` is 'model' or 'person', with no CHECK so a newer build's value reads as unknown.
    // Entries of all mail get `talk_id`; entries of a thread keep NULL there, the thread is their
    // talk. The old stream is cut into talks wherever two entries are more than two hours apart.
    sql: `
      CREATE TABLE agent_talks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at_ms INTEGER NOT NULL,
        last_at_ms INTEGER NOT NULL,
        title TEXT,
        title_by TEXT
      );
      CREATE INDEX agent_talks_recent ON agent_talks (last_at_ms DESC, id DESC);
      ALTER TABLE agent_talk ADD COLUMN talk_id INTEGER;
      CREATE INDEX agent_talk_talk ON agent_talk (talk_id, id);
    `,
    run: splitTalkAll,
  },
  {
    version: 41,
    // ADR 0088: HTML blocks are grouped by sender, so their group column is no longer a thread.
    // Renaming is schema only. `html_repack` lists HTML still kept per thread, with its sender;
    // the sync worker fills it from `fill_from` on in small steps after launch (reading every
    // message's sender at launch took 2.5 s on a cold cache), then moves it and leaves it empty.
    // `fill_from` is the next `html_index` key to list, NULL once the list is complete.
    sql: `
      ALTER TABLE html_blocks RENAME COLUMN thread_id TO grp;
      ALTER TABLE html_index RENAME COLUMN thread_id TO grp;
      CREATE TABLE html_repack (
        sender TEXT NOT NULL,
        key INTEGER NOT NULL,
        PRIMARY KEY (sender, key)
      ) WITHOUT ROWID;
      CREATE TABLE html_repack_state (fill_from INTEGER);
      INSERT INTO html_repack_state (fill_from) VALUES (-9223372036854775808);
    `,
  },
  {
    version: 42,
    // ADR 0089: one measurement of the database per day, for Settings › Storage. Bytes by the
    // group Settings shows; `file_bytes` is the whole file, `free_bytes` its unused pages.
    sql: `
      CREATE TABLE storage_samples (
        at_ms INTEGER PRIMARY KEY,
        messages INTEGER NOT NULL,
        file_bytes INTEGER NOT NULL,
        free_bytes INTEGER NOT NULL,
        search_bytes INTEGER NOT NULL,
        html_bytes INTEGER NOT NULL,
        text_bytes INTEGER NOT NULL,
        mail_bytes INTEGER NOT NULL
      );
    `,
  },
  {
    version: 43,
    // ADR 0087: the text the agent read from attached files. One row per part, kept with its
    // message (foreign keys are on, so deleting a message deletes its rows) and never the bytes.
    // `state` is 'ok' or 'no_text', with no CHECK so a newer build's value reads as unknown.
    // `storage_samples` gets its own column for the table (ADR 0087, rule 11).
    sql: `
      CREATE TABLE attachment_text (
        message_key INTEGER NOT NULL REFERENCES messages(key) ON DELETE CASCADE,
        part_id TEXT NOT NULL,
        text TEXT NOT NULL,
        pages INTEGER,
        state TEXT NOT NULL,
        extracted_ms INTEGER NOT NULL,
        PRIMARY KEY (message_key, part_id)
      ) WITHOUT ROWID;
      ALTER TABLE storage_samples ADD COLUMN files_text_bytes INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 44,
    // ADR 0090, rule 1: a PDF whose text layer was only headers and footers was kept as 'ok'.
    // The rows are a copy of what is on the server (ADR 0087, rule 6), so the PDF ones (the only
    // rows with a page count) go, and the next read extracts them again under the new rule.
    sql: `
      DELETE FROM attachment_text WHERE state = 'ok' AND pages IS NOT NULL;
    `,
  },
  {
    version: 45,
    // ADR 0091: a reply joins the thread it answers. What each message on a local thread points
    // to is kept, one row per id, and a message is found by its Message-ID. Mail stored before
    // this points to the root its thread names, and threads that meet are merged once.
    sql: `
      CREATE TABLE IF NOT EXISTS message_refs (
        key INTEGER NOT NULL REFERENCES messages(key) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        PRIMARY KEY (key, ref_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS message_refs_ref ON message_refs (account_id, ref_id);
      CREATE INDEX IF NOT EXISTS messages_message_id ON messages (account_id, message_id_header);
    `,
    run: (db) => {
      rethreadStoredMail(db);
    },
  },
  {
    version: 46,
    // ADR 0092, rule 4: a copy of a message is not shown twice. A message is a copy when the same
    // account holds the same Message-ID in the same mailboxes under a smaller key; `copy_of` is
    // that key, NULL for the one shown. Triggers keep it right whatever writes or deletes a row.
    sql: "",
    run: (db) => {
      const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
      if (!columns.some((c) => c.name === "copy_of")) {
        db.exec("ALTER TABLE messages ADD COLUMN copy_of INTEGER");
      }
      db.exec(`
        ${COPY_TRIGGERS_SQL}
        UPDATE messages SET copy_of = (${COPY_OF_SQL})
         WHERE message_id_header != ''
           AND EXISTS (SELECT 1 FROM messages o
                        WHERE o.account_id = messages.account_id
                          AND o.message_id_header = messages.message_id_header
                          AND o.key <> messages.key);
      `);
    },
  },
  {
    version: 47,
    // ADR 0102: what the agent offered with an answer across all mail (views, clean-ups, messages,
    // as the code accepted them) and the counts by code the answer rests on, as JSON on the
    // answer. NULL on the rest. Added only when missing, so that a database rolled back to an
    // older version opens again.
    sql: "",
    run: (db) => {
      const columns = db.prepare("PRAGMA table_info(agent_talk)").all() as { name: string }[];
      for (const name of ["offers_json", "facts_json"]) {
        if (!columns.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE agent_talk ADD COLUMN ${name} TEXT`);
        }
      }
    },
  },
  {
    version: 48,
    // ADR 0104: a reply that points to nothing joins, by its subject, the thread where the person
    // wrote to its sender. Its lookup reads one account's mail of 30 days, on this index. Mail
    // stored before is joined once, oldest first, so a chain of such replies becomes one thread.
    sql: `
      CREATE INDEX IF NOT EXISTS messages_account_date ON messages (account_id, date_ms);
    `,
    run: (db) => {
      joinStoredRepliesBySubject(db);
    },
  },
  {
    version: 49,
    // ADR 0111: bulk mail without list headers says so at the foot of its text. Stored mail not
    // yet marked automated is read for that once, newest first, in small steps on the sync
    // worker after launch (\`AutomatedFromBodies\`), not here: reading every body at launch would
    // cost seconds. This row is where the next step starts (the largest safe integer, above
    // every key); the last step deletes it. No column and no index: the steps walk the primary key.
    sql: `
      INSERT OR IGNORE INTO counters (name, value)
        VALUES ('automated_body_before', 9007199254740991);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Runs `fn` atomically; rolls back and rethrows on error. Outside a transaction it opens one
 * (BEGIN IMMEDIATE); inside one, e.g. a unit of work, it uses a savepoint, so the method stays
 * atomic on its own and a caught error leaves no partial writes behind.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT matters_sp" : "BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec(nested ? "RELEASE matters_sp" : "COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec(nested ? "ROLLBACK TO matters_sp; RELEASE matters_sp" : "ROLLBACK");
    }
    throw error;
  }
}

/** Runs `fn` on a consistent snapshot. On a reader connection that needs an explicit read transaction. */
export function readTransaction<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    if (db.isTransaction) db.exec("COMMIT");
  }
}

/** Serialization state of the writer connection; one per connection. */
interface WriterState {
  /** Marks async call chains running inside the open unit of work. */
  readonly context: AsyncLocalStorage<{ open: boolean }>;
  /** Resolves when everything queued so far has finished. */
  tail: Promise<void>;
  /** Units and queued writes not finished yet. */
  pending: number;
}

const writers = new WeakMap<Database, WriterState>();

function writerState(db: Database): WriterState {
  let state = writers.get(db);
  if (!state) {
    state = { context: new AsyncLocalStorage(), tail: Promise.resolve(), pending: 0 };
    writers.set(db, state);
  }
  return state;
}

function enqueue<T>(state: WriterState, task: () => Promise<T>): Promise<T> {
  state.pending++;
  const result = state.tail.then(async () => {
    try {
      return await task();
    } finally {
      state.pending--;
    }
  });
  state.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** True while the current async call chain runs inside an open unit of work. */
function insideUnit(state: WriterState): boolean {
  return state.context.getStore()?.open === true;
}

/**
 * Runs a write that is not part of a unit of work. Idle writer: runs at once, synchronously.
 * While a unit is open or queued: waits its turn, so it never lands inside someone else's
 * transaction. Inside the unit's own call chain it runs at once and joins the unit.
 */
export function exclusive<T>(db: Database, fn: () => T): Promise<T> {
  const state = writerState(db);
  try {
    if (state.pending === 0 || insideUnit(state)) return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
  return enqueue(state, async () => fn());
}

/** `exclusive` plus `transaction`: the standard shape of a multi-statement write method. */
export function write<T>(db: Database, fn: () => T): Promise<T> {
  return exclusive(db, () => transaction(db, fn));
}

/** SQLite unit of work on the writer connection: BEGIN IMMEDIATE ... COMMIT / ROLLBACK. */
export class SqliteUnitOfWork implements UnitOfWorkPort {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const state = writerState(this.db);
    if (insideUnit(state)) return work();
    return enqueue(state, async () => {
      const token = { open: true };
      try {
        return await state.context.run(token, () => this.runOpen(work));
      } finally {
        token.open = false;
      }
    });
  }

  private async runOpen<T>(work: () => Promise<T>): Promise<T> {
    const { db } = this;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}

function currentVersion(db: Database): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * Called before each step of an update of a database that already held mail: step `step` (from 1) of
 * `total`. A new, empty database is created, not updated, and is not reported (ADR 0103, rule 1).
 */
export type MigrationStep = (step: number, total: number) => void;

export function migrate(db: Database, onStep?: MigrationStep): void {
  const current = currentVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${LATEST_SCHEMA_VERSION})`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  for (const [index, migration] of pending.entries()) {
    if (current > 0) onStep?.(index + 1, pending.length);
    transaction(db, () => {
      db.exec(migration.sql);
      migration.run?.(db);
      db.prepare("INSERT INTO schema_version (version, applied_at_ms) VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      );
    });
  }
}

/** Opens (creating if needed) and migrates a database. `":memory:"` is allowed. */
export function openDatabase(path: string, onStep?: MigrationStep): Database {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
      PRAGMA cache_size = -65536;
      PRAGMA foreign_keys = ON;
    `);
    migrate(db, onStep);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Opens a read-only connection to a database `openDatabase` already created. In WAL mode it
 * sees committed data only, never a transaction the writer has open.
 */
export function openReader(path: string): Database {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
      PRAGMA cache_size = -65536;
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Opens a read-only connection to a database that exists, is in WAL mode and is already at this
 * build's schema version, without waiting for the writer to open it: nothing is left to migrate,
 * so a reader can never see a half-migrated schema. Returns null in every other case (no file,
 * an unreadable or foreign file, no WAL, an older schema that the writer has to migrate first, a
 * newer one that the writer will refuse); the caller then waits for the writer, as it always did.
 * Never creates, writes or migrates anything.
 */
export function openReaderIfCurrent(path: string): Database | null {
  if (path === ":memory:" || !existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = openReader(path);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    if (mode.journal_mode !== "wal") throw new Error("not in WAL mode");
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number | null;
    };
    if (row.v !== LATEST_SCHEMA_VERSION) throw new Error("not at the current schema version");
    return db;
  } catch {
    db?.close();
    return null;
  }
}

export function schemaVersion(db: Database): number {
  return currentVersion(db);
}
