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

/** A database at schema 56 with two IMAP accounts and a location, as the app left it. */
function versionFiftySix(): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-v56-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  const old = new DatabaseSync(path);
  old.exec("PRAGMA journal_mode = WAL");
  old.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= 56)) {
    old.exec(m.sql);
    m.run?.(old);
    old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
  }
  old
    .prepare(
      `INSERT INTO accounts (id, address, display_name, imap_host, imap_port, imap_security,
                             imap_username, smtp_host, smtp_port, smtp_security, smtp_username,
                             max_message_bytes, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "a1",
      "me@example.com",
      "Me",
      "imap.example.com",
      993,
      "tls",
      "me",
      "smtp.example.com",
      587,
      "starttls",
      "me",
      25_000_000,
      10,
    );
  old
    .prepare(
      `INSERT INTO accounts (id, address, display_name, imap_host, imap_port, imap_security,
                             imap_username, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("a2", "you@example.org", "You", "mail.example.org", 143, "starttls", "you", 20);
  old.close();
  return path;
}

describe("migration 57: an account's transport and a copy's own handle (ADR 0136)", () => {
  it("keeps every IMAP account as it was, on the imap transport", async () => {
    const db = openDatabase(versionFiftySix());
    const storage = { accounts: new SqliteAccountStore(db) };
    try {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
      expect(await storage.accounts.list()).toEqual([
        {
          id: "a1",
          address: "me@example.com",
          displayName: "Me",
          imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
          smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "me" },
          messageLimitBytes: 25_000_000,
          createdAtMs: 10,
        },
        {
          id: "a2",
          address: "you@example.org",
          displayName: "You",
          imap: { host: "mail.example.org", port: 143, security: "starttls", username: "you" },
          createdAtMs: 20,
        },
      ]);
      const rows = db.prepare("SELECT transport FROM accounts ORDER BY id").all() as {
        transport: string;
      }[];
      expect(rows.map((r) => r.transport)).toEqual(["imap", "imap"]);
      // Still one address per account, whatever its case.
      await expect(
        storage.accounts.add({
          id: "a3",
          transport: "graph",
          address: "ME@example.com",
          displayName: "",
          createdAtMs: 30,
        }),
      ).rejects.toMatchObject({ name: "AccountExistsError" });
    } finally {
      db.close();
    }
  });

  it("refuses an IMAP account without its server, and takes a Graph one without any", async () => {
    const db = openDatabase(versionFiftySix());
    const storage = { accounts: new SqliteAccountStore(db) };
    try {
      expect(() =>
        db
          .prepare(
            "INSERT INTO accounts (id, address, display_name, transport, created_at_ms) VALUES ('x', 'x@example.com', 'x', 'imap', 1)",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      await storage.accounts.add({
        id: "g1",
        transport: "graph",
        address: "me@outlook.example",
        displayName: "Me",
        createdAtMs: 30,
      });
      const row = db.prepare("SELECT * FROM accounts WHERE id = 'g1'").get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({ transport: "graph", imap_host: null, smtp_host: null });
      expect(await storage.accounts.get("g1")).toEqual({
        id: "g1",
        transport: "graph",
        address: "me@outlook.example",
        displayName: "Me",
        createdAtMs: 30,
      });
    } finally {
      db.close();
    }
  });
});
