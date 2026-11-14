import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_AGENT_MODELS } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  SqliteAgentInsightStore,
  SqliteAgentSettings,
  schemaVersion,
} from "../src/index.ts";

// ADR 0086, rule 15: the old stream of all mail is cut into talks at each pause of two hours.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

function storeAt39(): { path: string; old: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "matters-v39-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= 39)) {
    old.exec(m.sql);
    m.run?.(old);
    old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
  }
  return { path, old };
}

describe("migration 40: talks across all mail", () => {
  it("cuts the old stream at each long pause, keeping every entry and the threads' talks", async () => {
    const { path, old } = storeAt39();
    const add = old.prepare(
      "INSERT INTO agent_talk (thread_id, at_ms, role, text) VALUES (?, ?, 'you', ?)",
    );
    add.run(null, 0, "job change");
    add.run(null, 1 * HOUR, "and the contract?");
    add.run("t1", 2 * HOUR, "thread words");
    // Exactly two hours is still the same talk; more is a new one.
    add.run(null, 3 * HOUR, "the notice period");
    add.run(null, 10 * HOUR, "the car insurance");
    expect(schemaVersion(old)).toBe(39);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const store = new SqliteAgentInsightStore(db);
    const talks = await store.listTalks();
    expect(talks.map((t) => [t.firstWords, t.entries, t.startedAtMs, t.lastAtMs])).toEqual([
      ["the car insurance", 1, 10 * HOUR, 10 * HOUR],
      ["job change", 3, 0, 3 * HOUR],
    ]);
    expect(talks.every((t) => t.title === undefined)).toBe(true);
    const [newest, oldest] = talks;
    const first = await store.listTalk(null, 10, { talkId: oldest?.id ?? 0 });
    expect(first.map((e) => (e.role === "you" ? e.text : ""))).toEqual([
      "job change",
      "and the contract?",
      "the notice period",
    ]);
    expect(await store.listTalk(null, 10, { talkId: newest?.id ?? 0 })).toHaveLength(1);
    const thread = await store.listTalk("t1", 10);
    expect(thread).toHaveLength(1);
    expect(thread[0]).not.toHaveProperty("talkId");
    db.close();
  });

  it("makes no talk when there was no talk across all mail", async () => {
    const { path, old } = storeAt39();
    old.close();
    const db = openDatabase(path);
    expect(await new SqliteAgentInsightStore(db).listTalks()).toEqual([]);
    db.close();
  });

  it("gives models stored before titles existed the default for titles", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO agent_settings (id, json) VALUES (1, ?)").run(
      JSON.stringify({
        enabled: true,
        windowDays: 30,
        models: { understand: "a", draftAhead: "b", write: "c", answer: "d" },
      }),
    );
    const settings = await new SqliteAgentSettings(db).get();
    // What only the reading of ADR 0052 had is not read (ADR 0117).
    expect("windowDays" in settings).toBe(false);
    // They name no runtime: what they hold is Claude Code's (ADR 0119, rule 4).
    expect(settings.choices?.["claude-code"]?.models).toEqual({
      understand: "a",
      write: "c",
      answer: "d",
      titles: DEFAULT_AGENT_MODELS.titles,
      appearance: "c",
    });
    db.close();
  });
});
