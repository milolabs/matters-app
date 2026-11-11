import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  openDatabase,
  planSubjectJoins,
  SqliteMessageStore,
  schemaVersion,
} from "../src/index.ts";

// ADR 0091: a reply joins the thread it answers.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
let seq = 0;
const T0 = Date.UTC(2026, 10, 6);

/** A message on a local thread named the way sync names it: by its first reference. */
function local(
  id: string,
  parents: readonly string[],
  day: number,
  extra: Partial<Message> = {},
): Message {
  const accountId = extra.accountId ?? "acc1";
  return makeMessage({
    providerId: `${id}-${extra.providerId ?? "inbox"}`,
    messageIdHeader: `<${id}>`,
    threadId: `lt:${accountId}:${parents[0] ? `<${parents[0]}>` : `<${id}>`}`,
    parentIds: parents.map((p) => `<${p}>`),
    dateMs: T0 + day * DAY,
    seq: ++seq,
    ...extra,
  });
}

function threadsOf(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare("SELECT message_id_header, provider_id, thread_id FROM messages")
    .all() as {
    message_id_header: string;
    provider_id: string;
    thread_id: string;
  }[];
  return new Map(rows.map((r) => [r.provider_id, r.thread_id]));
}

describe("a message on a local thread joins what it touches", () => {
  it("puts a reply whose References skip the first message into its conversation", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    // The case of the ADR: the contractor's webmail points only at the owner's reply.
    await store.upsertMessages([local("quote", [], 0)]);
    await store.upsertMessages([local("answer", ["quote"], 0.1)]);
    await store.upsertMessages([local("reply", ["answer"], 0.3)]);
    // The owner's next reply, built from the split thread, and its two copies.
    await store.upsertMessages([local("again", ["reply"], 3, { providerId: "sent" })]);
    await store.upsertMessages([
      local("again", ["answer", "reply"], 3, {
        providerId: "server",
        threadId: "lt:acc1:<answer>",
      }),
    ]);
    const threads = threadsOf(db);
    expect(new Set(threads.values())).toEqual(new Set(["lt:acc1:<quote>"]));
    const view = await store.getThread("lt:acc1:<quote>");
    expect(view?.messages.map((m) => m.messageIdHeader)).toEqual([
      "<quote>",
      "<answer>",
      "<reply>",
      "<again>",
      "<again>",
    ]);
  });

  it("merges a reply's thread into its parent's when the parent arrives later", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([local("first", [], 0)]);
    await store.upsertMessages([local("late-child", ["middle"], 2)]);
    await store.upsertMessages([local("other", [], 1)]);
    const before = (
      db
        .prepare("SELECT change_seq FROM messages WHERE provider_id = 'late-child-inbox'")
        .get() as {
        change_seq: number;
      }
    ).change_seq;
    const { changeSeq } = await store.upsertMessages([local("middle", ["first"], 1)]);
    const threads = threadsOf(db);
    expect(threads.get("late-child-inbox")).toBe("lt:acc1:<first>");
    expect(threads.get("middle-inbox")).toBe("lt:acc1:<first>");
    expect(threads.get("other-inbox")).toBe("lt:acc1:<other>");
    const after = (
      db
        .prepare("SELECT change_seq FROM messages WHERE provider_id = 'late-child-inbox'")
        .get() as {
        change_seq: number;
      }
    ).change_seq;
    expect(after).toBe(changeSeq);
    expect(after).toBeGreaterThan(before);
  });

  it("leaves provider threads and other accounts alone", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([local("root", [], 0)]);
    await store.upsertMessages([
      local("gmail", ["root"], 1, { threadId: "pt:acc1:42" }),
      local("elsewhere", ["root"], 1, { accountId: "acc2" }),
    ]);
    const threads = threadsOf(db);
    expect(threads.get("gmail-inbox")).toBe("pt:acc1:42");
    expect(threads.get("elsewhere-inbox")).toBe("lt:acc2:<root>");
    expect(threads.get("root-inbox")).toBe("lt:acc1:<root>");
  });

  it("carries what a thread owns into the merge and drops the agent's readings", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([local("first", [], 0), local("child", ["middle"], 2)]);
    const loser = "lt:acc1:<middle>";
    const winner = "lt:acc1:<first>";
    db.prepare(
      "INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms) VALUES (?, 1, 'a@b', 'later', 0)",
    ).run(loser);
    db.prepare(
      "INSERT INTO drafts (id, account_id, thread_id, content_json, version, fingerprint, updated_at_ms) VALUES ('d1', 'acc1', ?, '{}', 1, 'f', 0)",
    ).run(loser);
    for (const t of [loser, winner]) {
      db.prepare(
        "INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline, facts_json, stakes, confidence, analyzed_at_ms) VALUES (?, 1, 1, 'waiting', 'h', '[]', 'none', 1, 0)",
      ).run(t);
    }
    await store.upsertMessages([local("middle", ["first"], 1)]);
    const feedback = db.prepare("SELECT thread_id FROM agent_feedback").all() as {
      thread_id: string;
    }[];
    expect(feedback.map((r) => r.thread_id)).toEqual([winner]);
    expect(
      (db.prepare("SELECT thread_id FROM drafts").get() as { thread_id: string }).thread_id,
    ).toBe(winner);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_analyses").get()).toEqual({ n: 0 });
  });
});

