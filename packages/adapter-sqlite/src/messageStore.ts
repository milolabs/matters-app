import type {
  AttachmentAnswer,
  AutomatedAnswer,
  CandidateThread,
  Changes,
  FlagUpdate,
  GetThreadOptions,
  Label,
  LabelRole,
  ListNewestOptions,
  LocationEntry,
  LocationRemoval,
  Message,
  MessageAttachments,
  MessageLocation,
  MessageStorePort,
  Participant,
  Placement,
  PlaceOfCopy,
  ReceivedAttachment,
  ReceivedMail,
  ReplyToAnswer,
  SenderAuth,
  SenderCount,
  SentMail,
  SetPlacementResult,
  SetSeenResult,
  Thread,
  ThreadView,
  UpsertResult,
  WrittenTo,
} from "@matters/core";
import {
  computeMailboxes,
  folderRoles,
  foldText,
  HIDDEN_MAILBOXES,
  MAILBOX_BIT,
  MESSAGE_KEY_SEQ_LIMIT,
  messageKey,
} from "@matters/core";
import { type Database, readTransaction, write } from "./database.ts";
import { type FileIndexWriter, fileIndexWriter } from "./fileIndex.ts";
import { ThreadJoiner } from "./threadJoin.ts";

const MAX_LABELS = 500;
const SEEN = 1;
const FLAGGED = 2;
const ANSWERED = 4;
const DRAFT = 8;

interface MessageRow {
  key: number;
  account_id: string;
  provider_id: string;
  thread_id: string;
  message_id_header: string;
  date_ms: number;
  from_json: string;
  to_json: string;
  cc_json: string;
  subject: string;
  snippet: string;
  flags: number;
  has_attachments: number;
  sender_auth: string;
  reply_to_json: string | null;
  automated: number | null;
  mailboxes: number;
  labels_json: string;
}

interface ThreadRow extends MessageRow {
  attachments_known: number;
  attachments_json: string;
  inline_count: number;
}

/**
 * Which UIDs of one folder belong to messages whose attachments are not known yet (ADR 0043).
 * Forced onto the partial index of unknown rows, as `UNKNOWN_REPLY_TO_SQL` is: with nothing
 * unknown it reads one empty index, at any mailbox size.
 */
export const UNKNOWN_ATTACHMENTS_SQL = `
  SELECT l.uid
    FROM messages m INDEXED BY messages_attachments_unknown
    CROSS JOIN message_locations l INDEXED BY message_locations_message
   WHERE m.account_id = ? AND m.has_attachments = 1 AND m.attachments_known = 0
     AND l.message_key = m.key AND l.account_id = m.account_id
     AND l.folder_id = ? AND l.uid_validity = ?
   ORDER BY m.key DESC
   LIMIT ?`;

function attachmentsOf(json: string): ReceivedAttachment[] {
  const rows = JSON.parse(json) as {
    partId: string;
    name: string;
    mimeType: string;
    size: number;
    contentId: string | null;
  }[];
  return rows.map((r) => ({
    partId: r.partId,
    name: r.name,
    mimeType: r.mimeType,
    size: r.size,
    inline: false,
    ...(r.contentId === null ? {} : { contentId: r.contentId }),
  }));
}

const MESSAGE_COLUMNS = `
  m.key, m.account_id, m.provider_id, m.thread_id, m.message_id_header, m.date_ms,
  m.from_json, m.to_json, m.cc_json, m.subject, m.snippet, m.flags, m.has_attachments,
  m.sender_auth, m.reply_to_json, m.automated, m.mailboxes,
  (SELECT json_group_array(l.label_id ORDER BY l.pos)
     FROM message_labels l WHERE l.message_key = m.key) AS labels_json`;

const SELECT_MESSAGE = `SELECT ${MESSAGE_COLUMNS} FROM messages m`;

/**
 * A thread's messages with their files in the same statement (ADR 0043, rule 1), so opening a
 * thread asks the database once however many messages it has. Inline parts are kept in the table
 * but are not listed.
 */
export const SELECT_THREAD_SQL = `
  SELECT ${MESSAGE_COLUMNS}, m.attachments_known,
         (SELECT json_group_array(json_object(
                   'partId', a.part_id, 'name', a.name, 'mimeType', a.mime_type,
                   'size', a.size, 'contentId', a.content_id) ORDER BY a.position)
            FROM message_attachments a
           WHERE a.message_key = m.key AND a.inline = 0) AS attachments_json,
         (SELECT count(*) FROM message_attachments a
           WHERE a.message_key = m.key AND a.inline = 1) AS inline_count
    FROM messages m
   WHERE m.thread_id = ?
   ORDER BY m.key`;

/** The same without the messages in Trash and Spam: a thread as it is shown outside them (ADR 0044). */
export const SELECT_VISIBLE_THREAD_SQL = SELECT_THREAD_SQL.replace(
  "WHERE m.thread_id = ?",
  // A second copy of one message is not shown (ADR 0092, rule 4); moves still take every copy.
  `WHERE m.thread_id = ? AND m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.copy_of IS NULL`,
);

/**
 * `All mail`, newest first: forced onto the partial index of messages that are not in Trash or
 * Spam, so the walk never reads a deleted row and needs no sort (ADR 0044, rule 2).
 */
export const NEWEST_VISIBLE_SQL = `
  SELECT ${MESSAGE_COLUMNS}
    FROM messages m INDEXED BY messages_visible
   WHERE m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.copy_of IS NULL AND m.key < ?
   ORDER BY m.key DESC LIMIT ?`;

/**
 * The threads agents may read (ADR 0052), first step: walk the visible messages from the newest
 * down to the start of the window, on the same partial index as `All mail`. The walk stops as soon
 * as the caller has enough threads, so its cost follows the window, not the mailbox (ADR 0012).
 * Forced onto the index so that it cannot be traded for a scan of the table.
 */
/** ADR 0057. `messages_sent` holds only Sent mail, so this reads what was sent and nothing else. */
const WRITTEN_TO_SQL = `
  SELECT lower(json_extract(p.value, '$.address')) AS address, count(DISTINCT m.key) AS sent,
         max(m.date_ms) AS last_ms, max(json_extract(p.value, '$.name')) AS name
    FROM messages m
    JOIN json_each(json_array(m.to_json, m.cc_json)) l
    JOIN json_each(l.value) p
   WHERE m.mailboxes & 2 != 0
   GROUP BY 1
`;

/**
 * ADR 0070, rule 1: the person's Sent mail, newest first, on its own partial index, so its cost
 * follows what was sent.
 */
export const SENT_MAIL_SQL = `
  SELECT m.subject, m.to_json, m.cc_json
    FROM messages m INDEXED BY messages_sent
   WHERE m.mailboxes & 2 != 0 AND m.mailboxes & ${HIDDEN_MAILBOXES} = 0
   ORDER BY m.key DESC`;

/**
 * ADR 0070, rule 1: mail that reached the person since a key, newest first, on the same partial index
 * as `All mail`, so its cost follows the window.
 */
export const RECEIVED_MAIL_SQL = `
  SELECT m.key, m.thread_id, lower(json_extract(m.from_json, '$.address')) AS sender
    FROM messages m INDEXED BY messages_visible
   WHERE m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.mailboxes & 2 = 0 AND m.key >= ?
   ORDER BY m.key DESC`;

