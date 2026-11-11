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

// ADR 0116: the verdicts of a prompt, and the ledger's `prompt` line, come with migration 50.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function databaseAt(version: number): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-v50-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  const old = new DatabaseSync(path);
  old.exec("PRAGMA journal_mode = WAL");
  old.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
    old.exec(m.sql);
    m.run?.(old);
    old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
  }
  old
    .prepare(
      "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (5, 'r', 'a', 'talk', 3)",
    )
    .run();
  old.close();
  return path;
}

describe("migration 50 (ADR 0116)", () => {
  it("adds the verdicts empty and keeps the ledger, its ids and its counter", async () => {
    const path = databaseAt(49);
    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_prompt_verdicts").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT id, purpose, threads FROM agent_ledger").all()).toEqual([
        { id: 1, purpose: "talk", threads: 3 },
      ]);
      db.prepare(
        "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (6, 'r', 'a', 'prompt', 10)",
      ).run();
      expect(db.prepare("SELECT id FROM agent_ledger WHERE purpose = 'prompt'").get()).toEqual({
        id: 2,
      });
      expect(() =>
        db
          .prepare(
            "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (7, 'r', 'a', 'other', 0)",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("runs again over a database rolled back to 49", () => {
    const path = databaseAt(50);
    const old = new DatabaseSync(path);
    old.prepare("DELETE FROM schema_version WHERE version >= 50").run();
    old.close();
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("removes a thread's verdicts with its mail", async () => {
    const storage = createSqliteStorage(":memory:");
    try {
      await storage.agent.putPromptVerdicts([
        {
          promptKey: "k",
          threadId: "t1",
          lastMessageKey: 1,
          version: 1,
          fit: 1,
          why: "It fits a little.",
          quote: { text: "a passage", messageKey: 1 },
          atMs: 1,
        },
      ]);
      await storage.agent.removeForThreads(["t1"]);
      expect(
        await storage.agent.getPromptVerdicts("k", 1, [{ threadId: "t1", lastMessageKey: 1 }]),
      ).toEqual([]);
    } finally {
      storage.close();
    }
  });
});

// ADR 0116, rule 4: the kept searches of a prompt come with migration 51, apart from 50, so a
// database that already ran 50 gets them too.
describe("migration 51 (ADR 0116, rule 4)", () => {
  it("adds the searches empty over a database at 50 and keeps its verdicts", async () => {
    const path = databaseAt(50);
    const old = new DatabaseSync(path);
    old
      .prepare(
        "INSERT INTO agent_prompt_verdicts (prompt_key, thread_id, last_message_key, version, fit, why, at_ms) VALUES ('k', 't1', 1, 1, 0, 'No.', 1)",
      )
      .run();
    old.close();
    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_prompt_searches").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_prompt_verdicts").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("runs again over a database rolled back to 50", () => {
    const path = databaseAt(51);
    const old = new DatabaseSync(path);
    old.prepare("DELETE FROM schema_version WHERE version >= 51").run();
    old.close();
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});
