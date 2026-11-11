import { parseQuery } from "@matters/core";
import { makeMessage, person } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { openDatabase, SqliteMessageStore, SqliteSearchIndex } from "../src/index.ts";

// ADR 0081. What a ranked search says about who wrote each match, and the order in which the best
// `limit` messages are chosen: a flood of programs must not fill the window. Invented data.

const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;

async function mailbox() {
  const db = openDatabase(":memory:");
  const store = new SqliteMessageStore(db);
  const index = new SqliteSearchIndex(db);
  let n = 0;
  const add = async (spec: {
    thread: string;
    from: string;
    ageDays: number;
    subject: string;
    automated?: boolean;
    sent?: boolean;
    replyTo?: string;
    senderAuth?: "pass" | "fail";
  }) => {
    const message = makeMessage({
      providerId: `m${++n}`,
      threadId: spec.thread,
      dateMs: NOW - spec.ageDays * DAY,
      seq: n % 1024,
      from: person("Sender", spec.from),
      to: [person("Me", "me@home.test")],
      subject: spec.subject,
      ...(spec.automated === undefined ? {} : { automated: spec.automated }),
      ...(spec.replyTo === undefined ? {} : { replyTo: [person("On behalf", spec.replyTo)] }),
      ...(spec.senderAuth === undefined ? {} : { senderAuth: spec.senderAuth }),
    });
    const { keys } = await store.upsertMessages([message]);
    const key = keys[0] as number;
    if (spec.sent === true) db.prepare("UPDATE messages SET mailboxes = 2 WHERE key = ?").run(key);
    const stored = (await store.getByKeys([key]))[0] ?? message;
    await index.indexMessages([{ message: stored, bodyText: "" }]);
    return key;
  };
  return { db, index, add };
}

const q = (text: string) => parseQuery(text, { nowMs: NOW });

describe("who wrote the matches of a ranked search (ADR 0081)", () => {
  it("tells the sender, whether it is the person's own Sent mail, the headers' verdict and how many messages the sender has", async () => {
    const m = await mailbox();
    const a = await m.add({
      thread: "t1",
      from: "kim@partner.test",
      ageDays: 5,
      subject: "contract",
      automated: false,
    });
    const b = await m.add({
      thread: "t2",
      from: "bot@mailer.test",
      ageDays: 5,
      subject: "contract",
      automated: true,
    });
    const c = await m.add({ thread: "t3", from: "Who@Else.test", ageDays: 5, subject: "contract" });
    const d = await m.add({
      thread: "t1",
      from: "me@home.test",
      ageDays: 4,
      subject: "contract",
      sent: true,
    });
    await m.add({ thread: "t4", from: "who@else.test", ageDays: 90, subject: "other" });
    const found = await m.index.searchRanked(q("contract"), { limit: 10 });
    const by = new Map(found.map((x) => [x.messageKey, x]));
    expect(by.get(a)).toMatchObject({
      sender: "kim@partner.test",
      fromMe: false,
      automated: false,
    });
    expect(by.get(b)).toMatchObject({ sender: "bot@mailer.test", automated: true });
    expect(by.get(c)).toMatchObject({ sender: "who@else.test", fromMe: false, senderMessages: 2 });
    // Headers not known: the field is absent, not false.
    expect("automated" in (by.get(c) ?? {})).toBe(false);
    expect(by.get(d)).toMatchObject({ sender: "me@home.test", fromMe: true });
    m.db.close();
  });

  it("tells the Reply-To of relayed mail and the sender authentication, and leaves out a Reply-To equal to the sender", async () => {
    const m = await mailbox();
    const a = await m.add({
      thread: "t1",
      from: "dse@esign.test",
      ageDays: 5,
      subject: "contract",
      replyTo: "Kim@Client.test",
      senderAuth: "pass",
    });
    const b = await m.add({
      thread: "t2",
      from: "kim@client.test",
      ageDays: 5,
      subject: "contract",
      replyTo: "kim@client.test",
      senderAuth: "fail",
    });
    const found = await m.index.searchRanked(q("contract"), { limit: 10 });
    const by = new Map(found.map((x) => [x.messageKey, x]));
    expect(by.get(a)).toMatchObject({
      sender: "dse@esign.test",
      replyTo: "kim@client.test",
      senderAuth: "pass",
    });
    expect(by.get(b)?.replyTo).toBeUndefined();
    expect(by.get(b)?.senderAuth).toBe("fail");
    m.db.close();
  });

  it("chooses the window after sorting programs lower and the person's own mail higher", async () => {
    const m = await mailbox();
    // Ten programs whose subject is the whole query (the best bm25), one person with a long
    // subject, one reply of the person's own.
    for (let i = 0; i < 10; i++) {
      await m.add({
        thread: `bot-${i}`,
        from: "bot@mailer.test",
        ageDays: 3,
        subject: "contract",
        automated: true,
      });
    }
    await m.add({
      thread: "talk",
      from: "kim@partner.test",
      ageDays: 400,
      subject: "the signing of our contract next week",
      automated: false,
    });
    await m.add({
      thread: "mine",
      from: "me@home.test",
      ageDays: 300,
      subject: "re the contract draft and next steps",
      sent: true,
    });
    const plain = await m.index.searchRanked(q("contract"), { limit: 3 });
    expect(plain.every((x) => x.threadId.startsWith("bot-"))).toBe(true);
    const adjusted = await m.index.searchRanked(q("contract"), {
      limit: 3,
      automatedPenalty: 10,
      ownBoost: 6,
    });
    expect(new Set(adjusted.map((x) => x.threadId))).toContain("talk");
    expect(new Set(adjusted.map((x) => x.threadId))).toContain("mine");
    // `relevance` stays the plain bm25, so the caller weighs the same numbers.
    const bot = plain[0];
    expect(adjusted.find((x) => x.threadId === "talk")?.relevance).toBeGreaterThan(0);
    expect(bot?.relevance).toBeGreaterThan(0);
    m.db.close();
  });

  it("matches the stem of an inflected word as a prefix (the agent's words, ADR 0081)", async () => {
    const m = await mailbox();
    await m.add({
      thread: "t1",
      from: "kim@partner.test",
      ageDays: 5,
      subject: "Podpisanie umowy o pracę",
    });
    await m.add({ thread: "t2", from: "kim@partner.test", ageDays: 6, subject: "Umowy ramowe" });
    await m.add({ thread: "t3", from: "kim@partner.test", ageDays: 7, subject: "Obiad" });
    const { stemQuery } = await import("@matters/core");
    const found = await m.index.searchRanked(stemQuery(q("umowa")), { limit: 10 });
    expect(new Set(found.map((x) => x.threadId))).toEqual(new Set(["t1", "t2"]));
    // The person's own search keeps its words whole: `umowa` is not `umowy`.
    const plain = await m.index.searchRanked(q("umowa"), { limit: 10 });
    expect(plain).toHaveLength(0);
    m.db.close();
  });
});
