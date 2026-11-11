import type { FileTextPort, KeptFileText } from "@matters/core";
import { type Database, write } from "./database.ts";

interface Row {
  text: string;
  pages: number | null;
  state: string;
  extracted_ms: number;
}

/**
 * The text the agent read from attached files (ADR 0087, rule 6), in `attachment_text`. A row goes
 * with its message by the foreign key. Reads work on any connection; writes belong to the writer.
 */
export class SqliteFileText implements FileTextPort {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async get(messageKey: number, partId: string): Promise<KeptFileText | null> {
    const row = this.db
      .prepare(
        "SELECT text, pages, state, extracted_ms FROM attachment_text WHERE message_key = ? AND part_id = ?",
      )
      .get(messageKey, partId) as Row | undefined;
    // A state this build does not know is read again, not trusted.
    if (row === undefined || (row.state !== "ok" && row.state !== "no_text")) return null;
    return { text: row.text, pages: row.pages, state: row.state, extractedMs: row.extracted_ms };
  }

  put(messageKey: number, partId: string, kept: KeptFileText): Promise<void> {
    return write(this.db, () => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO attachment_text (message_key, part_id, text, pages, state, extracted_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(messageKey, partId, kept.text, kept.pages, kept.state, kept.extractedMs);
    });
  }

  clear(): Promise<number> {
    return write(this.db, () =>
      Number(this.db.prepare("DELETE FROM attachment_text").run().changes),
    );
  }

  async count(): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM attachment_text").get() as { n: number }).n;
  }
}
