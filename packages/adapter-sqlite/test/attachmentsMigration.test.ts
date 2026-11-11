import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  schemaVersion,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const approval = JSON.stringify({
  draftId: "d1",
  version: 1,
  fingerprint: "f".repeat(64),
  threadContext: null,
  approvedAtMs: 1,
});

describe("upgrade from schema 17 (ADR 0040 and 0041)", () => {
  it("keeps accounts, drafts and sends; a running send stays one that may have gone out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v17-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");

    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 17)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    old
      .prepare(
        `INSERT INTO accounts (id, address, display_name, imap_host, imap_port, imap_security,
           imap_username, created_at_ms) VALUES ('acc1', 'me@example.com', 'Me', 'h', 993, 'tls', 'me', 1)`,
      )
      .run();
    const insertOp = old.prepare(
      `INSERT INTO send_operations (id, account_id, draft_id, summary, state, state_text, approval_json,
         attempts, not_before_ms, message_id, mime, created_at_ms, updated_at_ms)
       VALUES (?, 'acc1', 'd1', 's', ?, ?, ?, 1, 10, '<m@x>', ?, 1, 1)`,
    );
    insertOp.run("running", "running", null, approval, new Uint8Array([1, 2, 3, 4, 5]));
    insertOp.run("failed", "failed", "550 no", approval, null);
    insertOp.run("pending", "pending", null, approval, null);
    expect(schemaVersion(old)).toBe(17);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();

    const storage = createSqliteStorage(path);
    try {
      expect((await storage.accounts.get("acc1"))?.messageLimitBytes).toBeUndefined();
      expect(await storage.attachments.allIds()).toEqual([]);

      const running = await storage.outbox.get("running");
      // the mark did not exist: running keeps meaning "may have gone out"
      expect(running).toMatchObject({
        dataEnded: true,
        autoRetries: 0,
        encodedBytes: 0,
        mimeBytes: 5,
      });
      expect(await storage.outbox.get("failed")).toMatchObject({
        state: { kind: "failed", reason: "550 no" },
        dataEnded: false,
        mimeBytes: null,
      });
      expect(await storage.outbox.getMime("running")).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      expect(await storage.outbox.getSpool("running")).toBeNull();

      // everything from before is small mail
      expect((await storage.outbox.claimNext(100, "small"))?.id).toBe("pending");
      expect(await storage.outbox.claimNext(100, "large")).toBeNull();

      await storage.accounts.setMessageLimit("acc1", 26_214_400);
      expect((await storage.accounts.get("acc1"))?.messageLimitBytes).toBe(26_214_400);
    } finally {
      storage.close();
    }
  });

  it("refuses a state or a row that makes no sense", () => {
    const db = openDatabase(":memory:");
    const insert = (state: string) =>
      db
        .prepare(
          `INSERT INTO attachments (id, draft_id, account_id, name, size, state, created_at_ms)
           VALUES (?, 'd', 'a', 'n', 1, ?, 0)`,
        )
        .run(`id-${state}`, state);
    expect(() => insert("ready")).not.toThrow();
    expect(() => insert("half")).toThrow(/CHECK|constraint/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO attachments (id, draft_id, account_id, name, size, state, created_at_ms)
           VALUES ('id-ready', 'd', 'a', 'n', 1, 'ready', 0)`,
        )
        .run(),
    ).toThrow(/UNIQUE|constraint/i);
    db.close();
  });

  it("answers the queries of a claim and a chip through indexes", () => {
    const db = openDatabase(":memory:");
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((p) => p.detail)
        .join(" ");
    expect(plan("SELECT * FROM attachments WHERE draft_id = 'd' ORDER BY rowid")).toMatch(
      /USING (COVERING )?INDEX attachments_draft/,
    );
    expect(plan("SELECT 1 FROM attachments WHERE draft_id = 'd' AND state = 'reading'")).toMatch(
      /USING (COVERING )?INDEX attachments_draft \(draft_id=\? AND state=\?\)/,
    );
    expect(plan("SELECT * FROM attachments WHERE state IN ('reading')")).toMatch(
      /USING INDEX attachments_state/,
    );
    expect(plan("SELECT * FROM attachments WHERE account_id = 'a'")).toMatch(
      /USING INDEX attachments_account/,
    );
    expect(
      plan("SELECT 1 FROM send_operations WHERE account_id = 'a' AND state = 'running'"),
    ).toMatch(/USING (COVERING )?INDEX send_operations_account/);
    // the claim: the pending sends by time, and the wait for a file through the draft index
    const claim = plan(`
      SELECT s.id FROM send_operations s
       WHERE s.state = 'pending' AND s.not_before_ms <= 5 AND s.encoded_bytes < 1048576
         AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.draft_id = s.draft_id AND a.state = 'reading')
       ORDER BY s.not_before_ms, s.created_at_ms, s.id LIMIT 1`);
    expect(claim).toMatch(/USING INDEX send_operations_due/);
    expect(claim).toMatch(/INDEX attachments_draft/);
    db.close();
  });
});
