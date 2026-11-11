import type { DatabaseSync } from "node:sqlite";
import type { Message } from "@matters/core";
import { SqliteMessageStore } from "../src/index.ts";

/** Columns that came with a later migration, and how to add them for a moment. */
const LATER_COLUMNS = [
  ["sender_auth", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["reply_to_json", "TEXT"],
  ["attachments_known", "INTEGER NOT NULL DEFAULT 1"],
  ["mailboxes", "INTEGER NOT NULL DEFAULT 0"],
  ["automated", "INTEGER"],
  ["copy_of", "INTEGER"],
] as const;

/** The table of the files of a message (version 20), as much of it as the store prepares. */
const ATTACHMENTS_TABLE = `CREATE TABLE message_attachments (
  message_key INTEGER NOT NULL, part_id TEXT NOT NULL, position INTEGER NOT NULL,
  name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, content_id TEXT,
  inline INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (message_key, part_id)
)`;

/** The folders of an account (version 21): the store reads them to set a message's mailboxes. */
const FOLDERS_TABLE = `CREATE TABLE folders (
  account_id TEXT NOT NULL, folder_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  exclusive INTEGER NOT NULL, PRIMARY KEY (account_id, folder_id)
)`;

/**
 * Stores messages in a database built from older migrations, with the store of today. Columns
 * that came later are added for the write and dropped again, so the data stays what that
 * schema would have held.
 */
export async function upsertOnOldSchema(
  db: DatabaseSync,
  messages: readonly Message[],
): Promise<void> {
  const have = new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name),
  );
  const added = LATER_COLUMNS.filter(([name]) => !have.has(name));
  for (const [name, type] of added) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  const tableAdded =
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_attachments'").get() ===
    undefined;
  if (tableAdded) db.exec(ATTACHMENTS_TABLE);
  const foldersAdded =
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'folders'").get() === undefined;
  if (foldersAdded) db.exec(FOLDERS_TABLE);
  await new SqliteMessageStore(db).upsertMessages(messages);
  if (tableAdded) db.exec("DROP TABLE message_attachments");
  if (foldersAdded) db.exec("DROP TABLE folders");
  for (const [name] of added) db.exec(`ALTER TABLE messages DROP COLUMN ${name}`);
}