/**
 * ADR 0102: who wrote most since a key, per sender or per domain, on the partial index of `All
 * mail`, so the walk follows the window. A bare column next to the one `max()` takes the newest
 * row's value, so a sender's name is the latest one.
 */
const senderCountsSql = (by: "sender" | "domain") => `
  WITH w AS (
    SELECT lower(json_extract(m.from_json, '$.address')) AS address,
           json_extract(m.from_json, '$.name') AS name, m.key, m.flags
      FROM messages m INDEXED BY messages_visible
     WHERE m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.mailboxes & 2 = 0 AND m.copy_of IS NULL
       AND m.key >= ? AND m.account_id IN (SELECT value FROM json_each(?))
  )
  SELECT ${by === "sender" ? "address" : "substr(address, instr(address, '@') + 1)"} AS k,
         ${by === "sender" ? "name" : "NULL"} AS name, count(*) AS n,
         sum(flags & 1 = 0) AS unread, max(key) AS newest
    FROM w
   WHERE address IS NOT NULL AND address != ''
   GROUP BY k
   ORDER BY n DESC, newest DESC
   LIMIT ?`;

export const THREAD_WALK_SQL = `
  SELECT m.thread_id
    FROM messages m INDEXED BY messages_visible
   WHERE m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.key >= ?
   ORDER BY m.key DESC`;

/**
 * Second step: all visible messages of the threads found, in one statement, from the thread
 * index, oldest first. Only what a candidate needs; no text, no HTML.
 */
export const THREAD_MEMBERS_SQL = `
  SELECT m.thread_id, m.key, m.account_id, m.date_ms, m.mailboxes, m.automated, m.subject,
         lower(json_extract(m.from_json, '$.address')) AS sender
    FROM messages m
   WHERE m.thread_id IN (SELECT value FROM json_each(?))
     AND m.mailboxes & ${HIDDEN_MAILBOXES} = 0 AND m.copy_of IS NULL
   ORDER BY m.thread_id, m.key`;

interface MemberRow {
  thread_id: string;
  key: number;
  account_id: string;
  date_ms: number;
  mailboxes: number;
  automated: number | null;
  subject: string;
  sender: string | null;
}

/**
 * Which UIDs of one folder belong to messages that do not know their `Reply-To` (ADR 0042).
 * Driven by the partial index of unknown rows, forced so that it cannot be traded for a walk over
 * the folder's locations: with nothing unknown this reads one empty index, at any mailbox size.
 */
export const UNKNOWN_REPLY_TO_SQL = `
  SELECT l.uid
    FROM messages m INDEXED BY messages_reply_to_unknown
    CROSS JOIN message_locations l INDEXED BY message_locations_message
   WHERE m.account_id = ? AND m.reply_to_json IS NULL
     AND l.message_key = m.key AND l.account_id = m.account_id
     AND l.folder_id = ? AND l.uid_validity = ?
   ORDER BY m.key DESC
   LIMIT ?`;

/**
 * Which UIDs of one folder belong to messages that do not know whether they are automated (ADR
 * 0066, rule 6). Driven by the partial index of unknown rows, forced for the same reason as
 * `UNKNOWN_REPLY_TO_SQL`: once every message knows, this reads one empty index.
 */
export const UNKNOWN_AUTOMATED_SQL = `
  SELECT l.uid
    FROM messages m INDEXED BY messages_automated_unknown
    CROSS JOIN message_locations l INDEXED BY message_locations_message
   WHERE m.account_id = ? AND m.automated IS NULL
     AND l.message_key = m.key AND l.account_id = m.account_id
     AND l.folder_id = ? AND l.uid_validity = ?
   ORDER BY m.key DESC
   LIMIT ?`;

function participant(p: Participant): Participant {
  return p.name === undefined ? { address: p.address } : { name: p.name, address: p.address };
}

/** A value this build does not know (a newer one wrote it) reads as unknown. */
function senderAuth(value: string): SenderAuth {
  return value === "pass" || value === "fail" ? value : "unknown";
}

function toMessage(row: MessageRow): Message {
  return {
    key: row.key,
    accountId: row.account_id,
    providerId: row.provider_id,
    threadId: row.thread_id,
    messageIdHeader: row.message_id_header,
    dateMs: row.date_ms,
    from: JSON.parse(row.from_json) as Participant,
    to: JSON.parse(row.to_json) as Participant[],
    cc: JSON.parse(row.cc_json) as Participant[],
    subject: row.subject,
    snippet: row.snippet,
    flags: {
      seen: (row.flags & SEEN) !== 0,
      flagged: (row.flags & FLAGGED) !== 0,
      answered: (row.flags & ANSWERED) !== 0,
      draft: (row.flags & DRAFT) !== 0,
    },
    labelIds: JSON.parse(row.labels_json) as string[],
    hasAttachments: row.has_attachments !== 0,
    senderAuth: senderAuth(row.sender_auth),
    ...(row.reply_to_json === null
      ? {}
      : { replyTo: JSON.parse(row.reply_to_json) as Participant[] }),
    ...(row.automated === null ? {} : { automated: row.automated !== 0 }),
    mailboxes: row.mailboxes,
  };
}

/** What a folder row holds, as `Label`. */
interface FolderRow {
  account_id: string;
  folder_id: string;
  name: string;
  role: string;
  exclusive: number;
}

/**
 * The role a label stands for, in SQL: its folder's, else a system label by name (`roleOfLabel`).
 * `l` is a row of `message_labels`, `f` the folder of the same id or NULL.
 */
const LABEL_ROLE_SQL = `coalesce(f.role, CASE l.label_fold
  WHEN 'inbox' THEN 'inbox' WHEN 'sent' THEN 'sent' WHEN 'draft' THEN 'drafts'
  WHEN 'drafts' THEN 'drafts' WHEN 'trash' THEN 'trash' WHEN 'spam' THEN 'spam' END)`;

/**
 * `computeMailboxes` for every message of an account in one statement, for when what its folders
 * are has changed: the first sync after the migration reads every folder of a large mailbox, and
 * a statement per message would hold the writer for a minute (ADR 0044, rule 2). Returns the
 * keys whose mailboxes changed, marked with the new change sequence (`:seq`). The tests hold it
 * to the same answers as the per-message code.
 */
const RECOMPUTE_MAILBOXES_SQL = `
  WITH wanted (key, bits) AS (
    SELECT m.key, coalesce((
      SELECT SUM(DISTINCT b.bit) FROM (
        SELECT CASE ${LABEL_ROLE_SQL}
                 WHEN 'inbox' THEN 1 WHEN 'sent' THEN 2 WHEN 'drafts' THEN 4 WHEN 'trash' THEN 8
                 WHEN 'spam' THEN 16 WHEN 'archive' THEN 32 ELSE 64 END AS bit
          FROM message_labels l
          LEFT JOIN folders f ON f.account_id = m.account_id AND f.folder_id = l.label_id
         WHERE l.message_key = m.key
        UNION ALL
        SELECT CASE c.role
                 WHEN 'trash' THEN 8
                 WHEN 'spam' THEN 16
                 WHEN 'archive' THEN CASE WHEN EXISTS (
                   SELECT 1 FROM message_labels l
                   LEFT JOIN folders f ON f.account_id = m.account_id AND f.folder_id = l.label_id
                   WHERE l.message_key = m.key AND ${LABEL_ROLE_SQL} = 'inbox') THEN 0 ELSE 32 END
                 ELSE 0 END AS bit
          FROM message_locations ml
          JOIN folders c ON c.account_id = ml.account_id AND c.folder_id = ml.folder_id
         WHERE ml.message_key = m.key AND c.exclusive = 0
      ) b), 0)
      FROM messages m WHERE m.account_id = :account
  )
  UPDATE messages SET mailboxes = wanted.bits, change_seq = :seq
    FROM wanted
   WHERE messages.key = wanted.key AND messages.mailboxes != wanted.bits
  RETURNING messages.key`;

