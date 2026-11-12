import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_AGENT_MODELS } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  SqliteAgentSettings,
  schemaVersion,
} from "../src/index.ts";

// ADR 0119, rule 4: models and efforts are kept per runtime. ADR 0121: a runtime per kind of work.
// Settings stored before read as the choices of the runtime they name, every kind on it, and are
// written back in the new shape.

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

const all = (id: string) => ({ understand: id, write: id, answer: id, titles: id });

describe("choices per runtime in stored settings (ADR 0119, rule 4; ADR 0121, rule 12)", () => {
  it("reads one chosen runtime from before as every kind on it, and writes the new shape", async () => {
    const limits = { week: { usedPercent: 20, resetsAtMs: 50 }, usingOverage: false, seenAtMs: 4 };
    const { read, raw } = await stored({ ...old, limits, usedByUsPercent: 2 }, async (s) => {
      await s.update({ kindRuntime: { understand: "ollama" } });
      await s.update({ choices: { ollama: { models: all("q") } } });
    });
    expect(read.kindRuntime).toEqual({ ...all("claude-code"), understand: "ollama" });
    expect(read.models).toEqual({ ...old.models, understand: "q" });
    expect(read.plans).toEqual({ "claude-code": { limits, usedByUsPercent: 2 } });
    expect(
      (raw.choices as Record<string, { models: { write: string } }>)["claude-code"]?.models.write,
    ).toBe("opus");
    for (const key of ["runtimeId", "limits", "usedByUsPercent"]) expect(key in raw).toBe(false);
    const back = await stored(raw, async (s) => {
      await s.update({ kindRuntime: { understand: "claude-code" } });
    });
    expect(back.read.models).toEqual(old.models);
    expect(back.read.efforts).toEqual(old.efforts);
    expect(back.read.plans?.["claude-code"]?.limits).toEqual(limits);
  });

  it("reads flat settings that chose no runtime as Claude Code's, and puts no kind on any", async () => {
    const { runtimeId: _r, ...none } = old;
    const { read } = await stored(none);
    expect(read.kindRuntime).toEqual({});
    // No kind is on a runtime: the start shows until one is, and Claude Code's are kept for it.
    expect(read.models).toEqual(DEFAULT_AGENT_MODELS);
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
