import type {
  Approval,
  OutboxPort,
  SendLane,
  SendOperation,
  SendState,
  SendStateKind,
} from "@matters/core";
import { LARGE_LANE_BYTES } from "@matters/core";
import { type Database, exclusive } from "./database.ts";

interface Row {
  id: string;
  account_id: string;
  draft_id: string;
  summary: string;
  state: string;
  state_text: string | null;
  approval_json: string;
  attempts: number;
  not_before_ms: number;
  message_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  unknown_since_ms: number | null;
  warning: string | null;
  state_action: string | null;
  encoded_bytes: number;
  data_ended: number;
  auto_retries: number;
  mime_bytes: number | null;
}

const COLUMNS = `id, account_id, draft_id, summary, state, state_text, state_action, approval_json,
  attempts, not_before_ms, message_id, created_at_ms, updated_at_ms, unknown_since_ms, warning,
  encoded_bytes, data_ended, auto_retries, mime_bytes`;

/**
 * Not claimable while a file of the draft is still being read (ADR 0041, rule 7). The index on
 * (draft_id, state) answers it without a scan.
 */
const WAITING_FOR_FILE = `EXISTS (SELECT 1 FROM attachments a
                                  WHERE a.draft_id = s.draft_id AND a.state = 'reading')`;

/** The lane is a comparison against the one threshold core owns, passed in as text. */
const laneTest = (lane: SendLane) =>
  lane === "large"
    ? `s.encoded_bytes >= ${LARGE_LANE_BYTES}`
    : `s.encoded_bytes < ${LARGE_LANE_BYTES}`;

/** A large send of an account runs one at a time (rule 11); the index is (account_id, state). */
const LARGE_RUNNING_FOR_ACCOUNT = `EXISTS (SELECT 1 FROM send_operations r
                                            WHERE r.account_id = s.account_id AND r.state = 'running'
                                              AND r.encoded_bytes >= ${LARGE_LANE_BYTES})`;

function stateOf(row: Row): SendState {
  switch (row.state) {
    case "succeeded":
      return { kind: "succeeded", providerMessageId: row.state_text ?? "" };
    case "failed":
      return {
        kind: "failed",
        reason: row.state_text ?? "",
        ...(row.state_action === "openDraft" ? { action: "openDraft" as const } : {}),
      };
    case "voided":
      return { kind: "voided", reason: row.state_text ?? "" };
    default:
      return { kind: row.state as "pending" | "held" | "running" | "unknown" | "cancelled" };
  }
}

function textOf(state: SendState): string | null {
  switch (state.kind) {
    case "succeeded":
      return state.providerMessageId;
    case "failed":
    case "voided":
      return state.reason;
    default:
      return null;
  }
}

function toOperation(row: Row): SendOperation {
  return {
    id: row.id,
    accountId: row.account_id,
    draftId: row.draft_id,
    summary: row.summary,
    approval: JSON.parse(row.approval_json) as Approval,
    state: stateOf(row),
    attempts: row.attempts,
    notBeforeMs: row.not_before_ms,
    messageId: row.message_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    unknownSinceMs: row.unknown_since_ms,
    warning: row.warning,
    encodedBytes: row.encoded_bytes,
    dataEnded: row.data_ended === 1,
    autoRetries: row.auto_retries,
    mimeBytes: row.mime_bytes,
  };
}

const actionOf = (state: SendState): string | null =>
  state.kind === "failed" ? (state.action ?? null) : null;

const ACTIVE = "('pending','held','running','failed','unknown')";

export class SqliteOutbox implements OutboxPort {
  private readonly db: Database;
  private readonly insert;
  private readonly selectOne;
  private readonly replace;
  private readonly claimSmall;
  private readonly claimLarge;
  private readonly nextDueSmall;
  private readonly nextDueLarge;
  private readonly visible;
  private readonly forDraft;
  private readonly storeMime;
  private readonly loadMime;
  private readonly storeSpool;
  private readonly loadSpool;
  private readonly prune;
  private readonly discard;