function toFolder(row: FolderRow): Label {
  return {
    id: row.folder_id,
    accountId: row.account_id,
    name: row.name,
    role: row.role as LabelRole,
    exclusive: row.exclusive !== 0,
  };
}

function flagBits(f: Message["flags"]): number {
  return (
    (f.seen ? SEEN : 0) |
    (f.flagged ? FLAGGED : 0) |
    (f.answered ? ANSWERED : 0) |
    (f.draft ? DRAFT : 0)
  );
}

export class SqliteMessageStore implements MessageStorePort {
  private readonly selectIdentity;
  private readonly selectOwner;
  private readonly insertMessage;
  private readonly updateMessage;
  private readonly deleteLabels;
  private readonly insertLabel;
  private readonly readSeq;
  private readonly writeSeq;
  private readonly selectByKeys;
  private readonly selectThread;
  private readonly selectVisibleThread;
  /** Prepared on first use: it names an index that databases older than ADR 0044 do not have. */
  private selectNewest: ReturnType<Database["prepare"]> | undefined;
  private readonly selectNewestLabel;
  private readonly selectNewestLabelBefore;
  private readonly selectChanges;
  private readonly selectRemovedChanges;
  private readonly selectIdentities;
  private readonly deleteByKeys;
  private readonly selectAccountKeys;
  private readonly deleteAccountMessages;
  private readonly insertTombstone;
  private readonly upsertLocation;
  private readonly selectLocationKey;
  private readonly deleteLocation;
  private readonly selectFolderKeys;
  private readonly selectFolderKeysExcept;
  private readonly deleteFolderLocations;
  private readonly deleteFolderLocationsExcept;
  private readonly hasLocation;
  private readonly selectLocationUids;
  private readonly selectKeyLocations;
  private readonly selectKeyFolders;
  private readonly selectLabelIds;
  private readonly selectFlags;
  private readonly updateFlagBits;
  private readonly touchMessage;
  private readonly selectKeysInRange;
  private readonly keyExists;
  /** Prepared on first use: it names an index that databases older than ADR 0042 do not have. */
  private selectUnknownReplyTo: ReturnType<Database["prepare"]> | undefined;
  private selectUnknownAutomated: ReturnType<Database["prepare"]> | undefined;
  private sentMail: ReturnType<Database["prepare"]> | undefined;
  private receivedMail: ReturnType<Database["prepare"]> | undefined;
  private senderCounts: ReturnType<Database["prepare"]> | undefined;
  private domainCounts: ReturnType<Database["prepare"]> | undefined;
  private readonly writeAutomated;
  /** Prepared on first use: they name the partial index of version 21. */
  private walkThreads: ReturnType<Database["prepare"]> | undefined;
  private threadMembers: ReturnType<Database["prepare"]> | undefined;
  private writtenTo: ReturnType<Database["prepare"]> | undefined;
  private readonly writeReplyTo;
  /** Prepared on first use, like the reply-to one: it names an index of version 20. */
  private selectUnknownAttachments: ReturnType<Database["prepare"]> | undefined;
  private readonly selectAttachment;
  private readonly deleteAttachments;
  private readonly insertAttachment;
  private readonly fileIndex: FileIndexWriter;
  private readonly selectAttachmentFlag;
  private readonly writeAttachmentFacts;
  private readonly writeMailboxes;
  private readonly selectFolders;
  private readonly selectAccountFolders;
  private readonly insertFolder;
  private readonly deleteAccountFolders;
  private readonly selectKeyAccount;
  private readonly selectMailboxes;
  private readonly selectLabelCopies;
  private readonly selectMessageLabels;
  /** Prepared on first use: only a sync that finds the folders changed needs it. */
  private recomputeMailboxes: ReturnType<Database["prepare"]> | undefined;

  private readonly firstLabel;
  private readonly nextLabel;

  private readonly db: Database;
  private readonly joiner: ThreadJoiner;
  private readonly selectThreadOf;

