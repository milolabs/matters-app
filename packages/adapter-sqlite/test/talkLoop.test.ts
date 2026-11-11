import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openDatabase, SqliteAgentInsightStore, schemaVersion } from "../src/index.ts";

// ADR 0083: what the loop did for an answer (searches run, threads opened) is kept with it.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const found = {
  threadId: null,
  atMs: 5,
  role: "agent" as const,
  kind: "found" as const,
  text: "Here.",
  quotes: [],
  runtimeName: "Fake",
  model: "m",
  threads: 2,
  query: "offer",
  hits: [],
};

describe("what the loop did for an answer across all mail", () => {
  it("is stored with the answer and read back; an answer of the trail has none", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteAgentInsightStore(db);
    await store.appendTalk([
      { threadId: null, atMs: 4, role: "you", text: "q" },
      { ...found, loop: { searches: 3, read: 0 } },
      { ...found, atMs: 6 },
    ]);
    const list = await store.listTalk(null, 10);
    expect(list[1]).toMatchObject({ loop: { searches: 3, read: 0 } });
    expect(list[2]).not.toHaveProperty("loop");
    expect(list[0]).not.toHaveProperty("loop");
    db.close();
  });

  it("is added by migration 39 to a store from before it; its old rows read as the trail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v38-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 38)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    old
      .prepare(
        "INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, quotes_json, runtime_name, model, threads, query, hits_json) VALUES (NULL, 1, 'agent', 'found', 'Old answer', '[]', 'R', 'm', 1, 'offer', '[]')",
      )
      .run();
    expect(schemaVersion(old)).toBe(38);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
    const store = new SqliteAgentInsightStore(db);
    await store.appendTalk([{ ...found, atMs: 7, loop: { searches: 1, read: 1 } }]);
    const list = await store.listTalk(null, 10);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ text: "Old answer" });
    expect(list[0]).not.toHaveProperty("loop");
    expect(list[1]).toMatchObject({ loop: { searches: 1, read: 1 } });
    db.close();
  });
});
