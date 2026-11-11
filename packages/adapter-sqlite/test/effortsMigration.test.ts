import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_AGENT_EFFORTS } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  SqliteAgentInsightStore,
  SqliteAgentSettings,
  schemaVersion,
} from "../src/index.ts";

// ADR 0118: the effort of each kind of work is a setting, and the ledger says the effort of each
// turn, which comes with migration 54.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function databaseAt(version: number): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-v54-"));
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
  old.close();
  return path;
}

describe("migration 54 (ADR 0118, rule 7)", () => {
  it("keeps the ledger of a database at 53, whose lines say no effort", async () => {
    const path = databaseAt(53);
    const old = new DatabaseSync(path);
    old
      .prepare(
        "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (5, 'r', 'a', 'prompt', 3)",
      )
      .run();
    old.close();
    const db = openDatabase(path);
    try {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const store = new SqliteAgentInsightStore(db);
      expect(await store.listLedger(5)).toEqual([
        { atMs: 5, runtimeId: "r", accountId: "a", purpose: "prompt", threads: 3 },
      ]);
      await store.appendLedger([
        { atMs: 6, runtimeId: "r", accountId: "a", purpose: "prompt", threads: 1, effort: "xhigh" },
      ]);
      expect((await store.listLedger(5)).map((e) => e.effort)).toEqual(["xhigh", undefined]);
    } finally {
      db.close();
    }
  });

  it("reads a level this build does not know as none", async () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare(
        "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads, effort) VALUES (1, 'r', 'a', 'talk', 1, 'ultra')",
      ).run();
      expect(await new SqliteAgentInsightStore(db).listLedger(5)).toEqual([
        { atMs: 1, runtimeId: "r", accountId: "a", purpose: "talk", threads: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it("runs again over a database rolled back to 53", () => {
    const path = databaseAt(54);
    const old = new DatabaseSync(path);
    old.prepare("DELETE FROM schema_version WHERE version >= 54").run();
    old.close();
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});

describe("efforts in stored settings (ADR 0118, rule 8)", () => {
  const stored = async (json: unknown) => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO agent_settings (id, json) VALUES (1, ?)").run(JSON.stringify(json));
      return await new SqliteAgentSettings(db).get();
    } finally {
      db.close();
    }
  };

  it("reads settings stored before efforts as the starting values", async () => {
    const s = await stored({ enabled: true, models: { understand: "haiku" } });
    expect(s.efforts).toEqual(DEFAULT_AGENT_EFFORTS);
    expect(s.efforts).toEqual({
      understand: "low",
      write: "default",
      answer: "default",
      titles: "low",
    });
  });

  it("keeps each kind's known value and gives an unknown or missing one its start", async () => {
    const s = await stored({
      enabled: true,
      efforts: { understand: "max", write: "ultra", answer: 3, titles: "default", extra: "high" },
    });
    expect(s.efforts).toEqual({
      understand: "max",
      write: "default",
      answer: "default",
      titles: "default",
    });
    const t = await stored({ efforts: { write: "xhigh" } });
    expect(t.efforts).toEqual({
      understand: "low",
      write: "xhigh",
      answer: "default",
      titles: "low",
    });
    expect((await stored({ efforts: "high" })).efforts).toEqual(DEFAULT_AGENT_EFFORTS);
    expect((await stored({ efforts: null })).efforts).toEqual(DEFAULT_AGENT_EFFORTS);
  });
});