  constructor(db: Database) {
    this.db = db;
    this.joiner = new ThreadJoiner(db);
    this.selectThreadOf = db.prepare("SELECT thread_id FROM messages WHERE key = ?");
    this.selectIdentity = db.prepare(
      "SELECT key FROM messages WHERE account_id = ? AND provider_id = ?",
    );
    this.selectOwner = db.prepare("SELECT account_id, provider_id FROM messages WHERE key = ?");
    this.insertMessage = db.prepare(`
      INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
                            from_json, to_json, cc_json, subject, snippet, flags, has_attachments,
                            change_seq, sender_auth, reply_to_json, attachments_known, mailboxes,
                            automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.updateMessage = db.prepare(`
      UPDATE messages SET thread_id = ?, message_id_header = ?, date_ms = ?, from_json = ?,
                          to_json = ?, cc_json = ?, subject = ?, snippet = ?, flags = ?,
                          has_attachments = ?, change_seq = ?, sender_auth = ?,
                          reply_to_json = coalesce(?, reply_to_json),
                          automated = coalesce(?, automated),
                          -- A message that now claims files it did not claim before has to
                          -- have its structure read; one that already did is left as it is.
                          attachments_known = CASE WHEN ? = 1 AND has_attachments = 0
                                                   THEN 0 ELSE attachments_known END,
                          mailboxes = ?
       WHERE key = ?`);
    this.deleteLabels = db.prepare("DELETE FROM message_labels WHERE message_key = ?");
    this.insertLabel = db.prepare(
      "INSERT OR IGNORE INTO message_labels (label_id, message_key, pos, label_fold) VALUES (?, ?, ?, ?)",
    );
    this.firstLabel = db.prepare("SELECT MIN(label_fold) AS l FROM message_labels");
    this.nextLabel = db.prepare(
      "SELECT MIN(label_fold) AS l FROM message_labels WHERE label_fold > ?",
    );
    this.readSeq = db.prepare("SELECT value FROM counters WHERE name = 'change_seq'");
    this.writeSeq = db.prepare("UPDATE counters SET value = ? WHERE name = 'change_seq'");
    this.selectByKeys = db.prepare(
      `${SELECT_MESSAGE} WHERE m.key IN (SELECT value FROM json_each(?))`,
    );
    this.selectThread = db.prepare(SELECT_THREAD_SQL);
    this.selectVisibleThread = db.prepare(SELECT_VISIBLE_THREAD_SQL);
    // Driven from the label index: newest first without sorting.
    const byLabel = `
      SELECT m.key, m.account_id, m.provider_id, m.thread_id, m.message_id_header, m.date_ms,
             m.from_json, m.to_json, m.cc_json, m.subject, m.snippet, m.flags, m.has_attachments,
             m.sender_auth, m.reply_to_json, m.automated, m.mailboxes,
             (SELECT json_group_array(x.label_id ORDER BY x.pos)
                FROM message_labels x WHERE x.message_key = m.key) AS labels_json
        FROM message_labels l JOIN messages m ON m.key = l.message_key`;
    this.selectNewestLabel = db.prepare(
      `${byLabel} WHERE l.label_id = ? ORDER BY l.message_key DESC LIMIT ?`,
    );
    this.selectNewestLabelBefore = db.prepare(
      `${byLabel} WHERE l.label_id = ? AND l.message_key < ? ORDER BY l.message_key DESC LIMIT ?`,
    );
    this.selectChanges = db.prepare(
      "SELECT key FROM messages WHERE change_seq > ? ORDER BY change_seq, key",
    );
    this.selectRemovedChanges = db.prepare(
      `SELECT r.key FROM removed_messages r
        WHERE r.change_seq > ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.key = r.key)
        ORDER BY r.change_seq, r.key`,
    );
    this.selectIdentities = db.prepare(
      `SELECT provider_id, key FROM messages
        WHERE account_id = ? AND provider_id IN (SELECT value FROM json_each(?))`,
    );
    this.deleteByKeys = db.prepare(
      "DELETE FROM messages WHERE key IN (SELECT value FROM json_each(?))",
    );
    this.selectAccountKeys = db.prepare("SELECT key FROM messages WHERE account_id = ?");
    this.deleteAccountMessages = db.prepare("DELETE FROM messages WHERE account_id = ?");
    this.insertTombstone = db.prepare(
      "INSERT OR REPLACE INTO removed_messages (key, change_seq) VALUES (?, ?)",
    );
    this.upsertLocation = db.prepare(`
      INSERT INTO message_locations (account_id, folder_id, uid_validity, uid, message_key)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_id, folder_id, uid_validity, uid)
      DO UPDATE SET message_key = excluded.message_key`);
    this.selectLocationKey = db.prepare(
      `SELECT message_key FROM message_locations
        WHERE account_id = ? AND folder_id = ? AND uid_validity = ? AND uid = ?`,
    );
    this.deleteLocation = db.prepare(
      `DELETE FROM message_locations
        WHERE account_id = ? AND folder_id = ? AND uid_validity = ? AND uid = ?`,
    );
    this.selectFolderKeys = db.prepare(
      `SELECT DISTINCT message_key FROM message_locations WHERE account_id = ? AND folder_id = ?`,
    );
    this.selectFolderKeysExcept = db.prepare(
      `SELECT DISTINCT message_key FROM message_locations
        WHERE account_id = ? AND folder_id = ? AND uid_validity != ?`,
    );
    this.deleteFolderLocations = db.prepare(
      "DELETE FROM message_locations WHERE account_id = ? AND folder_id = ?",
    );
    this.deleteFolderLocationsExcept = db.prepare(
      "DELETE FROM message_locations WHERE account_id = ? AND folder_id = ? AND uid_validity != ?",
    );
    this.hasLocation = db.prepare(
      "SELECT 1 AS x FROM message_locations WHERE message_key = ? LIMIT 1",
    );
    this.selectLocationUids = db.prepare(
      `SELECT uid FROM message_locations
        WHERE account_id = ? AND folder_id = ? AND uid_validity = ? ORDER BY uid`,
    );
    this.selectKeyLocations = db.prepare(
      `SELECT account_id, folder_id, uid_validity, uid FROM message_locations
        WHERE message_key = ? ORDER BY folder_id, uid_validity, uid`,
    );
    this.selectKeyFolders = db.prepare(
      "SELECT DISTINCT folder_id FROM message_locations WHERE message_key = ? ORDER BY folder_id",
    );
    this.selectLabelIds = db.prepare(
      "SELECT label_id FROM message_labels WHERE message_key = ? ORDER BY pos",
    );
    this.selectFlags = db.prepare("SELECT flags FROM messages WHERE key = ?");
    this.updateFlagBits = db.prepare("UPDATE messages SET flags = ?, change_seq = ? WHERE key = ?");
    this.touchMessage = db.prepare("UPDATE messages SET change_seq = ? WHERE key = ?");
    this.selectKeysInRange = db.prepare("SELECT key FROM messages WHERE key >= ? AND key < ?");
    this.keyExists = db.prepare("SELECT 1 AS x FROM messages WHERE key = ?");
    this.writeReplyTo = db.prepare(
      "UPDATE messages SET reply_to_json = ? WHERE key = ? AND reply_to_json IS NULL",
    );
    this.writeAutomated = db.prepare(
      "UPDATE messages SET automated = ? WHERE key = ? AND automated IS NULL",
    );
    this.selectAttachment = db.prepare(
      `SELECT part_id, name, mime_type, size, content_id, inline
         FROM message_attachments WHERE message_key = ? AND part_id = ?`,
    );
    this.deleteAttachments = db.prepare("DELETE FROM message_attachments WHERE message_key = ?");
    this.insertAttachment = db.prepare(
      `INSERT OR REPLACE INTO message_attachments
         (message_key, part_id, position, name, mime_type, size, content_id, inline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.fileIndex = fileIndexWriter(db);
    this.selectAttachmentFlag = db.prepare("SELECT has_attachments FROM messages WHERE key = ?");
    this.writeAttachmentFacts = db.prepare(
      "UPDATE messages SET has_attachments = ?, attachments_known = 1 WHERE key = ?",
    );
    this.writeMailboxes = db.prepare("UPDATE messages SET mailboxes = ? WHERE key = ?");
    this.selectFolders = db.prepare(
      "SELECT account_id, folder_id, name, role, exclusive FROM folders ORDER BY account_id, folder_id",
    );
    this.selectAccountFolders = db.prepare(
      "SELECT account_id, folder_id, name, role, exclusive FROM folders WHERE account_id = ? ORDER BY folder_id",
    );
    this.insertFolder = db.prepare(
      "INSERT INTO folders (account_id, folder_id, name, role, exclusive) VALUES (?, ?, ?, ?, ?)",
    );
    this.deleteAccountFolders = db.prepare("DELETE FROM folders WHERE account_id = ?");
    this.selectKeyAccount = db.prepare("SELECT account_id, mailboxes FROM messages WHERE key = ?");
    this.selectMailboxes = db.prepare("SELECT mailboxes FROM messages WHERE key = ?");
    this.selectMessageLabels = this.selectLabelIds;
    // The copies that sit in a folder where labels are the places (Gmail's All Mail, Trash, Spam).
    this.selectLabelCopies = db.prepare(
      `SELECT f.role AS role FROM message_locations l
         JOIN folders f ON f.account_id = l.account_id AND f.folder_id = l.folder_id
        WHERE l.message_key = ? AND f.exclusive = 0`,
    );
  }

  /** The account's folders as `roleOfLabel` and `computeMailboxes` want them. */
  private folderBook(
    book: Map<string, ReadonlyMap<string, LabelRole> | undefined>,
    accountId: string,
  ): ReadonlyMap<string, LabelRole> {
    let roles = book.get(accountId);
    if (roles === undefined) {
      roles = folderRoles(
        (this.selectAccountFolders.all(accountId) as unknown as FolderRow[]).map(toFolder),
      );
      book.set(accountId, roles);
    }
    return roles;
  }

  /** Whether the account's folders are labels (Gmail) rather than places; cached for one write. */
  private labelled(accountId: string, labelAccounts: Map<string, boolean>): boolean {
    let labelled = labelAccounts.get(accountId);
    if (labelled === undefined) {
      labelled = (this.selectAccountFolders.all(accountId) as unknown as FolderRow[]).some(
        (f) => f.exclusive === 0,
      );
      labelAccounts.set(accountId, labelled);
    }
    return labelled;
  }