describe("upgrade to schema 45 (ADR 0091, rule 6)", () => {
  it("joins the threads stored before, by the roots their ids name", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v44-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 44)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const insert = old.prepare(`
      INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
                            from_json, to_json, cc_json, subject, snippet, flags, has_attachments,
                            change_seq)
      VALUES (?, 'acc1', ?, ?, ?, ?, '{"address":"a@b"}', '[]', '[]', 's', '', 0, 0, 0)`);
    const rows: [string, string][] = [
      ["quote", "lt:acc1:<quote>"],
      ["answer", "lt:acc1:<quote>"],
      ["reply", "lt:acc1:<answer>"],
      ["again", "lt:acc1:<reply>"],
      ["alone", "lt:acc1:<alone>"],
      ["gmail", "pt:acc1:7"],
    ];
    rows.forEach(([id, thread], i) => {
      insert.run(i + 1, id, thread, `<${id}>`, T0 + i * DAY);
    });
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(45);
    const threads = threadsOf(db);
    for (const id of ["quote", "answer", "reply", "again"]) {
      expect(threads.get(id)).toBe("lt:acc1:<quote>");
    }
    expect(threads.get("alone")).toBe("lt:acc1:<alone>");
    expect(threads.get("gmail")).toBe("pt:acc1:7");
    const refs = db
      .prepare(
        "SELECT ref_id FROM message_refs r JOIN messages m ON m.key = r.key WHERE m.provider_id = 'reply'",
      )
      .all() as { ref_id: string }[];
    expect(refs.map((r) => r.ref_id)).toEqual(["<answer>"]);
    const moved = db
      .prepare("SELECT change_seq FROM messages WHERE provider_id = 'reply'")
      .get() as {
      change_seq: number;
    };
    expect(moved.change_seq).toBeGreaterThan(0);
    db.close();
  });
});

describe("a second copy of one message is not shown (ADR 0092, rule 4)", () => {
  const copy = (providerId: string, labelIds: string[], seqNo: number) =>
    makeMessage({
      providerId,
      messageIdHeader: "<sent-twice>",
      threadId: "lt:acc1:<sent-twice>",
      dateMs: T0,
      seq: seqNo,
      labelIds,
    });

  it("shows one of two copies in the same folders, and the other when the first goes", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([copy("appended", ["sent"], 1), copy("filed", ["sent"], 2)]);
    const shown = await store.getThread("lt:acc1:<sent-twice>", { visibleOnly: true });
    expect(shown?.messages.map((m) => m.providerId)).toEqual(["appended"]);
    // Moves and deletes still reach every copy.
    const all = await store.getThread("lt:acc1:<sent-twice>");
    expect(all?.messages).toHaveLength(2);
    const newest = await store.listNewest({ limit: 10 });
    expect(newest.map((m) => m.providerId)).toEqual(["appended"]);

    await store.removeByProviderIds("acc1", ["appended"]);
    const after = await store.getThread("lt:acc1:<sent-twice>", { visibleOnly: true });
    expect(after?.messages.map((m) => m.providerId)).toEqual(["filed"]);
  });

  it("keeps both when they are in different folders: sent to oneself", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([copy("out", ["sent"], 1), copy("in", ["inbox"], 2)]);
    const shown = await store.getThread("lt:acc1:<sent-twice>", { visibleOnly: true });
    expect(shown?.messages).toHaveLength(2);
  });
});

