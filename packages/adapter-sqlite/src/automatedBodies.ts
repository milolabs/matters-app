import { isAutomatedByBody, type MessageBodyPort } from "@matters/core";
import { type Database, write } from "./database.ts";

/**
 * ADR 0111: the `counters` row that says how far stored mail has been read for a mailing's
 * footer. Messages with a smaller key are still to read; no row means all are read. Migration 49
 * puts it in at the top.
 */
export const AUTOMATED_BODY_COUNTER = "automated_body_before";

/** Messages one step reads. A step of this size decompresses a few MB at most. */
export const AUTOMATED_BODY_STEP_ROWS = 500;

/** What one step did: how many messages it marked, and whether any are left to read. */
export interface AutomatedBodyStep {
  readonly moved: number;
  readonly done: boolean;
}

/**
 * Marks stored mail as automated where its own text has a mailing's footer (ADR 0111), the rule
 * the parser applies to new mail. Newest first, one small step at a time, on the sync worker
 * after launch. Only messages not already marked are read, and only ever turned to automated: a
 * step never clears the flag that headers set. Nothing is announced, as with the headers (ADR
 * 0066, rule 6): the flag shows nothing different to anyone who holds the message.
 */
export class AutomatedFromBodies {
  private readonly db: Database;
  private readonly bodies: Pick<MessageBodyPort, "getBodies">;
  private readonly selectBefore;
  private readonly selectRows;
  private readonly mark;
  private readonly moveCursor;
  private readonly endCursor;

  constructor(db: Database, bodies: Pick<MessageBodyPort, "getBodies">) {
    this.db = db;
    this.bodies = bodies;
    this.selectBefore = db.prepare("SELECT value FROM counters WHERE name = ?");
    // The primary key, newest first; a row already marked costs only its skip.
    this.selectRows = db.prepare(
      `SELECT key, subject FROM messages
        WHERE key < ? AND automated IS NOT 1 ORDER BY key DESC LIMIT ?`,
    );
    this.mark = db.prepare(
      "UPDATE messages SET automated = 1 WHERE key = ? AND automated IS NOT 1",
    );
    this.moveCursor = db.prepare("UPDATE counters SET value = ? WHERE name = ?");
    this.endCursor = db.prepare("DELETE FROM counters WHERE name = ?");
  }

  async step(rows = AUTOMATED_BODY_STEP_ROWS): Promise<AutomatedBodyStep> {
    const state = this.selectBefore.get(AUTOMATED_BODY_COUNTER) as { value: number } | undefined;
    if (state === undefined) return { moved: 0, done: true };
    const limit = Math.max(1, Math.trunc(rows));
    const listed = this.selectRows.all(state.value, limit) as unknown as {
      key: number;
      subject: string;
    }[];
    const texts = await this.bodies.getBodies(listed.map((r) => r.key));
    const marked = listed
      .filter((r) => isAutomatedByBody(texts.get(r.key) ?? "", r.subject))
      .map((r) => r.key);
    const last = listed.at(-1);
    const done = listed.length < limit || last === undefined;
    return write(this.db, () => {
      let moved = 0;
      for (const key of marked) moved += Number(this.mark.run(key).changes);
      if (done || last === undefined) this.endCursor.run(AUTOMATED_BODY_COUNTER);
      else this.moveCursor.run(last.key, AUTOMATED_BODY_COUNTER);
      return { moved, done };
    });
  }
}
