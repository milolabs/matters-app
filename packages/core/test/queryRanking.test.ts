import { describe, expect, it } from "vitest";
import type { QueryRanking, RankedMessage, WrittenTo } from "../src/index.ts";
import {
  asksForSender,
  BULK_PENALTY,
  companiesWrittenTo,
  effectiveSender,
  messageKey,
  parseQuery,
  RECENCY_WEIGHT,
  RECENCY_WEIGHT_ANY,
  RELATIONSHIP_BOOST,
  rankQueryThreads,
  SENDER_CAP_PER_QUERY,
} from "../src/index.ts";

// ADR 0081. Everything here is invented. Senders are at distinct second-level domains of the
// reserved .test domain: a company is the last two labels of a domain (`companyOf`).

const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;

let seq = 0;
const msg = (
  threadId: string,
  ageDays: number,
  relevance: number,
  over: Partial<RankedMessage> = {},
): RankedMessage => ({
  messageKey: messageKey(NOW - ageDays * DAY, ++seq % 1000),
  threadId,
  accountId: "acc1",
  relevance,
  via: "text",
  ...over,
});

const written = (...addresses: string[]): Map<string, WrittenTo> =>
  new Map(addresses.map((a) => [a, { sent: 3, lastMs: NOW - 30 * DAY }]));

const ctx = (over: Partial<QueryRanking> = {}): QueryRanking => ({
  nowMs: NOW,
  time: "recent",
  own: new Set(["me@home.test"]),
  writtenAddresses: new Map(),
  writtenCompanies: new Map(),
  capSenders: true,
  ...over,
});

describe("flood control inside one query (ADR 0081)", () => {
  // One bulk sender with 50 matching newsletters, headers unknown, never written to, many messages
  // in the mailbox; against one conversation the person took part in.
  const newsletters = Array.from({ length: 50 }, (_, i) =>
    msg(`news-${i}`, 2 + i, 22, { sender: "digest@newsmail.test", senderMessages: 900 }),
  );
  const conversation = [
    msg("talk", 400, 15, { sender: "kim@partner.test", senderMessages: 12 }),
    msg("talk", 399, 13, { sender: "me@home.test", fromMe: true }),
    msg("talk", 398, 14, { sender: "kim@partner.test", senderMessages: 12 }),
  ];

  it("puts the conversation the person took part in in the top 3, ahead of a flood that scores higher on relevance", () => {
    const ranked = rankQueryThreads([...newsletters, ...conversation], ctx());
    expect(ranked.slice(0, 3).map((t) => t.threadId)).toContain("talk");
    // Without flood control the 50 newsletters, each at relevance 22, would all come first.
    const plain = [...newsletters, ...conversation]
      .map((m) => ({ id: m.threadId, r: m.relevance }))
      .sort((a, b) => b.r - a.r);
    expect(plain[0]?.id.startsWith("news-")).toBe(true);
  });

  it("lets one sender put at most the cap of its threads ahead of the rest, and keeps the others behind", () => {
    const ranked = rankQueryThreads([...newsletters, ...conversation], ctx({ limit: 60 }));
    const heads = ranked.slice(0, 3).filter((t) => t.threadId.startsWith("news-"));
    expect(heads.length).toBeLessThanOrEqual(SENDER_CAP_PER_QUERY);
    // Nothing is lost when there is room: the rest of the newsletters follow.
    expect(ranked).toHaveLength(51);
    expect(ranked[ranked.length - 1]?.threadId.startsWith("news-")).toBe(true);
  });

  it("cuts to the limit after the cap, so a flood does not fill the list", () => {
    const others = Array.from({ length: 12 }, (_, i) =>
      msg(`other-${i}`, 30, 10 + i * 0.1, {
        sender: `p${i}@s${i}-corp.test`,
        automated: false,
      }),
    );
    const ranked = rankQueryThreads([...newsletters, ...others], ctx({ limit: 14 }));
    const fromBulk = ranked.filter((t) => t.threadId.startsWith("news-"));
    expect(fromBulk.length).toBeLessThanOrEqual(2);
    expect(ranked.filter((t) => t.threadId.startsWith("other-"))).toHaveLength(12);
  });

  it("does not cap when the query asks for one sender by name", () => {
    const ranked = rankQueryThreads(newsletters, ctx({ capSenders: false, limit: 40 }));
    expect(ranked).toHaveLength(40);
    expect(asksForSender(parseQuery("from:digest invoice", { nowMs: NOW }).root)).toBe(true);
    expect(asksForSender(parseQuery("-from:digest invoice", { nowMs: NOW }).root)).toBe(false);
    expect(asksForSender(parseQuery("to:digest invoice", { nowMs: NOW }).root)).toBe(false);
  });

  it("takes the whole penalty off a thread that headers call automated, and spares one they call personal", () => {
    const ranked = rankQueryThreads(
      [
        msg("program", 10, 20, { sender: "noreply@a-corp.test", automated: true }),
        msg("person", 10, 20, { sender: "ola@b-corp.test", automated: false }),
        msg("unknown", 10, 20, { sender: "x@c-corp.test" }),
      ],
      ctx(),
    );
    const score = (id: string) => ranked.find((t) => t.threadId === id)?.score as number;
    expect(score("person") - score("program")).toBeCloseTo(BULK_PENALTY, 6);
    // Unknown headers and a sender nobody knows is only a stranger: a mild penalty.
    expect(score("unknown")).toBeLessThan(score("person"));
    expect(score("unknown")).toBeGreaterThan(score("program"));
  });

  it("treats unknown headers from a sender of many messages, never written to, as bulk", () => {
    const ranked = rankQueryThreads(
      [
        msg("many", 10, 20, { sender: "a@a-corp.test", senderMessages: 400 }),
        msg("few", 10, 20, { sender: "b@b-corp.test", senderMessages: 1 }),
      ],
      ctx(),
    );
    expect(ranked[0]?.threadId).toBe("few");
  });
});