describe("a reply without ids joins the thread it answers (ADR 0104)", () => {
  const builder = { name: "Builder", address: "builder@example.com" };
  const me = { name: "Me", address: "me@example.com" };
  const SUBJECT = "Floor quote";
  /** The person's message, recorded in Sent. */
  const mine = (
    id: string,
    parents: readonly string[],
    day: number,
    extra: Partial<Message> = {},
  ) =>
    local(id, parents, day, {
      from: me,
      to: [builder],
      subject: `Re: ${SUBJECT}`,
      labelIds: ["sent"],
      ...extra,
    });
  const theirs = (
    id: string,
    parents: readonly string[],
    day: number,
    extra: Partial<Message> = {},
  ) =>
    local(id, parents, day, {
      from: builder,
      to: [me],
      subject: parents.length === 0 && id === "root" ? SUBJECT : `Re: Re: ${SUBJECT}`,
      ...extra,
    });

  /** The conversation of the observed case, up to the reply that carries no ids. */
  async function conversation(store: SqliteMessageStore): Promise<void> {
    await store.upsertMessages([theirs("root", [], 0)]);
    await store.upsertMessages([mine("p1", ["root"], 0.5)]);
    await store.upsertMessages([theirs("c1", ["p1"], 1)]);
    await store.upsertMessages([mine("p2", ["root", "c1"], 2)]);
  }

  it("puts the contractor's reply without ids into the conversation and drops its readings", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await conversation(store);
    const thread = "lt:acc1:<root>";
    expect(new Set(threadsOf(db).values())).toEqual(new Set([thread]));
    db.prepare(
      "INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline, facts_json, stakes, confidence, analyzed_at_ms) VALUES (?, 1, 1, 'waiting', 'h', '[]', 'none', 1, 0)",
    ).run(thread);
    await store.upsertMessages([theirs("c2", [], 3)]);
    expect(threadsOf(db).get("c2-inbox")).toBe(thread);
    const view = await store.getThread(thread);
    expect(view?.messages.map((m) => m.messageIdHeader)).toEqual([
      "<root>",
      "<p1>",
      "<c1>",
      "<p2>",
      "<c2>",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_analyses").get()).toEqual({ n: 0 });
    // Read again, it stays where it is.
    await store.upsertMessages([theirs("c2", [], 3)]);
    expect(threadsOf(db).get("c2-inbox")).toBe(thread);
  });

  it("knows the person by the account's address as well as by Sent", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO accounts (id, address, display_name, imap_host, imap_port, imap_security, imap_username, created_at_ms) VALUES ('acc1', 'Me@Example.com', 'Me', 'imap.example.com', 993, 'tls', 'me', 0)",
    ).run();
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([theirs("root", [], 0)]);
    // The person copied themselves, so only rule 2 keeps their own reply out below.
    await store.upsertMessages([mine("p1", ["root"], 0.5, { labelIds: ["archive"], cc: [me] })]);
    await store.upsertMessages([theirs("c2", [], 3)]);
    expect(threadsOf(db).get("c2-inbox")).toBe("lt:acc1:<root>");
    // A reply of the person's without ids is not joined.
    await store.upsertMessages([mine("p9", [], 4, { labelIds: ["archive"] })]);
    expect(threadsOf(db).get("p9-inbox")).toBe("lt:acc1:<p9>");
  });

  it("leaves split a sender the person never wrote to, a provider thread and a message whose headers were not read", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteMessageStore(db);
    await conversation(store);
    const stranger = { address: "stranger@example.com" };
    await store.upsertMessages([theirs("s1", [], 3, { from: stranger })]);
    await store.upsertMessages([theirs("g1", [], 3, { threadId: "pt:acc1:77" })]);
    const unread = theirs("u1", [], 3);
    const { parentIds: _, ...noHeaders } = unread;
    await store.upsertMessages([noHeaders]);
    await store.upsertMessages([theirs("f1", [], 3, { subject: `Fwd: ${SUBJECT}` })]);
    await store.upsertMessages([theirs("a1", [], 3, { accountId: "acc2" })]);
    const threads = threadsOf(db);
    expect(threads.get("s1-inbox")).toBe("lt:acc1:<s1>");
    expect(threads.get("g1-inbox")).toBe("pt:acc1:77");
    expect(threads.get("u1-inbox")).toBe("lt:acc1:<u1>");
    expect(threads.get("f1-inbox")).toBe("lt:acc1:<f1>");
    expect(threads.get("a1-inbox")).toBe("lt:acc2:<a1>");
    expect(threads.get("root-inbox")).toBe("lt:acc1:<root>");
  });

  it("looks up the subject on the account's mail of 30 days, by index", () => {
    const db = openDatabase(":memory:");
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT thread_id, subject FROM messages WHERE account_id = ? AND date_ms >= ? AND date_ms < ? AND thread_id LIKE 'lt:%'",
      )
      .all("acc1", 0, 1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain(
      "messages_account_date (account_id=? AND date_ms>? AND date_ms<?)",
    );
  });
});