  /**
   * The mailboxes a message has from its labels, folders and copies (ADR 0044, rule 2). Copies are
   * read only for an account whose folders are labels; with folders the labels say it all.
   */
  private mailboxesOf(
    key: number,
    accountId: string,
    labels: readonly string[],
    book: Map<string, ReadonlyMap<string, LabelRole> | undefined>,
    labelAccounts: Map<string, boolean>,
  ): number {
    const roles = this.folderBook(book, accountId);
    const copies: PlaceOfCopy[] = this.labelled(accountId, labelAccounts)
      ? (this.selectLabelCopies.all(key) as { role: LabelRole }[]).map((c) => ({
          role: c.role,
          exclusive: false,
        }))
      : [];
    return computeMailboxes(labels, roles, copies);
  }

  /**
   * Sets the mailboxes of these messages again after something that decides them was written, and
   * announces the ones that changed. With `copiesOnly` the write was of locations, which decide
   * nothing where folders are the places, so those accounts are skipped. Call inside a transaction.
   */
  private refreshMailboxes(keys: Iterable<number>, copiesOnly: boolean): number[] {
    const book = new Map<string, ReadonlyMap<string, LabelRole> | undefined>();
    const labelAccounts = new Map<string, boolean>();
    const changed: number[] = [];
    for (const key of keys) {
      const row = this.selectKeyAccount.get(key) as
        | { account_id: string; mailboxes: number }
        | undefined;
      if (!row) continue;
      if (copiesOnly && !this.labelled(row.account_id, labelAccounts)) continue;
      const labels = (this.selectMessageLabels.all(key) as { label_id: string }[]).map(
        (r) => r.label_id,
      );
      const bits = this.mailboxesOf(key, row.account_id, labels, book, labelAccounts);
      if (bits === row.mailboxes) continue;
      this.writeMailboxes.run(bits, key);
      changed.push(key);
    }
    this.announce(changed);
    return changed;
  }

  /** One new change sequence for these messages; nothing when there are none. */
  private announce(keys: readonly number[]): number {
    const seq = this.changeSeq();
    if (keys.length === 0) return seq;
    for (const key of keys) this.touchMessage.run(seq + 1, key);
    this.writeSeq.run(seq + 1);
    return seq + 1;
  }

  private changeSeq(): number {
    return (this.readSeq.get() as { value: number }).value;
  }

  async upsertMessages(batch: readonly Message[]): Promise<UpsertResult> {
    if (batch.length === 0) return { changeSeq: this.changeSeq(), keys: [] };
    return write(this.db, () => {
      const seq = this.changeSeq() + 1;
      const keys: number[] = [];
      const book = new Map<string, ReadonlyMap<string, LabelRole> | undefined>();
      const labelAccounts = new Map<string, boolean>();
      for (const m of batch) {
        const from = JSON.stringify(participant(m.from));
        const to = JSON.stringify(m.to.map(participant));
        const cc = JSON.stringify(m.cc.map(participant));
        const flags = flagBits(m.flags);
        const attachments = m.hasAttachments ? 1 : 0;
        // Unknown stays NULL; and an upsert that does not know never erases what was learned.
        const replyTo = m.replyTo === undefined ? null : JSON.stringify(m.replyTo.map(participant));
        const automated = m.automated === undefined ? null : m.automated ? 1 : 0;

        const existing = this.selectIdentity.get(m.accountId, m.providerId) as
          | { key: number }
          | undefined;
        let key: number;
        // A copy this message already has in a labelled folder counts (a re-read of Gmail mail).
        const mailboxes = this.mailboxesOf(
          existing?.key ?? -1,
          m.accountId,
          m.labelIds,
          book,
          labelAccounts,
        );
        // ADR 0091: a message on a local thread joins the threads it touches; ADR 0104: a reply
        // that points to nothing joins, by its subject, the thread where the person wrote to it.
        const current = existing
          ? (this.selectThreadOf.get(existing.key) as { thread_id: string } | undefined)?.thread_id
          : undefined;
        const threadId = this.joiner.join(m, current, seq, mailboxes);
        if (existing) {
          key = existing.key;
          this.updateMessage.run(
            threadId,
            m.messageIdHeader,
            m.dateMs,
            from,
            to,
            cc,
            m.subject,
            m.snippet,
            flags,
            attachments,
            seq,
            m.senderAuth,
            replyTo,
            automated,
            attachments,
            mailboxes,
            key,
          );
          this.deleteLabels.run(key);
        } else {
          key = m.key;
          const owner = this.selectOwner.get(key) as
            | { account_id: string; provider_id: string }
            | undefined;
          if (owner) {
            throw new Error(
              `Message key collision: key ${key} already belongs to ${owner.account_id}:${owner.provider_id}, cannot assign it to ${m.accountId}:${m.providerId}`,
            );
          }
          this.insertMessage.run(
            key,
            m.accountId,
            m.providerId,
            threadId,
            m.messageIdHeader,
            m.dateMs,
            from,
            to,
            cc,
            m.subject,
            m.snippet,
            flags,
            attachments,
            seq,
            m.senderAuth,
            replyTo,
            // A message with no files has nothing to learn; one with some waits for its structure.
            attachments === 0 ? 1 : 0,
            mailboxes,
            automated,
          );
        }
        m.labelIds.forEach((label, pos) => {
          this.insertLabel.run(label, key, pos, foldText(label));
        });
        this.joiner.writeRefs(key, m);
        keys.push(key);
      }
      this.writeSeq.run(seq);
      return { changeSeq: seq, keys };
    });
  }

  async removeByProviderIds(
    accountId: string,
    providerIds: readonly string[],
  ): Promise<readonly number[]> {
    if (providerIds.length === 0) return [];
    return write(this.db, () => {
      const rows = this.selectIdentities.all(accountId, JSON.stringify(providerIds)) as {
        provider_id: string;
        key: number;
      }[];
      if (rows.length === 0) return [];
      const keyOf = new Map(rows.map((r) => [r.provider_id, r.key]));
      const keys = [...new Set(providerIds)].flatMap((id) => {
        const key = keyOf.get(id);
        return key === undefined ? [] : [key];
      });
      const seq = this.changeSeq() + 1;
      this.deleteByKeys.run(JSON.stringify(keys));
      for (const key of keys) this.insertTombstone.run(key, seq);
      this.writeSeq.run(seq);
      return keys;
    });
  }

  async removeAccountMessages(accountId: string): Promise<readonly number[]> {
    return write(this.db, () => {
      this.deleteAccountFolders.run(accountId);
      const rows = this.selectAccountKeys.all(accountId) as { key: number }[];
      if (rows.length === 0) return [];
      const keys = rows.map((r) => r.key);
      const seq = this.changeSeq() + 1;
      this.deleteAccountMessages.run(accountId);
      for (const key of keys) this.insertTombstone.run(key, seq);
      this.writeSeq.run(seq);
      return keys;
    });
  }

  /** A loose index scan: one seek per distinct label on `message_labels_fold`, not a full pass. */
  async listLabels(): Promise<readonly string[]> {
    const out: string[] = [];
    let row = this.firstLabel.get() as { l: string | null } | undefined;
    while (row?.l != null && out.length < MAX_LABELS) {
      out.push(row.l);
      row = this.nextLabel.get(row.l) as { l: string | null } | undefined;
    }
    return out;
  }