describe("relationship (ADR 0081)", () => {
  it("boosts a thread whose sender the person has written to", () => {
    const ranked = rankQueryThreads(
      [
        msg("stranger", 10, 20, { sender: "a@a-corp.test", automated: false }),
        msg("friend", 10, 20, { sender: "b@b-corp.test", automated: false }),
      ],
      ctx({ writtenAddresses: written("b@b-corp.test") }),
    );
    expect(ranked.map((t) => t.threadId)).toEqual(["friend", "stranger"]);
    expect((ranked[0]?.score as number) - (ranked[1]?.score as number)).toBeCloseTo(
      RELATIONSHIP_BOOST,
      6,
    );
  });

  it("boosts by company at half the weight, but not for programs", () => {
    const sent = written("hr@corp.test");
    const ranked = rankQueryThreads(
      [
        msg("same-company", 10, 20, { sender: "other@corp.test", automated: false }),
        msg("stranger", 10, 20, { sender: "z@z-corp.test", automated: false }),
        msg("program", 10, 20, { sender: "bot@corp.test", automated: true }),
      ],
      ctx({ writtenAddresses: sent, writtenCompanies: companiesWrittenTo(sent) }),
    );
    const score = (id: string) => ranked.find((t) => t.threadId === id)?.score as number;
    expect(score("same-company") - score("stranger")).toBeCloseTo(RELATIONSHIP_BOOST / 2, 6);
    expect(score("program")).toBeLessThan(score("stranger"));
  });

  it("counts the person's own words on the topic, and a thread they wrote in, as a relationship", () => {
    const ranked = rankQueryThreads(
      [
        msg("theirs", 10, 20, { sender: "a@a-corp.test", automated: false }),
        msg("mine", 10, 20, { sender: "me@home.test", fromMe: true }),
        msg("mixed", 10, 20, { sender: "c@c-corp.test" }),
        msg("mixed", 9, 5, { sender: "me@home.test" }),
      ],
      ctx(),
    );
    expect(
      ranked
        .slice(0, 2)
        .map((t) => t.threadId)
        .sort(),
    ).toEqual(["mine", "mixed"]);
  });

  it("scores a conversation above a single line of the same relevance", () => {
    const ranked = rankQueryThreads(
      [
        msg("line", 10, 20, { sender: "a@a-corp.test", automated: false }),
        ...Array.from({ length: 8 }, () =>
          msg("long", 10, 20, { sender: "b@b-corp.test", automated: false }),
        ),
      ],
      ctx(),
    );
    expect(ranked[0]?.threadId).toBe("long");
  });
});

describe("time (ADR 0081)", () => {
  // A conversation from years ago that answers the question, against a recent weaker match.
  const old = msg("old-conversation", 6 * 365, 20, {
    sender: "kim@partner.test",
    automated: false,
  });
  const recent = msg("recent", 3, 19, { sender: "lee@other.test", automated: false });

  it("weighs age for a question about what is recent", () => {
    const ranked = rankQueryThreads([old, recent], ctx({ time: "recent" }));
    expect(ranked[0]?.threadId).toBe("recent");
    expect(RECENCY_WEIGHT).toBeGreaterThan(RECENCY_WEIGHT_ANY);
  });

  it("lets a match from years ago win when the question is about the whole history", () => {
    const ranked = rankQueryThreads([old, recent], ctx({ time: "any" }));
    expect(ranked[0]?.threadId).toBe("old-conversation");
  });
});

