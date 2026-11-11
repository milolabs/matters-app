import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openDatabase, SqliteAgentInsightStore, schemaVersion } from "../src/index.ts";

// ADR 0080: what a question across all mail leaves for the next one is kept with the answer.

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

describe("the carried state of a talk across all mail", () => {
  it("is stored with the answer, read back, and loses the threads that are removed", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteAgentInsightStore(db);
    await store.appendTalk([
      { threadId: null, atMs: 4, role: "you", text: "q" },
      {
        ...found,
        carry: {
          hypothesis: "The signed letter",
          threadIds: ["t1", "t2"],
          queries: ["offer", "x"],
        },
      },
      { ...found, atMs: 6 },
    ]);
    const list = await store.listTalk(null, 10);
    expect(list[1]).toMatchObject({
      carry: { hypothesis: "The signed letter", threadIds: ["t1", "t2"], queries: ["offer", "x"] },
    });
    expect(list[2]).not.toHaveProperty("carry");
    expect(list[0]).not.toHaveProperty("carry");
    await store.removeForThreads(["t1"]);
    const after = await store.listTalk(null, 10);
    expect(after[1]).toMatchObject({
      carry: { threadIds: ["t2"], hypothesis: "The signed letter" },
    });
    db.close();
  });

  it("is added by migration 38 to a store from before it, keeping the talk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v37-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 37)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    old
      .prepare(
        "INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, quotes_json, runtime_name, model, threads, query, hits_json) VALUES (NULL, 1, 'agent', 'found', 'Old answer', '[]', 'R', 'm', 1, 'offer', '[]')",
      )
      .run();
    expect(schemaVersion(old)).toBe(37);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
    const list = await new SqliteAgentInsightStore(db).listTalk(null, 10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ text: "Old answer", query: "offer" });
    expect(list[0]).not.toHaveProperty("carry");
    db.close();
  });
});
