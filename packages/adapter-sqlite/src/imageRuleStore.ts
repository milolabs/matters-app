import type {
  GeneralImages,
  ImageRule,
  ImageRuleDecision,
  ImageRuleScope,
  ImageRuleStorePort,
} from "@matters/core";
import { type Database, write } from "./database.ts";

interface Row {
  scope: string;
  value: string;
  decision: string;
  created_ms: number;
}

function toRule(row: Row): ImageRule {
  return {
    scope: row.scope as ImageRuleScope,
    value: row.value,
    decision: row.decision as ImageRuleDecision,
    createdMs: row.created_ms,
  };
}

/** ADR 0037. The primary key is `(scope, value)`, so opening a message costs two keyed lookups. */
export class SqliteImageRuleStore implements ImageRuleStorePort {
  private readonly db: Database;
  private readonly selectOne;
  private readonly selectAll;
  private readonly upsert;
  private readonly insertIfAbsent;
  private readonly delete_;
  private readonly selectGeneral;
  private readonly updateGeneral;

  constructor(db: Database) {
    this.db = db;
    this.selectOne = db.prepare("SELECT * FROM image_rules WHERE scope = ? AND value = ?");
    this.selectAll = db.prepare("SELECT * FROM image_rules ORDER BY created_ms DESC, scope, value");
    this.upsert = db.prepare(`
      INSERT INTO image_rules (scope, value, decision, created_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, value) DO UPDATE SET decision = excluded.decision,
        created_ms = excluded.created_ms`);
    this.insertIfAbsent = db.prepare(
      "INSERT OR IGNORE INTO image_rules (scope, value, decision, created_ms) VALUES (?, ?, ?, ?)",
    );
    this.delete_ = db.prepare("DELETE FROM image_rules WHERE scope = ? AND value = ?");
    this.selectGeneral = db.prepare("SELECT general FROM image_setting WHERE id = 1");
    this.updateGeneral = db.prepare(
      "INSERT INTO image_setting (id, general) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET general = excluded.general",
    );
  }

  async get(scope: ImageRuleScope, value: string): Promise<ImageRule | null> {
    const row = this.selectOne.get(scope, value) as Row | undefined;
    return row ? toRule(row) : null;
  }

  async list(): Promise<readonly ImageRule[]> {
    return (this.selectAll.all() as unknown as Row[]).map(toRule);
  }

  async put(rule: ImageRule): Promise<void> {
    await write(this.db, () => {
      this.upsert.run(rule.scope, rule.value, rule.decision, rule.createdMs);
    });
  }

  async putIfAbsent(rules: readonly ImageRule[]): Promise<number> {
    return write(this.db, () => {
      let added = 0;
      for (const r of rules) {
        added += Number(this.insertIfAbsent.run(r.scope, r.value, r.decision, r.createdMs).changes);
      }
      return added;
    });
  }

  async remove(scope: ImageRuleScope, value: string): Promise<boolean> {
    return write(this.db, () => Number(this.delete_.run(scope, value).changes) > 0);
  }

  async getGeneral(): Promise<GeneralImages> {
    const row = this.selectGeneral.get() as { general: string } | undefined;
    return row?.general === "always" ? "always" : "ask";
  }

  async setGeneral(value: GeneralImages): Promise<void> {
    await write(this.db, () => {
      this.updateGeneral.run(value);
    });
  }
}
