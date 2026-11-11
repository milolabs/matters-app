import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openDatabase, schemaVersion } from "../src/index.ts";

// ADR 0103, rule 1: an update of a database that holds mail says how far it is; a new one does not.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function databaseAt(version: number): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-steps-"));
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

describe("migration steps", () => {
  it("counts the steps of an update, from 1, before each one", () => {
    const path = databaseAt(LATEST_SCHEMA_VERSION - 3);
    const steps: [number, number][] = [];
    const db = openDatabase(path, (step, total) => steps.push([step, total]));
    expect(steps).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("says nothing for a new database, nor for one that is current", () => {
    const steps: number[] = [];
    const fresh = openDatabase(":memory:", (step) => steps.push(step));
    fresh.close();
    const path = databaseAt(LATEST_SCHEMA_VERSION);
    openDatabase(path, (step) => steps.push(step)).close();
    expect(steps).toEqual([]);
  });
});