  async getByKeys(keys: readonly number[]): Promise<readonly Message[]> {
    if (keys.length === 0) return [];
    const rows = this.selectByKeys.all(JSON.stringify(keys)) as unknown as MessageRow[];
    const byKey = new Map<number, Message>();
    for (const row of rows) byKey.set(row.key, toMessage(row));
    const out: Message[] = [];
    for (const k of keys) {
      const m = byKey.get(k);
      if (m) out.push(m);
    }
    return out;
  }

  async getThread(threadId: string, options: GetThreadOptions = {}): Promise<ThreadView | null> {
    const select = options.visibleOnly === true ? this.selectVisibleThread : this.selectThread;
    const rows = select.all(threadId) as unknown as ThreadRow[];
    const messages = rows.map(toMessage);
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (!first || !last) return null;
    const thread: Thread = {
      id: threadId,
      accountId: first.accountId,
      subject: first.subject,
      messageKeys: messages.map((m) => m.key),
      lastMessageKey: last.key,
      labelIds: [...new Set(messages.flatMap((m) => m.labelIds))],
      unreadCount: messages.filter((m) => !m.flags.seen).length,
    };
    const attachments = new Map<number, MessageAttachments>(
      rows.map((r) => [
        r.key,
        {
          known: r.attachments_known !== 0,
          items: attachmentsOf(r.attachments_json),
          hasInline: r.inline_count > 0,
        },
      ]),
    );
    return { thread, messages, attachments };
  }

  async listNewest(options: ListNewestOptions): Promise<readonly Message[]> {
    const limit = Math.max(0, Math.trunc(options.limit));
    if (limit === 0) return [];
    const { labelId, beforeKey } = options;
    let rows: unknown[];
    if (labelId === undefined) {
      this.selectNewest ??= this.db.prepare(NEWEST_VISIBLE_SQL);
      rows = this.selectNewest.all(beforeKey ?? Number.MAX_SAFE_INTEGER, limit);
    } else {
      rows =
        beforeKey === undefined
          ? this.selectNewestLabel.all(labelId, limit)
          : this.selectNewestLabelBefore.all(labelId, beforeKey, limit);
    }
    return (rows as MessageRow[]).map(toMessage);
  }

  async listWrittenTo(): Promise<ReadonlyMap<string, WrittenTo>> {
    this.writtenTo ??= this.db.prepare(WRITTEN_TO_SQL);
    const rows = this.writtenTo.all() as unknown as {
      address: string | null;
      sent: number;
      last_ms: number;
      name: string | null;
    }[];
    return new Map(
      rows.flatMap((r) =>
        r.address === null
          ? []
          : ([
              [
                r.address,
                {
                  sent: r.sent,
                  lastMs: r.last_ms,
                  ...(r.name === null || r.name.trim() === "" ? {} : { name: r.name }),
                },
              ],
            ] as readonly [string, WrittenTo][]),
      ),
    );
  }

  async listSentMail(): Promise<readonly SentMail[]> {
    this.sentMail ??= this.db.prepare(SENT_MAIL_SQL);
    const rows = this.sentMail.all() as unknown as {
      subject: string;
      to_json: string;
      cc_json: string;
    }[];
    return rows.map((r) => ({
      subject: r.subject,
      recipients: [
        ...(JSON.parse(r.to_json) as Participant[]),
        ...(JSON.parse(r.cc_json) as Participant[]),
      ].map((p) => p.address.toLowerCase()),
    }));
  }

  async listReceivedMail(sinceMs: number): Promise<readonly ReceivedMail[]> {
    this.receivedMail ??= this.db.prepare(RECEIVED_MAIL_SQL);
    const floor = messageKey(Math.max(0, Math.trunc(sinceMs)), 0);
    const rows = this.receivedMail.all(floor) as unknown as {
      key: number;
      thread_id: string;
      sender: string | null;
    }[];
    return rows.map((r) => ({ key: r.key, threadId: r.thread_id, from: r.sender ?? "" }));
  }

  async listSenderCounts(
    sinceMs: number,
    options: {
      readonly accountIds: readonly string[];
      readonly by: "sender" | "domain";
      readonly limit: number;
    },
  ): Promise<readonly SenderCount[]> {
    const limit = Math.max(0, Math.trunc(options.limit));
    if (limit === 0 || options.accountIds.length === 0) return [];
    if (options.by === "sender") this.senderCounts ??= this.db.prepare(senderCountsSql("sender"));
    else this.domainCounts ??= this.db.prepare(senderCountsSql("domain"));
    const statement = (
      options.by === "sender" ? this.senderCounts : this.domainCounts
    ) as ReturnType<Database["prepare"]>;
    const floor = messageKey(Math.max(0, Math.trunc(sinceMs)), 0);
    const rows = statement.all(floor, JSON.stringify(options.accountIds), limit) as unknown as {
      k: string;
      name: string | null;
      n: number;
      unread: number;
    }[];
    return rows.map((r) => ({
      key: r.k,
      ...(r.name === null || r.name.trim() === "" ? {} : { name: r.name.trim() }),
      messages: r.n,
      unread: r.unread,
    }));
  }

  async listThreadsSince(sinceMs: number, limit: number): Promise<readonly CandidateThread[]> {
    const max = Math.max(0, Math.trunc(limit));
    if (max === 0) return [];
    this.walkThreads ??= this.db.prepare(THREAD_WALK_SQL);
    this.threadMembers ??= this.db.prepare(THREAD_MEMBERS_SQL);
    const members = this.threadMembers;
    // One snapshot on a reader connection, so the walk and the members agree.
    return readTransaction(this.db, () => {
      const order: string[] = [];
      const seen = new Set<string>();
      const floor = messageKey(Math.max(0, Math.trunc(sinceMs)), 0);
      for (const row of this.walkThreads?.iterate(floor) ?? []) {
        const id = (row as { thread_id: string }).thread_id;
        if (seen.has(id)) continue;
        seen.add(id);
        order.push(id);
        if (order.length >= max) break;
      }
      if (order.length === 0) return [];
      const byThread = new Map<string, MemberRow[]>();
      for (const row of members.all(JSON.stringify(order)) as unknown as MemberRow[]) {
        const list = byThread.get(row.thread_id);
        if (list) list.push(row);
        else byThread.set(row.thread_id, [row]);
      }
      const out: CandidateThread[] = [];
      for (const id of order) {
        const rows = byThread.get(id);
        const last = rows?.[rows.length - 1];
        if (rows === undefined || last === undefined) continue;
        out.push({
          threadId: id,
          accountId: last.account_id,
          lastMessageKey: last.key,
          lastDateMs: last.date_ms,
          lastFromOwn: (last.mailboxes & MAILBOX_BIT.sent) !== 0,
          subject: last.subject,
          messages: rows.map((r) => ({
            from: r.sender ?? "",
            ...(r.automated === null ? {} : { automated: r.automated !== 0 }),
          })),
        });
      }
      return out;
    });
  }

  async changesSince(seq: number): Promise<Changes> {
    // One snapshot: on the reader connection a commit between the statements must not show.
    return readTransaction(this.db, () => {
      const changeSeq = this.changeSeq();
      const changed = this.selectChanges.all(seq) as { key: number }[];
      const removed = this.selectRemovedChanges.all(seq) as { key: number }[];
      return {
        changeSeq,
        changedKeys: changed.map((r) => r.key),
        removedKeys: removed.map((r) => r.key),
      };
    });
  }

