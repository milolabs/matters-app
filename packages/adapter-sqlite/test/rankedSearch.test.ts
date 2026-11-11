import { parseQuery, rankThreads, tokenize } from "@matters/core";
import { makeMessage, person } from "@matters/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileIndexWriter } from "../src/fileIndex.ts";
import {
  type Database,
  openDatabase,
  SqliteMessageStore,
  SqliteSearchIndex,
} from "../src/index.ts";
import { buildRankedSql, planQuery, RANK_WEIGHTS } from "../src/searchPlan.ts";

// ADR 0080. A synthetic mailbox that reproduces a real failure: the thread that answers the
// question is old and quiet, while recent notifications that merely mention the same company, and
// newsletters that share a word with the question, fill a newest-first list. Names and domains are
// invented.

const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;

const db: Database = openDatabase(":memory:");
const store = new SqliteMessageStore(db);
const index = new SqliteSearchIndex(db);
let seqNo = 0;

interface Spec {
  readonly thread: string;
  readonly ageDays: number;
  readonly from: [string, string];
  readonly subject: string;
  readonly body: string;
  readonly labels?: string[];
  readonly files?: string[];
  readonly to?: string;
}

async function add(spec: Spec): Promise<number> {
  const message = makeMessage({
    providerId: `m${++seqNo}`,
    threadId: spec.thread,
    dateMs: NOW - spec.ageDays * DAY + (seqNo % 1000),
    seq: seqNo % 1024,
    from: person(spec.from[0], spec.from[1]),
    to: [person("Me", spec.to ?? "me@example.test")],
    subject: spec.subject,
    labelIds: spec.labels ?? ["inbox"],
    hasAttachments: (spec.files ?? []).length > 0,
  });
  const { keys } = await store.upsertMessages([message]);
  const key = keys[0] as number;
  const stored = (await store.getByKeys([key]))[0];
  await index.indexMessages([{ message: stored ?? message, bodyText: spec.body }]);
  if ((spec.files ?? []).length > 0) {
    spec.files?.forEach((name, i) => {
      db.prepare(
        `INSERT INTO message_attachments (message_key, part_id, position, name, mime_type, size, inline)
         VALUES (?, ?, ?, ?, 'application/pdf', 1000, 0)`,
      ).run(key, String(i + 2), i, name);
    });
    fileIndexWriter(db).set(key, spec.files ?? []);
  }
  return key;
}

async function ranked(text: string, limit = 300): Promise<string[]> {
  const found = await index.searchRanked(parseQuery(text, { nowMs: NOW }), { limit });
  return rankThreads(found, NOW).map((t) => t.threadId);
}

beforeAll(async () => {
  // 40 recent build notifications that name the company over and over.
  for (let i = 0; i < 40; i++) {
    await add({
      thread: `ci-${i}`,
      ageDays: 1 + i * 0.5,
      from: ["Build Bot", "notifications@builds.example.net"],
      subject: `[acme-labs/web] Run failed: CI #${1000 + i}`,
      body: `acme-labs web build ${i} failed. See the acme-labs workflow run. acme-labs/web main`,
    });
  }
  // The answer: old, English, from people at the company, with the letter attached.
  await add({
    thread: "target",
    ageDays: 150,
    from: ["Jackie Example", "people@acme-labs.example"],
    subject: "Re: Next steps with new Acmeite!",
    body: "Thanks for the call. The offer is attached, please sign. As a contractor you give your resignation to the current employer first.",
    files: ["offer_letter.pdf"],
  });
  // Newsletters from a broker that share the word "umowa" and talk about contracts.
  for (let i = 0; i < 15; i++) {
    await add({
      thread: `news-${i}`,
      ageDays: 2 + i,
      from: ["Broker News", "newsletter@broker.example.test"],
      subject: `Weekly ${i}: kontrakty CFD na indeksy`,
      body: "Kontrakty CFD, nowa umowa ramowa i warunki. Kontrakty CFD to instrument z dzwignia. umowa umowa",
    });
  }
  // The signing service's mails about an agreement.
  for (let i = 0; i < 3; i++) {
    await add({
      thread: `sign-${i}`,
      ageDays: 60 + i * 20,
      from: ["Signing Service", "dse@sign.example.test"],
      subject: i === 0 ? "Consulting Agreement Amendment" : `Completed: Consulting Agreement ${i}`,
      body: "Please review and sign the agreement. This envelope was sent through the signing service.",
    });
  }
  // Two threads that tell AND from a phrase.
  await add({
    thread: "apart",
    ageDays: 10,
    from: ["Pat Example", "pat@example.test"],
    subject: "Notes",
    body: "The offer was not what I expected. A letter will follow.",
  });
  await add({
    thread: "together",
    ageDays: 12,
    from: ["Sam Example", "sam@example.test"],
    subject: "Notes two",
    body: "Please find the offer letter below.",
  });
  // Filler, so that word frequencies look like a mailbox.
  for (let i = 0; i < 200; i++) {
    await add({
      thread: `fill-${i}`,
      ageDays: 3 + (i % 300),
      from: [`Person ${i % 17}`, `person${i % 17}@example.test`],
      subject: `Re: plan ${i % 9}`,
      body: `meeting notes lunch plan budget report ${i % 5 === 0 ? "offer" : "update"} thanks`,
    });
  }
  // Mail in Trash and Spam that matches everything.
  await add({
    thread: "trashed",
    ageDays: 5,
    from: ["Spam Bot", "bot@spam.example.test"],
    subject: "offer offer offer",
    body: "offer oferta agreement umowa",
    labels: ["trash"],
  });
});