describe("upgrade to schema 48 (ADR 0104)", () => {
  it("joins a chain of replies without ids into one thread, and the planner alone writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v47-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 47)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    const insert = old.prepare(`
      INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
                            from_json, to_json, cc_json, subject, snippet, flags, has_attachments,
                            change_seq, mailboxes)
      VALUES (?, 'acc1', ?, ?, ?, ?, ?, ?, '[]', ?, '', 0, 0, 0, ?)`);
    const ref = old.prepare(
      "INSERT INTO message_refs (key, account_id, ref_id) VALUES (?, 'acc1', ?)",
    );
    const BUILDER = '{"address":"builder@example.com"}';
    const ME = '{"address":"me@example.com"}';
    // id, thread, from, to, subject, Sent, what it points to
    const rows: [string, string, string, string, string, boolean, string | null][] = [
      ["root", "<root>", BUILDER, ME, "Floor quote", false, null],
      ["p1", "<root>", ME, BUILDER, "Re: Floor quote", true, "<root>"],
      ["c1", "<c1>", BUILDER, ME, "Re: Re: Floor quote", false, null],
      ["p2", "<c1>", ME, BUILDER, "Re: Re: Re: Floor quote", true, "<c1>"],
      ["c2", "<c2>", BUILDER, ME, "Re: Re: Floor quote", false, null],
      ["p3", "<c2>", ME, BUILDER, "Re: Floor quote", true, "<c2>"],
      ["c3", "<c3>", BUILDER, ME, "RE: Floor quote", false, null],
      ["s1", "<s1>", '{"address":"stranger@example.com"}', ME, "Re: Floor quote", false, null],
    ];
    rows.forEach(([id, root, from, to, subject, sent, points], i) => {
      insert.run(
        i + 1,
        id,
        `lt:acc1:${root}`,
        `<${id}>`,
        T0 + i * DAY,
        from,
        `[${to}]`,
        subject,
        sent ? 2 : 1,
      );
      if (points !== null) ref.run(i + 1, points);
    });
    old
      .prepare(
        "INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline, facts_json, stakes, confidence, analyzed_at_ms) VALUES ('lt:acc1:<root>', 1, 1, 'waiting', 'h', '[]', 'none', 1, 0)",
      )
      .run();
    old.close();

    const readOnly = new DatabaseSync(path, { readOnly: true });
    const before = threadsOf(readOnly);
    const plan = planSubjectJoins(readOnly);
    expect(plan).toEqual([
      { key: 3, from: "lt:acc1:<c1>", to: "lt:acc1:<root>" },
      { key: 5, from: "lt:acc1:<c2>", to: "lt:acc1:<root>" },
      { key: 7, from: "lt:acc1:<c3>", to: "lt:acc1:<root>" },
    ]);
    expect(threadsOf(readOnly)).toEqual(before);
    readOnly.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(48);
    const threads = threadsOf(db);
    for (const id of ["root", "p1", "c1", "p2", "c2", "p3", "c3"]) {
      expect(threads.get(id)).toBe("lt:acc1:<root>");
    }
    expect(threads.get("s1")).toBe("lt:acc1:<s1>");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_analyses").get()).toEqual({ n: 0 });
    expect(planSubjectJoins(db)).toEqual([]);
    db.close();
  });
});