  async findByProviderIds(
    accountId: string,
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const found = new Map<string, number>();
    if (providerIds.length === 0) return found;
    const rows = this.selectIdentities.all(accountId, JSON.stringify(providerIds)) as {
      provider_id: string;
      key: number;
    }[];
    for (const r of rows) found.set(r.provider_id, r.key);
    return found;
  }

  async allocateKeys(dateMs: readonly number[]): Promise<readonly number[]> {
    const taken = new Map<number, Set<number>>();
    return dateMs.map((ms) => {
      let used = taken.get(ms);
      if (!used) {
        const base = ms * MESSAGE_KEY_SEQ_LIMIT;
        const rows = this.selectKeysInRange.all(base, base + MESSAGE_KEY_SEQ_LIMIT) as {
          key: number;
        }[];
        used = new Set(rows.map((r) => r.key - base));
        taken.set(ms, used);
      }
      for (let seq = 0; seq < MESSAGE_KEY_SEQ_LIMIT; seq++) {
        if (used.has(seq)) continue;
        used.add(seq);
        return messageKey(ms, seq);
      }
      throw new RangeError(`no free message key left for dateMs ${ms}`);
    });
  }

  async addLocations(entries: readonly LocationEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await write(this.db, () => {
      for (const { key, location: l } of entries) {
        if (!this.keyExists.get(key)) {
          throw new Error(`Cannot add a location for unknown message key ${key}`);
        }
        this.upsertLocation.run(l.accountId, l.folderId, l.uidValidity, l.uid, key);
      }
      this.refreshMailboxes(new Set(entries.map((e) => e.key)), true);
    });
  }

  async removeLocations(locations: readonly MessageLocation[]): Promise<LocationRemoval> {
    if (locations.length === 0) return { deletedKeys: [], survivingKeys: [] };
    return write(this.db, () => {
      const affected = new Set<number>();
      for (const l of locations) {
        const row = this.selectLocationKey.get(l.accountId, l.folderId, l.uidValidity, l.uid) as
          | { message_key: number }
          | undefined;
        if (!row) continue;
        affected.add(row.message_key);
        this.deleteLocation.run(l.accountId, l.folderId, l.uidValidity, l.uid);
      }
      return this.deleteOrphans([...affected]);
    });
  }

  async removeFolderLocations(
    accountId: string,
    folderId: string,
    keepUidValidity?: string,
  ): Promise<LocationRemoval> {
    return write(this.db, () => {
      const rows = (
        keepUidValidity === undefined
          ? this.selectFolderKeys.all(accountId, folderId)
          : this.selectFolderKeysExcept.all(accountId, folderId, keepUidValidity)
      ) as { message_key: number }[];
      if (keepUidValidity === undefined) this.deleteFolderLocations.run(accountId, folderId);
      else this.deleteFolderLocationsExcept.run(accountId, folderId, keepUidValidity);
      return this.deleteOrphans(rows.map((r) => r.message_key));
    });
  }

  /** Deletes the messages among `keys` that have no location left. Call inside a transaction. */
  private deleteOrphans(keys: readonly number[]): LocationRemoval {
    const deletedKeys: number[] = [];
    const survivingKeys: number[] = [];
    for (const key of keys) {
      if (this.hasLocation.get(key)) survivingKeys.push(key);
      else if (this.keyExists.get(key)) deletedKeys.push(key);
    }
    if (deletedKeys.length > 0) {
      const seq = this.changeSeq() + 1;
      this.deleteByKeys.run(JSON.stringify(deletedKeys));
      for (const key of deletedKeys) this.insertTombstone.run(key, seq);
      this.writeSeq.run(seq);
    }
    // A copy that went may have been the one that made the message "in Trash" (Gmail).
    this.refreshMailboxes(survivingKeys, true);
    return { deletedKeys, survivingKeys };
  }

