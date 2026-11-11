import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  SqliteAgentSettings,
  schemaVersion,
} from "../src/index.ts";

// ADR 0119, rule 4: models and efforts are kept per runtime. Settings stored before read as the
// choices of the runtime they name, and are written back in the new shape.

const stored = async (json: unknown, work?: (s: SqliteAgentSettings) => Promise<void>) => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO agent_settings (id, json) VALUES (1, ?)").run(JSON.stringify(json));
    const settings = new SqliteAgentSettings(db);
    await work?.(settings);
    const row = db.prepare("SELECT json FROM agent_settings WHERE id = 1").get() as {
      json: string;
    };
    return { read: await settings.get(), raw: JSON.parse(row.json) as Record<string, unknown> };
  } finally {
    db.close();
  }
};

const old = {
  enabled: true,
  runtimeId: "claude-code",
  models: { understand: "sonnet", write: "opus", answer: "sonnet", titles: "haiku" },
  efforts: { understand: "medium", write: "default", answer: "default", titles: "low" },
  weekSharePercent: 10,
  usedByUsPercent: 0,
};

describe("choices per runtime in stored settings (ADR 0119, rule 4)", () => {
  it("reads flat settings from before as the chosen runtime's, and writes the new shape", async () => {
    const { read, raw } = await stored(old, async (s) => {
      await s.update({ runtimeId: "ollama" });
      await s.update({ models: { understand: "q", write: "q", answer: "q", titles: "q" } });
    });
    expect(read.models.write).toBe("q");
    expect(
      (raw.choices as Record<string, { models: { write: string } }>)["claude-code"]?.models.write,
    ).toBe("opus");
    const back = await stored(raw, async (s) => {
      await s.update({ runtimeId: "claude-code" });
    });
    expect(back.read.models).toEqual(old.models);
    expect(back.read.efforts).toEqual(old.efforts);
  });

  it("reads flat settings that chose no runtime as Claude Code's, and chooses none", async () => {
    const { runtimeId: _r, ...none } = old;
    const { read } = await stored(none);
    expect(read.runtimeId).toBeUndefined();
    expect(read.models).toEqual(old.models);
    expect(read.choices?.["claude-code"]?.models).toEqual(old.models);
  });
});

describe("migration 55: the test of a runtime is for a model (ADR 0119)", () => {
  it("reads a record from before as one with no model, and keeps the model of a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v55-"));
    try {
      const path = join(dir, "mail.db");
      const old = new DatabaseSync(path);
      old.exec("PRAGMA journal_mode = WAL");
      old.exec(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
      );
      for (const m of MIGRATIONS.filter((x) => x.version <= 54)) {
        old.exec(m.sql);
        m.run?.(old);
        old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
      }
      old
        .prepare(
          "INSERT INTO agent_runtime_records (runtime_id, status, plan, problem, tested_at_ms) VALUES ('claude-code', 'ready', 'max', NULL, 3)",
        )
        .run();
      old.close();
      const db = openDatabase(path);
      try {
        expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
        const settings = new SqliteAgentSettings(db);
        expect(await settings.getRuntimeRecord("claude-code")).toEqual({
          runtimeId: "claude-code",
          status: "ready",
          plan: "max",
          testedAtMs: 3,
        });
        await settings.putRuntimeRecord({
          runtimeId: "claude-code",
          status: "ready",
          plan: "max",
          model: "haiku",
          testedAtMs: 4,
        });
        expect((await settings.getRuntimeRecord("claude-code"))?.model).toBe("haiku");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
