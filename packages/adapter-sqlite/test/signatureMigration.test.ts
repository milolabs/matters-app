import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAccountStore } from "../src/accountStore.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openDatabase } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A database at schema 57 with an IMAP account and a Graph one, as the app left it. */
function versionFiftySeven(): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-v57-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  const old = new DatabaseSync(path);
  old.exec("PRAGMA journal_mode = WAL");
  old.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= 57)) {
    old.exec(m.sql);
    m.run?.(old);
    old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
  }
  old
    .prepare(
      `INSERT INTO accounts (id, address, display_name, transport, imap_host, imap_port,
                             imap_security, imap_username, max_message_bytes, created_at_ms)
       VALUES (?, ?, ?, 'imap', ?, ?, ?, ?, ?, ?)`,
    )
    .run("a1", "me@example.com", "Me", "imap.example.com", 993, "tls", "me", 25_000_000, 10);
  old
    .prepare(
      `INSERT INTO accounts (id, address, display_name, transport, created_at_ms)
       VALUES ('g1', 'me@outlook.example', 'Me', 'graph', 20)`,
    )
    .run();
  old.close();
  return path;
}

describe("migration 58: the person's own signature (ADR 0142)", () => {
  it("keeps every account as it was, with no signature, and keeps one set afterwards", async () => {
    const db = openDatabase(versionFiftySeven());
    const accounts = new SqliteAccountStore(db);
    try {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(58);
      expect(await accounts.list()).toEqual([
        {
          id: "a1",
          address: "me@example.com",
          displayName: "Me",
          imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
          messageLimitBytes: 25_000_000,
          createdAtMs: 10,
        },
        {
          id: "g1",
          transport: "graph",
          address: "me@outlook.example",
          displayName: "Me",
          createdAtMs: 20,
        },
      ]);
      const rows = db.prepare("SELECT signature FROM accounts ORDER BY id").all() as {
        signature: string | null;
      }[];
      expect(rows.map((r) => r.signature)).toEqual([null, null]);

      // The delimiter's trailing space is the app's to write; a signature's own spaces and line
      // ends come back exactly as kept.
      const signature = "Anna\n\n_Matters_ · +48 600 000 000";
      expect(await accounts.setSignature("g1", signature)).toBe(true);
      expect((await accounts.get("g1"))?.signature).toBe(signature);
      expect((await accounts.get("a1"))?.signature).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("migration 59: the id of the key a test ran on (ADR 0141), and whichever column is missing", () => {
  it("adds both columns to a database that took the key's column as its own 58", () => {
    const path = versionFiftySeven();
    // The branch of the key's id numbered its column 58 too: such a database says 58 and has
    // the key's column but no signature.
    const old = new DatabaseSync(path);
    old.exec("ALTER TABLE agent_runtime_records ADD COLUMN key_id TEXT");
    old.prepare("INSERT INTO schema_version VALUES (58, 0)").run();
    old.close();
    const db = openDatabase(path);
    try {
      const names = (table: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(names("accounts")).toContain("signature");
      expect(names("agent_runtime_records")).toContain("key_id");
    } finally {
      db.close();
    }
  });
});