  async listLocationUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
  ): Promise<readonly number[]> {
    const rows = this.selectLocationUids.all(accountId, folderId, uidValidity) as { uid: number }[];
    return rows.map((r) => r.uid);
  }

  async getLocations(key: number): Promise<readonly MessageLocation[]> {
    const rows = this.selectKeyLocations.all(key) as {
      account_id: string;
      folder_id: string;
      uid_validity: string;
      uid: number;
    }[];
    return rows.map((r) => ({
      accountId: r.account_id,
      folderId: r.folder_id,
      uidValidity: r.uid_validity,
      uid: r.uid,
    }));
  }

  async updateFlags(updates: readonly FlagUpdate[]): Promise<readonly number[]> {
    if (updates.length === 0) return [];
    return write(this.db, () => {
      const seq = this.changeSeq() + 1;
      const changed = new Set<number>();
      for (const u of updates) {
        const l = u.location;
        const row = this.selectLocationKey.get(l.accountId, l.folderId, l.uidValidity, l.uid) as
          | { message_key: number }
          | undefined;
        if (!row) continue;
        const key = row.message_key;
        const bits = flagBits(u.flags);
        const current = this.selectFlags.get(key) as { flags: number };
        let touched = false;
        if (current.flags !== bits) {
          this.updateFlagBits.run(bits, seq, key);
          touched = true;
        }
        if (u.labelIds !== undefined && this.replaceLabels(key, u.labelIds)) {
          if (!touched) this.touchMessage.run(seq, key);
          touched = true;
        }
        if (touched) changed.add(key);
      }
      if (changed.size > 0) this.writeSeq.run(seq);
      this.refreshMailboxes(changed, false);
      return [...changed];
    });
  }

  async listUnknownReplyToUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    this.selectUnknownReplyTo ??= this.db.prepare(UNKNOWN_REPLY_TO_SQL);
    const rows = this.selectUnknownReplyTo.all(accountId, folderId, uidValidity, n) as {
      uid: number;
    }[];
    return rows.map((r) => r.uid).sort((a, b) => a - b);
  }

  async setReplyTo(answers: readonly ReplyToAnswer[]): Promise<readonly number[]> {
    if (answers.length === 0) return [];
    return write(this.db, () => {
      const seq = this.changeSeq() + 1;
      const set: number[] = [];
      const announced: number[] = [];
      for (const { location: l, replyTo } of answers) {
        const row = this.selectLocationKey.get(l.accountId, l.folderId, l.uidValidity, l.uid) as
          | { message_key: number }
          | undefined;
        if (!row) continue;
        const key = row.message_key;
        const written = this.writeReplyTo.run(JSON.stringify(replyTo.map(participant)), key);
        if (written.changes === 0) continue;
        set.push(key);
        // An empty list shows nothing new to anyone who holds the message, so it stays quiet.
        if (replyTo.length > 0) {
          this.touchMessage.run(seq, key);
          announced.push(key);
        }
      }
      if (announced.length > 0) this.writeSeq.run(seq);
      return set;
    });
  }

  async listUnknownAutomatedUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    this.selectUnknownAutomated ??= this.db.prepare(UNKNOWN_AUTOMATED_SQL);
    const rows = this.selectUnknownAutomated.all(accountId, folderId, uidValidity, n) as {
      uid: number;
    }[];
    return rows.map((r) => r.uid).sort((a, b) => a - b);
  }

  async setAutomated(answers: readonly AutomatedAnswer[]): Promise<readonly number[]> {
    if (answers.length === 0) return [];
    // No change is announced: the flag shows nothing different to anyone who holds the message.
    return write(this.db, () => {
      const set: number[] = [];
      for (const { location: l, automated } of answers) {
        const row = this.selectLocationKey.get(l.accountId, l.folderId, l.uidValidity, l.uid) as
          | { message_key: number }
          | undefined;
        if (!row) continue;
        const written = this.writeAutomated.run(automated ? 1 : 0, row.message_key);
        if (written.changes > 0) set.push(row.message_key);
      }
      return set;
    });
  }

  async listUnknownAttachmentUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    this.selectUnknownAttachments ??= this.db.prepare(UNKNOWN_ATTACHMENTS_SQL);
    const rows = this.selectUnknownAttachments.all(accountId, folderId, uidValidity, n) as {
      uid: number;
    }[];
    return rows.map((r) => r.uid).sort((a, b) => a - b);
  }

  async setAttachments(answers: readonly AttachmentAnswer[]): Promise<readonly number[]> {
    if (answers.length === 0) return [];
    return write(this.db, () => {
      const seq = this.changeSeq() + 1;
      const set: number[] = [];
      const announced: number[] = [];
      for (const { location: l, attachments } of answers) {
        const row = this.selectLocationKey.get(l.accountId, l.folderId, l.uidValidity, l.uid) as
          | { message_key: number }
          | undefined;
        if (!row) continue;
        const key = row.message_key;
        const before = this.selectAttachmentFlag.get(key) as { has_attachments: number };
        this.deleteAttachments.run(key);
        attachments.forEach((a, position) => {
          this.insertAttachment.run(
            key,
            a.partId,
            position,
            a.name,
            a.mimeType,
            a.size,
            a.contentId ?? null,
            a.inline ? 1 : 0,
          );
        });
        // The names the person can search for (ADR 0074): the files that are listed.
        this.fileIndex.set(
          key,
          attachments.filter((a) => !a.inline).map((a) => a.name),
        );
        // The paperclip in the list and `has:attachment` read this flag: the structure is the truth.
        const listed = attachments.some((a) => !a.inline) ? 1 : 0;
        this.writeAttachmentFacts.run(listed, key);
        set.push(key);
        // Nothing new for anyone who holds the message when it had no files and has none.
        if (listed === 1 || before.has_attachments !== listed) {
          this.touchMessage.run(seq, key);
          announced.push(key);
        }
      }
      if (announced.length > 0) this.writeSeq.run(seq);
      return set;
    });
  }

  async getAttachment(key: number, partId: string): Promise<ReceivedAttachment | null> {
    const row = this.selectAttachment.get(key, partId) as
      | {
          part_id: string;
          name: string;
          mime_type: string;
          size: number;
          content_id: string | null;
          inline: number;
        }
      | undefined;
    if (!row) return null;
    return {
      partId: row.part_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      inline: row.inline !== 0,
      ...(row.content_id === null ? {} : { contentId: row.content_id }),
    };
  }

  async setSeen(keys: readonly number[], seen: boolean): Promise<SetSeenResult> {
    if (keys.length === 0) return { changeSeq: this.changeSeq(), changedKeys: [] };
    return write(this.db, () => {
      const seq = this.changeSeq() + 1;
      const changed: number[] = [];
      for (const key of new Set(keys)) {
        const row = this.selectFlags.get(key) as { flags: number } | undefined;
        if (!row) continue;
        const bits = seen ? row.flags | SEEN : row.flags & ~SEEN;
        if (bits === row.flags) continue;
        this.updateFlagBits.run(bits, seq, key);
        changed.push(key);
      }
      if (changed.length === 0) return { changeSeq: seq - 1, changedKeys: [] };
      this.writeSeq.run(seq);
      return { changeSeq: seq, changedKeys: changed };
    });
  }

  async setPlacement(
    entries: readonly (Placement & { readonly key: number })[],
  ): Promise<SetPlacementResult> {
    if (entries.length === 0) return { changeSeq: this.changeSeq(), changedKeys: [] };
    return write(this.db, () => {
      const changed: number[] = [];
      for (const { key, labelIds, mailboxes } of entries) {
        const row = this.selectMailboxes.get(key) as { mailboxes: number } | undefined;
        if (!row) continue;
        const labels = this.replaceLabels(key, labelIds);
        if (!labels && row.mailboxes === mailboxes) continue;
        this.writeMailboxes.run(mailboxes, key);
        changed.push(key);
      }
      if (changed.length === 0) return { changeSeq: this.changeSeq(), changedKeys: [] };
      return { changeSeq: this.announce(changed), changedKeys: changed };
    });
  }

  async setFolders(accountId: string, folders: readonly Label[]): Promise<readonly number[]> {
    return write(this.db, () => {
      const current = (this.selectAccountFolders.all(accountId) as unknown as FolderRow[]).map(
        toFolder,
      );
      const same =
        current.length === folders.length &&
        [...folders]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .every((f, i) => {
            const c = current[i];
            return (
              c !== undefined &&
              c.id === f.id &&
              c.name === f.name &&
              c.role === f.role &&
              c.exclusive === f.exclusive
            );
          });
      // Listed at every sync: nothing is written, nothing recomputed, when nothing changed.
      if (same) return [];
      this.deleteAccountFolders.run(accountId);
      for (const f of folders) {
        this.insertFolder.run(accountId, f.id, f.name, f.role, f.exclusive ? 1 : 0);
      }
      const seq = this.changeSeq() + 1;
      this.recomputeMailboxes ??= this.db.prepare(RECOMPUTE_MAILBOXES_SQL);
      const changed = (
        this.recomputeMailboxes.all({ account: accountId, seq }) as { key: number }[]
      ).map((r) => r.key);
      if (changed.length > 0) this.writeSeq.run(seq);
      return changed;
    });
  }

  async listFolders(accountId?: string): Promise<readonly Label[]> {
    const rows = (accountId === undefined
      ? this.selectFolders.all()
      : this.selectAccountFolders.all(accountId)) as unknown as FolderRow[];
    return rows.map(toFolder);
  }

  async deriveLabelsFromLocations(keys: readonly number[]): Promise<void> {
    if (keys.length === 0) return;
    await write(this.db, () => {
      const seq = this.changeSeq() + 1;
      let any = false;
      for (const key of new Set(keys)) {
        const folders = (this.selectKeyFolders.all(key) as { folder_id: string }[]).map(
          (r) => r.folder_id,
        );
        if (folders.length === 0 || !this.keyExists.get(key)) continue;
        if (this.replaceLabels(key, folders)) {
          this.touchMessage.run(seq, key);
          any = true;
        }
      }
      if (any) this.writeSeq.run(seq);
      this.refreshMailboxes(new Set(keys), false);
    });
  }

  /** Replaces the labels of a message; false (and no writes) when they are the same. */
  private replaceLabels(key: number, labels: readonly string[]): boolean {
    const wanted = [...new Set(labels)];
    const current = (this.selectLabelIds.all(key) as { label_id: string }[]).map((r) => r.label_id);
    if (current.length === wanted.length && current.every((l, i) => l === wanted[i])) return false;
    this.deleteLabels.run(key);
    wanted.forEach((label, pos) => {
      this.insertLabel.run(label, key, pos, foldText(label));
    });
    return true;
  }
}
