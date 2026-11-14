// ADR 0138, rules 2, 5 and 6: every table is declared, and removing an account leaves no row,
// index word or free page of it, while the other account stays whole.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeAccount, undeclaredTables } from "@matters/core";
import { makeDocument, person } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  openDatabase,
  SQLITE_HOLDINGS,
  schemaTables,
  TABLE_RULES,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the database's holdings", () => {
  it("declares every table of the schema, shadow tables included", () => {
    const db = openDatabase(":memory:");
    try {
      expect(undeclaredTables(SQLITE_HOLDINGS, schemaTables(db))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("says for every table how an account's removal treats it", () => {
    for (const r of TABLE_RULES) {
      if (r.scope === "account") expect(r.discard ?? r.coveredBy, r.table).toBeDefined();
      if (r.scope === "derived") expect(r.prune ?? r.coveredBy, r.table).toBeDefined();
      if (r.scope === "shared") expect(r.discard ?? r.prune, r.table).toBeUndefined();
    }
    const names = TABLE_RULES.map((r) => r.table);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("removing an account (ADR 0138, rule 5)", () => {
  it("leaves nothing of it in any table, the index or the file, and keeps the other", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-holdings-"));
    dirs.push(dir);
    const path = join(dir, "matters.db");
    const storage = createSqliteStorage(path);
    const gone = makeDocument(
      {
        accountId: "a1",
        threadId: "t-gone",
        subject: "Zebraquokka invoice",
        from: person("Quentin Zebraquokka", "quentin@zebraquokka.example"),
      },
      "the zebraquokka body",
    );
    const kept = makeDocument(
      {
        accountId: "a2",
        threadId: "t-kept",
        subject: "Lighthouse plans",
        from: person("Lena Lighthouse", "lena@lighthouse.example"),
      },
      "the lighthouse body",
    );
    try {
      for (const a of ["a1", "a2"]) {
        await storage.accounts.add({
          id: a,
          address: `${a}@example.com`,
          displayName: a,
          imap: { host: "imap.example.com", port: 993, security: "tls", username: a },
          createdAtMs: 1,
        });
      }
      const { keys } = await storage.store.upsertMessages([gone.message, kept.message]);
      await storage.index.indexMessages([
        { ...gone, message: { ...gone.message, key: keys[0] ?? 0 } },
        { ...kept, message: { ...kept.message, key: keys[1] ?? 0 } },
      ]);
      await storage.bodies.putBodies([
        { key: keys[0] ?? 0, threadId: "t-gone", text: gone.bodyText },
        { key: keys[1] ?? 0, threadId: "t-kept", text: kept.bodyText },
      ]);
      // What agents wrote, through a second connection as the tables hold it.
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA busy_timeout = 5000");
      for (const [t, account] of [
        ["t-gone", "a1"],
        ["t-kept", "a2"],
      ] as const) {
        raw
          .prepare(
            `INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state,
               headline, facts_json, stakes, confidence, analyzed_at_ms)
             VALUES (?, 1, 1, 'onYou', ?, '[]', 'none', 0.9, 1)`,
          )
          .run(t, `${t === "t-gone" ? "Zebraquokka" : "Lighthouse"} wants an answer`);
        raw
          .prepare(
            "INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address) VALUES (1, 'closed', 'person', ?, 1, 'x')",
          )
          .run(t);
        raw
          .prepare(
            "INSERT INTO agent_talk (thread_id, at_ms, role, kind, text) VALUES (?, 1, 'agent', 'answer', 'about the thread')",
          )
          .run(t);
        raw
          .prepare(
            "INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads) VALUES (1, 'r', ?, 'analysis', 1)",
          )
          .run(account);
        // A Graph copy's handle (ADR 0136, rule 6), as the store keeps it with its location.
        raw
          .prepare(
            "INSERT INTO location_items (account_id, folder_id, item_id, uid) VALUES (?, 'inbox', ?, 1)",
          )
          .run(account, `item-${account}`);
      }
      // An answer across all mail that quoted the removed thread, and one that did not.
      const talk = Number(
        raw.prepare("INSERT INTO agent_talks (started_at_ms, last_at_ms) VALUES (1, 1)").run()
          .lastInsertRowid,
      );
      raw
        .prepare(
          "INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, talk_id) VALUES (NULL, 1, 'you', NULL, 'who wrote?', ?)",
        )
        .run(talk);
      raw
        .prepare(
          `INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, hits_json, talk_id)
           VALUES (NULL, 2, 'agent', 'found', 'Zebraquokka wrote', ?, ?)`,
        )
        .run(JSON.stringify([{ threadId: "t-gone" }]), talk);
      // Facts from the removed mail (senders, not threads), in an answer that cites no thread,
      // and an answer citing only the kept thread: across all mail, every answer goes.
      raw
        .prepare(
          `INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, facts_json, talk_id)
           VALUES (NULL, 3, 'agent', 'found', 'Two senders wrote', ?, ?)`,
        )
        .run(JSON.stringify([{ kind: "sender", text: "quentin@zebraquokka.example" }]), talk);
      raw
        .prepare(
          `INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, hits_json, talk_id)
           VALUES (NULL, 4, 'agent', 'found', 'Lena wrote', ?, ?)`,
        )
        .run(JSON.stringify([{ threadId: "t-kept" }]), talk);
      raw
        .prepare(
          "INSERT INTO agent_bundle_reads (signature, edges_json, read_at_ms) VALUES ('s', '[]', 1)",
        )
        .run();
      raw.close();

      await removeAccount(
        {
          ...storage,
          accountData: storage.accountData,
          credentials: { delete: async () => {} } as never,
        },
        "a1",
      );
      await storage.accountData.mergeIndexes();
      await storage.storageSamples.compact();

      const check = new DatabaseSync(path, { readOnly: true });
      const n = (sql: string, ...args: (string | number)[]) =>
        (check.prepare(sql).get(...args) as { n: number }).n;
      // No row of the account in a table with an account column.
      for (const table of schemaTables(check)) {
        const columns = check.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
        if (columns.some((c) => c.name === "account_id")) {
          expect(n(`SELECT COUNT(*) AS n FROM "${table}" WHERE account_id = 'a1'`), table).toBe(0);
        }
        if (columns.some((c) => c.name === "thread_id")) {
          expect(n(`SELECT COUNT(*) AS n FROM "${table}" WHERE thread_id = 't-gone'`), table).toBe(
            0,
          );
        }
      }
      expect(n("SELECT COUNT(*) AS n FROM accounts WHERE id = 'a1'")).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM people WHERE address LIKE '%zebraquokka%'")).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM people_words WHERE word LIKE 'zebra%'")).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM message_terms WHERE term LIKE 'zebra%'")).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM agent_talk WHERE text LIKE '%Zebraquokka%'")).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM agent_talk WHERE facts_json LIKE '%zebraquokka%'")).toBe(
        0,
      );
      expect(
        n("SELECT COUNT(*) AS n FROM agent_talk WHERE thread_id IS NULL AND role = 'agent'"),
      ).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM agent_bundle_reads")).toBe(0);
      // The question the person typed stays, and so does its talk.
      expect(n("SELECT COUNT(*) AS n FROM agent_talk WHERE text = 'who wrote?'")).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM agent_talks")).toBe(1);
      // The other account is whole.
      expect(n("SELECT COUNT(*) AS n FROM messages WHERE account_id = 'a2'")).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM agent_analyses WHERE thread_id = 't-kept'")).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM agent_talk WHERE thread_id = 't-kept'")).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM agent_ledger WHERE account_id = 'a2'")).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM location_items WHERE account_id = 'a2'")).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM people WHERE address = 'lena@lighthouse.example'")).toBe(
        1,
      );
      expect(n("SELECT COUNT(*) AS n FROM message_terms WHERE term = 'lighthouse'")).toBe(1);
      check.close();
      storage.close();
      // Compacted and checkpointed: the removed account's words are not in the file's pages.
      const bytes = Buffer.concat(
        [path, `${path}-wal`].filter(existsSync).map((p) => readFileSync(p)),
      );
      expect(bytes.includes(Buffer.from("Zebraquokka"))).toBe(false);
      expect(bytes.includes(Buffer.from("zebraquokka.example"))).toBe(false);
      expect(bytes.includes(Buffer.from("Lighthouse plans"))).toBe(true);
    } finally {
      try {
        storage.close();
      } catch {
        // Closed above.
      }
    }
  });
});