describe("a ranking without sender facts (an adapter that does not know)", () => {
  it("scores by relevance and age alone, without a cap or a crash", () => {
    const ranked = rankQueryThreads(
      [msg("a", 1, 5), msg("b", 1, 9), msg("c", 1, 7)],
      ctx({ limit: 2 }),
    );
    expect(ranked.map((t) => t.threadId)).toEqual(["b", "c"]);
  });
});

describe("mail relayed by a service on behalf of a person (ADR 0081)", () => {
  const sent = written("kim@client.test");
  const w = { addresses: sent, companies: companiesWrittenTo(sent) };

  it("uses the Reply-To address when the person wrote to it or its company, or it is another company", () => {
    expect(effectiveSender("dse@esign.test", "kim@client.test", "pass", w)).toBe("kim@client.test");
    expect(effectiveSender("dse@esign.test", "lee@client.test", "pass", w)).toBe("lee@client.test");
    // Never written to, but at another company than the service: the sender is that person.
    expect(effectiveSender("dse@esign.test", "zed@cold.test", "unknown", w)).toBe("zed@cold.test");
  });

  it("keeps From when Reply-To is absent, the same, at the same company unrelated to the person, or authentication failed", () => {
    expect(effectiveSender("dse@esign.test", undefined, "pass", w)).toBe("dse@esign.test");
    expect(effectiveSender("dse@esign.test", "DSE@esign.test", "pass", w)).toBe("dse@esign.test");
    expect(effectiveSender("a@esign.test", "b@esign.test", "pass", w)).toBe("a@esign.test");
    expect(effectiveSender("dse@esign.test", "kim@client.test", "fail", w)).toBe("dse@esign.test");
  });

  const envelope = (
    thread: string,
    replyTo: string | undefined,
    over: Partial<RankedMessage> = {},
  ) =>
    msg(thread, 20, 20, {
      sender: "dse@esign.test",
      ...(replyTo === undefined ? {} : { replyTo }),
      senderAuth: "pass",
      ...over,
    });

  it("treats an envelope sent for a person the person wrote to as a relationship, and a cold one as a stranger", () => {
    const ranked = rankQueryThreads(
      [envelope("cold", "zed@cold.test"), envelope("known", "kim@client.test")],
      ctx({ writtenAddresses: sent, writtenCompanies: companiesWrittenTo(sent) }),
    );
    const score = (id: string) => ranked.find((t) => t.threadId === id)?.score as number;
    expect(ranked[0]?.threadId).toBe("known");
    expect(score("known") - score("cold")).toBeGreaterThan(RELATIONSHIP_BOOST);
  });

  it("does not raise an envelope whose authentication failed", () => {
    const ranked = rankQueryThreads(
      [envelope("forged", "kim@client.test", { senderAuth: "fail" }), envelope("plain", undefined)],
      ctx({ writtenAddresses: sent, writtenCompanies: companiesWrittenTo(sent) }),
    );
    const score = (id: string) => ranked.find((t) => t.threadId === id)?.score as number;
    expect(score("forged")).toBeCloseTo(score("plain"), 6);
  });

  it("caps by the person it was sent for, not by the service", () => {
    const people = ["a", "b", "c", "d", "e"].map((x) => envelope(`e-${x}`, `${x}@${x}-corp.test`));
    const ranked = rankQueryThreads(people, ctx({ limit: 5 }));
    // Five envelopes from one service for five different companies: none is pushed behind the cap.
    expect(ranked.map((t) => t.threadId).sort()).toEqual(people.map((p) => p.threadId).sort());
    const same = ["a", "b", "c", "d", "e"].map((x) => envelope(`s-${x}`, `${x}@esign.test`));
    // Reply-To at the service itself: the service stays the sender and the cap holds.
    const flood = rankQueryThreads(
      [...same, msg("human", 400, 5, { sender: "x@y-corp.test", automated: false })],
      ctx(),
    );
    expect(flood.slice(0, 3).filter((t) => t.threadId.startsWith("s-")).length).toBeLessThanOrEqual(
      2,
    );
  });
});