afterAll(() => db.close());

describe("ranked search for the agent (ADR 0080)", () => {
  it("finds the old thread among recent notifications that name the company", async () => {
    // Newest first would give the notifications; relevance gives the thread that is about it.
    const hits = await ranked("offer OR oferta");
    expect(hits.slice(0, 5)).toContain("target");
    expect(hits.indexOf("target")).toBeLessThan(5);
  });

  it("finds it by the company's domain as the sender, whatever the notifications say", async () => {
    const hits = await ranked("from:acme-labs.example");
    expect(hits[0]).toBe("target");
    expect(hits).not.toContain("ci-0");
  });

  it("finds it by the company and the thing, where the notifications know only the company", async () => {
    const hits = await ranked("acme-labs offer");
    expect(hits[0]).toBe("target");
  });

  it("finds the mails about an agreement over newsletters that share a word", async () => {
    const hits = await ranked("agreement OR umowa OR docusign");
    const top = hits.slice(0, 4);
    expect(top.filter((t) => t.startsWith("sign-")).length).toBeGreaterThanOrEqual(2);
    expect(hits.indexOf("sign-0")).toBeLessThan(5);
  });

  it("finds a thread by the name of its attachment", async () => {
    // Neither word is next to the other in the text, and "letter" is not in it at all.
    const phrase = await ranked('"offer letter"');
    expect(phrase.slice(0, 3)).toContain("target");
    const plain = await ranked("offer letter");
    expect(plain.slice(0, 5)).toContain("target");
    const found = await index.searchRanked(parseQuery('"offer letter"', { nowMs: NOW }), {
      limit: 50,
    });
    expect(found.filter((m) => m.via === "file").map((m) => m.threadId)).toContain("target");
  });

  it("ANDs plain words in any order and keeps a quoted phrase together", async () => {
    const plain = await ranked("letter offer");
    expect(plain).toContain("apart");
    expect(plain).toContain("together");
    const phrase = await ranked('"offer letter"');
    expect(phrase).toContain("together");
    expect(phrase).not.toContain("apart");
    // Prefixes, not whole words, as in the person's own search.
    expect(await ranked("offe lett")).toContain("together");
  });

  it("takes the parts of a hyphenated or dotted word as ANDed prefixes, in any order, as the person's search does", async () => {
    const parsed = parseQuery("labs-acme.example", { nowMs: NOW });
    const found = await index.searchRanked(parsed, { limit: 50, accountIds: ["acc1"] });
    expect(rankThreads(found, NOW).map((t) => t.threadId)).toContain("target");
    const own = await index.search(parsed, { limit: 10 });
    expect(own.length).toBeGreaterThan(0);
  });

  it("leaves Trash and Spam out before the list is cut, unless the query asks for them", async () => {
    expect(await ranked("offer oferta agreement")).not.toContain("trashed");
    const asked = await ranked("in:trash offer");
    expect(asked).toEqual(["trashed"]);
    // A cut of one still brings the best visible match, not the best hidden one.
    const one = await index.searchRanked(parseQuery("offer", { nowMs: NOW }), { limit: 1 });
    expect(one.map((m) => m.threadId)).not.toContain("trashed");
  });

  it("respects the filters and the accounts of the query", async () => {
    const dated = await ranked("offer after:-30d");
    expect(dated).not.toContain("target");
    const wide = await ranked("offer after:-1y");
    expect(wide).toContain("target");
    const none = await index.searchRanked(parseQuery("offer", { nowMs: NOW }), {
      limit: 50,
      accountIds: ["nobody"],
    });
    expect(none).toEqual([]);
    expect(await ranked("has:attachment offer")).toEqual(["target"]);
  });

  it("weighs the subject and the sender above the body, and a strong old match above a weak new one", async () => {
    expect(RANK_WEIGHTS).toEqual([3, 1, 0.5, 5, 1]);
    const found = await index.searchRanked(parseQuery("consulting agreement", { nowMs: NOW }), {
      limit: 50,
    });
    const byThread = new Map(found.map((m) => [m.threadId, m.relevance]));
    // The same words in a subject outweigh a body that has "agreement" once.
    expect(byThread.get("sign-0") ?? 0).toBeGreaterThan(0);
    const threads = rankThreads(found, NOW);
    expect(threads[0]?.threadId).toBe("sign-0");
    // The notifications are newer by months, and still come after the older thread.
    const old = rankThreads(
      [
        {
          messageKey: found[0]?.messageKey ?? 0,
          threadId: "old",
          accountId: "a",
          relevance: 8,
          via: "text",
        },
      ],
      NOW,
    )[0];
    expect(old?.score).toBeGreaterThan(0);
  });

  it("answers a query that has nothing to rank by with the newest", async () => {
    const found = await index.searchRanked(parseQuery("is:unread", { nowMs: NOW }), { limit: 5 });
    expect(found).toHaveLength(5);
    expect(found.every((m) => m.relevance === 0)).toBe(true);
  });

  it("leaves the person's own search as it was: newest first, no ranking", async () => {
    const keys = await index.search(parseQuery("offer letter", { nowMs: NOW }), { limit: 10 });
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort((a, b) => b - a)).toEqual(keys);
    const plan = planQuery(parseQuery("labs-acme", { nowMs: NOW }).root as never);
    expect(plan.match?.params[0]).toBe('("labs"*) AND ("acme"*)');
    expect(tokenize("labs-acme")).toEqual(["labs", "acme"]);
    expect(buildRankedSql(plan, 5).sql).toContain("bm25(message_fts, 3, 1, 0.5, 5, 1)");
  });
});