  constructor(db: Database) {
    this.db = db;
    this.insert = db.prepare(`
      INSERT INTO send_operations (id, account_id, draft_id, summary, state, state_text,
        approval_json, attempts, not_before_ms, message_id, created_at_ms, updated_at_ms,
        unknown_since_ms, warning, state_action, encoded_bytes, data_ended, auto_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.selectOne = db.prepare(`SELECT ${COLUMNS} FROM send_operations WHERE id = ?`);
    this.replace = db.prepare(`
      UPDATE send_operations SET state = ?, state_text = ?, state_action = ?, attempts = ?,
        not_before_ms = ?, message_id = ?, updated_at_ms = ?, unknown_since_ms = ?, warning = ?,
        data_ended = ?, auto_retries = ? WHERE id = ?`);
    // One statement, so selecting and starting cannot interleave (same as startSend).
    const claim = (lane: SendLane) =>
      db.prepare(`
      UPDATE send_operations SET state = 'running', state_text = NULL, state_action = NULL,
        attempts = attempts + 1, data_ended = 0, updated_at_ms = ?
       WHERE id = (SELECT s.id FROM send_operations s
                    WHERE s.state = 'pending' AND s.not_before_ms <= ? AND ${laneTest(lane)}
                      AND NOT ${WAITING_FOR_FILE}
                      ${lane === "large" ? `AND NOT ${LARGE_RUNNING_FOR_ACCOUNT}` : ""}
                    ORDER BY s.not_before_ms, s.created_at_ms, s.id LIMIT 1)
      RETURNING ${COLUMNS}`);
    this.claimSmall = claim("small");
    this.claimLarge = claim("large");
    const nextDue = (lane: SendLane) =>
      db.prepare(`
      SELECT MIN(s.not_before_ms) AS due FROM send_operations s
       WHERE s.state = 'pending' AND ${laneTest(lane)} AND NOT ${WAITING_FOR_FILE}`);
    this.nextDueSmall = nextDue("small");
    this.nextDueLarge = nextDue("large");
    this.visible = db.prepare(`
      SELECT ${COLUMNS} FROM send_operations
       WHERE state IN ${ACTIVE} OR (state IN ('succeeded','voided') AND updated_at_ms >= ?)
       ORDER BY created_at_ms, id`);
    this.forDraft = db.prepare(
      `SELECT ${COLUMNS} FROM send_operations WHERE draft_id = ? AND state IN ${ACTIVE}
        ORDER BY created_at_ms, id`,
    );
    this.storeMime = db.prepare(
      "UPDATE send_operations SET message_id = ?, mime = ?, mime_bytes = ? WHERE id = ?",
    );
    this.loadMime = db.prepare("SELECT mime FROM send_operations WHERE id = ?");
    this.storeSpool = db.prepare(
      "UPDATE send_operations SET message_id = ?, spool_path = ?, mime_bytes = ? WHERE id = ?",
    );
    this.loadSpool = db.prepare(
      "SELECT spool_path, mime_bytes FROM send_operations WHERE id = ? AND spool_path IS NOT NULL",
    );
    this.prune = db.prepare(
      "DELETE FROM send_operations WHERE state IN ('succeeded','voided','cancelled') AND updated_at_ms < ?",
    );
    this.discard = db.prepare("DELETE FROM send_operations WHERE account_id = ?");
  }

  async enqueue(op: SendOperation): Promise<void> {
    await exclusive(this.db, () => {
      this.insert.run(
        op.id,
        op.accountId,
        op.draftId,
        op.summary,
        op.state.kind,
        textOf(op.state),
        JSON.stringify(op.approval),
        op.attempts,
        op.notBeforeMs,
        op.messageId,
        op.createdAtMs,
        op.updatedAtMs,
        op.unknownSinceMs,
        op.warning,
        actionOf(op.state),
        op.encodedBytes,
        op.dataEnded ? 1 : 0,
        op.autoRetries,
      );
    });
  }

  async get(id: string): Promise<SendOperation | null> {
    const row = this.selectOne.get(id) as Row | undefined;
    return row ? toOperation(row) : null;
  }

  async update(op: SendOperation): Promise<void> {
    await exclusive(this.db, () => {
      this.replace.run(
        op.state.kind,
        textOf(op.state),
        actionOf(op.state),
        op.attempts,
        op.notBeforeMs,
        op.messageId,
        op.updatedAtMs,
        op.unknownSinceMs,
        op.warning,
        op.dataEnded ? 1 : 0,
        op.autoRetries,
        op.id,
      );
    });
  }

  async claimNext(nowMs: number, lane: SendLane): Promise<SendOperation | null> {
    const statement = lane === "large" ? this.claimLarge : this.claimSmall;
    const row = (await exclusive(this.db, () => statement.get(nowMs, nowMs))) as unknown as
      | Row
      | undefined;
    return row ? toOperation(row) : null;
  }

  async nextDueMs(lane: SendLane): Promise<number | null> {
    const statement = lane === "large" ? this.nextDueLarge : this.nextDueSmall;
    return (statement.get() as { due: number | null }).due;
  }

  async listByState(kinds: readonly SendStateKind[]): Promise<readonly SendOperation[]> {
    if (kinds.length === 0) return [];
    const marks = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM send_operations WHERE state IN (${marks}) ORDER BY created_at_ms, id`,
      )
      .all(...kinds) as unknown as Row[];
    return rows.map(toOperation);
  }

  async listVisible(finishedSinceMs: number): Promise<readonly SendOperation[]> {
    return (this.visible.all(finishedSinceMs) as unknown as Row[]).map(toOperation);
  }

  async activeForDraft(draftId: string): Promise<readonly SendOperation[]> {
    return (this.forDraft.all(draftId) as unknown as Row[]).map(toOperation);
  }

  async setMime(id: string, messageId: string, mime: Uint8Array): Promise<void> {
    await exclusive(this.db, () => {
      this.storeMime.run(messageId, mime, mime.byteLength, id);
    });
  }

  async setSpool(id: string, messageId: string, path: string, bytes: number): Promise<void> {
    await exclusive(this.db, () => {
      this.storeSpool.run(messageId, path, bytes, id);
    });
  }

  async getSpool(id: string): Promise<{ path: string; bytes: number } | null> {
    const row = this.loadSpool.get(id) as
      | { spool_path: string; mime_bytes: number | null }
      | undefined;
    return row ? { path: row.spool_path, bytes: row.mime_bytes ?? 0 } : null;
  }

  async getMime(id: string): Promise<Uint8Array | null> {
    const row = this.loadMime.get(id) as { mime: Uint8Array | null } | undefined;
    return row?.mime ? new Uint8Array(row.mime) : null;
  }

  async pruneFinished(beforeMs: number): Promise<number> {
    const result = await exclusive(this.db, () => this.prune.run(beforeMs));
    return Number(result.changes);
  }

  async discardAccount(accountId: string): Promise<void> {
    await exclusive(this.db, () => {
      this.discard.run(accountId);
    });
  }
}
