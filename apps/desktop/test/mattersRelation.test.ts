// ADR 0066, rule 3, and ADR 0068: what the list reads from the person's own Sent mail, by address,
// by person and by company, and what it costs. The stores are hand-made so that every read can be
// counted.
import type { AgentRule, Message, ThingFeedback, ThreadAnalysis, WrittenTo } from "@matters/core";
import { messageKey } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  type AgentReadDeps,
  RECEIVED_LIMIT,
  rankedThings,
  SENT_SUBJECTS_LIMIT,
  senderHistory,
} from "../src/backend/agentReads.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 12);
const ME = "me@example.com";

interface Thread {
  readonly from: string;
  readonly name?: string;
  readonly subject?: string;
  readonly dateMs?: number;
  readonly senderAuth?: "pass" | "fail" | "unknown";
}

interface Options {
  readonly subjects?: Record<string, readonly string[]>;
  /** Thread ids of mail received, by company or address. */
  readonly received?: Record<string, readonly string[]>;
  readonly feedback?: readonly ThingFeedback[];
  readonly rules?: readonly AgentRule[];
}

function setup(
  analyses: readonly ThreadAnalysis[],
  threads: Record<string, Thread>,
  sent: Record<string, WrittenTo>,
  options: Options = {},
) {
  // How often each kind of mail was walked, and from when: once a list at most (ADR 0070, rule 1).
  const asked: true[] = [];
  const receivedAsked: number[] = [];
  let writtenReads = 0;
  const messageOf = (id: string, key: number, t: Thread): Message =>
    ({
      key,
      accountId: "acc1",
      providerId: id,
      threadId: id,
      messageIdHeader: `<${id}>`,
      dateMs: t.dateMs ?? NOW - DAY,
      from: { address: t.from, ...(t.name === undefined ? {} : { name: t.name }) },
      to: [{ address: ME }],
      cc: [],
      subject: t.subject ?? `About ${id}`,
      snippet: "",
      flags: { seen: false, flagged: false, answered: false, draft: false },
      labelIds: ["inbox"],
      hasAttachments: false,
      senderAuth: t.senderAuth ?? "unknown",
    }) as Message;
  const deps = {
    settings: {
      get: async () => ({ enabled: true, runtimeId: "fake" }),
      listConsents: async () => [{ accountId: "acc1", runtimeId: "fake" }],
    },
    accounts: { list: async () => [{ address: ME }] },
    insights: {
      listAnalyses: async () => analyses,
      listFeedback: async () => options.feedback ?? [],
      listRules: async () => options.rules ?? [],
      getPrepared: async () => null,
      getBundleRead: async () => null,
    },
    store: {
      getThread: async (id: string) => {
        const t = threads[id];
        if (t === undefined) return null;
        const key = analyses.find((a) => a.threadId === id)?.lastMessageKey ?? 1;
        return {
          thread: {
            accountId: "acc1",
            lastMessageKey: key,
            subject: t.subject ?? `About ${id}`,
          },
          messages: [messageOf(id, key, t)],
        };
      },
      listWrittenTo: async () => {
        writtenReads++;
        return new Map(Object.entries(sent));
      },
      listSentMail: async () => {
        asked.push(true);
        return Object.entries(options.subjects ?? {}).flatMap(([to, subjects]) =>
          subjects.map((subject) => ({
            subject,
            recipients: [to.includes("@") ? to : `someone@${to}`],
          })),
        );
      },
      listReceivedMail: async (sinceMs: number) => {
        receivedAsked.push(sinceMs);
        return Object.entries(options.received ?? {}).flatMap(([from, threadIds]) =>
          threadIds.map((threadId) => ({
            key: messageKey(NOW, 0),
            threadId,
            from: from.includes("@") ? from : `someone@${from}`,
          })),
        );
      },
      listThreadsSince: async () => [],
    },
  } as unknown as AgentReadDeps;
  return { deps, asked, receivedAsked, reads: () => writtenReads };
}

const ev = (quote: string, messageKey: number) => ({ quote, messageKey });

const owes = (id: string, key = 1, over: Partial<ThreadAnalysis> = {}): ThreadAnalysis => ({
  threadId: id,
  lastMessageKey: key,
  analyzerVersion: 4,
  state: "onYou",
  headline: id,
  facts: [{ kind: "ask", who: "you", evidence: ev("Please send it", key) }],
  stakes: "none",
  confidence: 0.9,
  analyzedAtMs: NOW,
  status: "open",
  ...over,
});

const offer = (id: string, key = 1, over: Partial<ThreadAnalysis> = {}): ThreadAnalysis => ({
  threadId: id,
  lastMessageKey: key,
  analyzerVersion: 4,
  state: "fyi",
  headline: id,
  facts: [],
  stakes: "none",
  confidence: 0.9,
  analyzedAtMs: NOW,
  status: "open",
  intent: "decide",
  intentEvidence: ev("We propose a package", key),
  caseName: "Rozliczenie IP Box 2026",
  anchors: [],
  ...over,
});

const scoreOf = async (deps: AgentReadDeps, id: string) =>
  (await rankedThings(deps, NOW)).ranked.find((r) => r.thing.threadId === id)?.thing;

describe("interaction by address, person and company in the list (ADR 0068, rule 2)", () => {
  const sent = {
    "anna@northwind.example": { sent: 2, lastMs: NOW - 30 * DAY, name: "Anna Kowalska" },
    "friend@gmail.com": { sent: 9, lastMs: NOW - 2 * DAY },
  };

  it("counts the same address most, a new person at the company least, and a stranger nothing", async () => {
    const a = [owes("known", 1), owes("colleague", 2), owes("stranger", 3)];
    const { deps } = setup(
      a,
      {
        known: { from: "Anna@northwind.example" },
        colleague: { from: "new@mail.northwind.example" },
        stranger: { from: "eve@elsewhere.example" },
      },
      sent,
    );
    const known = await scoreOf(deps, "known");
    const colleague = await scoreOf(deps, "colleague");
    const stranger = await scoreOf(deps, "stranger");
    // Thirty days ago: 30 * 0.5^(30/180) is 27 at the address, 12 * 0.5^(30/180) is 11 at the company.
    expect(known?.score).toBe((stranger?.score ?? 0) + 15 + 27);
    expect(colleague?.score).toBe((stranger?.score ?? 0) + 15 + 11);
    expect(known?.why).toContain("You last wrote to them 30 days ago.");
    expect(colleague?.why).toContain("You last wrote to this company 30 days ago.");
    expect(colleague?.why).not.toContain("never written");
    expect(stranger?.why).toContain("You have never written to them.");
  });

  it("knows the same person at another address by a name of two words, with a margin of error", async () => {
    const { deps } = setup(
      [owes("same", 1), owes("other", 2)],
      {
        same: { from: "anna.k@private.example", name: "ANNA Kowalska" },
        other: { from: "anna@private.example", name: "Anna" },
      },
      sent,
    );
    const same = await scoreOf(deps, "same");
    const other = await scoreOf(deps, "other");
    expect(same?.why).toContain(
      "You last wrote to what looks like the same person at another address 30 days ago.",
    );
    // 24 * 0.5^(30/180) is 21.
    expect((same?.score ?? 0) - (other?.score ?? 0)).toBe(15 + 21);
    expect(other?.why).toContain("never written");
  });

  it("does not take a role for a person: a name of role words matches nothing", async () => {
    const roles = {
      "biuro@northwind.example": { sent: 3, lastMs: NOW - DAY, name: "Biuro Obsługi" },
      "help@northwind.example": { sent: 3, lastMs: NOW - DAY, name: "Customer Service" },
    };
    const { deps } = setup(
      [owes("a", 1), owes("b", 2)],
      {
        a: { from: "x@elsewhere.example", name: "Biuro Obsługi" },
        b: { from: "y@other.example", name: "Customer Service" },
      },
      roles,
    );
    for (const id of ["a", "b"]) {
      expect((await scoreOf(deps, id))?.why, id).toContain("You have never written to them.");
    }
  });

  it("gives nothing for a relation of three years, and does not call it a stranger", async () => {
    const old = { "anna@northwind.example": { sent: 2, lastMs: NOW - 3 * 365 * DAY } };
    const { deps } = setup(
      [owes("colleague", 1), owes("far", 2)],
      { colleague: { from: "new@northwind.example" }, far: { from: "eve@elsewhere.example" } },
      old,
    );
    const colleague = await scoreOf(deps, "colleague");
    const far = await scoreOf(deps, "far");
    expect(colleague?.score).toBe((far?.score ?? 0) + 15);
    expect(colleague?.why).toContain("You last wrote to this company 3 years ago.");
    expect(colleague?.why).not.toContain("never");
  });

  it("does not make a company of a shared mail domain", async () => {
    const { deps } = setup(
      [owes("other", 1)],
      { other: { from: "someone@gmail.com" } },
      { "friend@gmail.com": { sent: 9, lastMs: NOW - DAY } },
    );
    expect((await scoreOf(deps, "other"))?.why).toContain("You have never written to them.");
  });

  it("reads Sent mail once for a list, whatever the number of things", async () => {
    const { deps, reads } = setup(
      [owes("a", 1), owes("b", 2)],
      { a: { from: "x@northwind.example" }, b: { from: "y@northwind.example" } },
      sent,
    );
    await rankedThings(deps, NOW);
    await rankedThings(deps, NOW);
    expect(reads()).toBe(1);
  });
});

describe("sharing a topic with what the person wrote, at list-read time (ADR 0066, rule 3)", () => {
  const subjects = {
    "northwind.example": ["Re: interpretacja indywidualna ip box", "Zapytanie o termin"],
  };
  const wroteThere = { "anna@northwind.example": { sent: 1, lastMs: NOW - 90 * DAY } };

  it("lets a decision in when the person's mail to that company shares its topic", async () => {
    const { deps, asked } = setup(
      [offer("t1")],
      { t1: { from: "sales@northwind.example" } },
      wroteThere,
      { subjects },
    );
    const t = await scoreOf(deps, "t1");
    expect(t?.why).toBe(
      "You can take this or leave it. You wrote to them about this before. You last wrote to this company 3 months ago.",
    );
    expect(asked).toHaveLength(1);
    expect(SENT_SUBJECTS_LIMIT).toBe(200);
    expect(RECEIVED_LIMIT).toBe(100);
  });

  it("matches on the thread's subject when the reading gave no name and no anchors", async () => {
    const bare = offer("t1", 1);
    delete (bare as { caseName?: string }).caseName;
    const { deps, asked } = setup(
      [bare],
      { t1: { from: "sales@northwind.example", subject: "Oferta: rozliczenie IP Box" } },
      wroteThere,
      { subjects },
    );
    expect(await scoreOf(deps, "t1")).toBeDefined();
    expect(asked).toHaveLength(1);
  });

  it("keeps out a decision whose company the person never wrote about it to, and asks once per company", async () => {
    const { deps, asked } = setup(
      [offer("t1", 1), offer("t2", 2, { caseName: "Oferta hostingu" })],
      { t1: { from: "sales@northwind.example" }, t2: { from: "other@northwind.example" } },
      wroteThere,
      { subjects: { "northwind.example": ["Zapytanie o termin"] } },
    );
    expect((await rankedThings(deps, NOW)).ranked).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("asks nothing for a reading that is personal by its own passage, or that is not an offer or news", async () => {
    const personal = offer("t1", 1, { forYouEvidence: ev("your 2025 return", 1) });
    const { deps, asked } = setup(
      [personal, owes("t3", 3)],
      { t1: { from: "a@northwind.example" }, t3: { from: "c@northwind.example" } },
      { "anna@northwind.example": { sent: 1, lastMs: NOW - DAY } },
      { subjects },
    );
    const list = (await rankedThings(deps, NOW)).ranked.map((r) => r.thing.threadId);
    expect(list.sort()).toEqual(["t1", "t3"]);
    expect(asked).toEqual([]);
  });

  it("asks by address for a sender at a shared mail domain", async () => {
    const { deps } = setup(
      [offer("t1")],
      { t1: { from: "Ola@gmail.com" } },
      { "ola@gmail.com": { sent: 1, lastMs: NOW - DAY } },
      { subjects: { "ola@gmail.com": ["Ip box - pytanie"] } },
    );
    expect(await scoreOf(deps, "t1")).toBeDefined();
  });
});

describe("mail that is never answered, at list-read time (ADR 0068, rule 6)", () => {
  const personal = (id: string, key: number, over: Partial<ThreadAnalysis> = {}) =>
    offer(id, key, { forYouEvidence: ev("your 2025 return", key), ...over });
  const ids = (n: number, not: string) => Array.from({ length: n }, (_, i) => `m${i}-${not}`);

  it("counts the messages since the last one the person sent there, but not this thread's own", async () => {
    const long = ids(19, "t1");
    const { deps, receivedAsked } = setup(
      [personal("t1", 1)],
      { t1: { from: "sales@northwind.example" } },
      { "anna@northwind.example": { sent: 2, lastMs: NOW - 3 * 365 * DAY } },
      { received: { "northwind.example": [...long, "t1"] } },
    );
    const t = await scoreOf(deps, "t1");
    expect(t?.why).toContain("They have sent 19 messages since you last wrote.");
    expect(t?.now).toBeUndefined();
    // 18 base, the company's three years give 0 points, minus the ten.
    expect(t?.score).toBe(8);
    // A year back at most, and a bounded number: the walk does not follow the mailbox.
    expect(receivedAsked).toEqual([NOW - 365 * DAY]);
  });

  it("walks the mail once however many threads ask", async () => {
    const wrote = { "anna@northwind.example": { sent: 1, lastMs: NOW - 10 * DAY } };
    const { deps, receivedAsked } = setup(
      [personal("t1", 1), personal("t2", 2)],
      { t1: { from: "a@northwind.example" }, t2: { from: "b@northwind.example" } },
      wrote,
      { received: { "northwind.example": ["x", "y"] } },
    );
    await rankedThings(deps, NOW);
    expect(receivedAsked).toHaveLength(1);
  });

  it("uses the address when the sender has no company", async () => {
    const { deps } = setup(
      [personal("t1", 1)],
      { t1: { from: "ola@gmail.com" } },
      { "friend@gmail.com": { sent: 1, lastMs: NOW - DAY } },
      {
        received: { "ola@gmail.com": ids(19, "t1"), "other@gmail.com": ids(5, "other") },
      },
    );
    expect((await scoreOf(deps, "t1"))?.why).toContain("They have sent 19 messages");
  });

  it("walks nothing for the state path or an office", async () => {
    const { deps, receivedAsked } = setup(
      [owes("t2", 2), personal("t3", 3, { category: "official", intent: "act" })],
      { t2: { from: "c@northwind.example" }, t3: { from: "d@mf.gov.pl" } },
      { "friend@gmail.com": { sent: 1, lastMs: NOW - DAY } },
    );
    await rankedThings(deps, NOW);
    expect(receivedAsked).toEqual([]);
  });
});

describe("kinds of mail and offices in the list (ADR 0068)", () => {
  const rule = (subject: string): AgentRule => ({
    id: 3,
    scope: "category",
    subject,
    action: "noReply",
    actor: "person",
    atMs: 1,
  });

  it("hides a reading of a kind the person refused at read time, and shows it again when the rule goes", async () => {
    const bill = owes("t1", 1, { category: "bill" });
    const mine = { t1: { from: "billing@northwind.example" } };
    const withRule = setup([bill], mine, {}, { rules: [rule("bill")] });
    expect((await rankedThings(withRule.deps, NOW)).ranked).toEqual([]);
    expect((await rankedThings(withRule.deps, NOW)).total).toBe(0);
    const without = setup([bill], mine, {}, { rules: [] });
    expect((await rankedThings(without.deps, NOW)).ranked.map((r) => r.thing.threadId)).toEqual([
      "t1",
    ]);
    // Another kind is not touched.
    const other = setup([bill], mine, {}, { rules: [rule("offer")] });
    expect((await rankedThings(other.deps, NOW)).ranked).toHaveLength(1);
  });

  it("gives an office's mail its base with no relation, and marks a free-mail claim suspect", async () => {
    const notice = owes("office", 1, {
      state: "fyi",
      facts: [],
      category: "official",
      intent: "act",
      intentEvidence: ev("Prosimy o uzupełnienie wniosku", 1),
    });
    const forged = owes("forged", 2, {
      state: "fyi",
      facts: [],
      category: "official",
      intent: "act",
      intentEvidence: ev("Prosimy o uzupełnienie wniosku", 2),
    });
    const { deps } = setup(
      [notice, forged],
      { office: { from: "noreply@mf.gov.pl" }, forged: { from: "urzad.skarbowy@gmail.com" } },
      { "friend@gmail.com": { sent: 1, lastMs: NOW - DAY } },
    );
    const list = (await rankedThings(deps, NOW)).ranked.map((r) => r.thing);
    const byId = new Map(list.map((t) => [t.threadId, t]));
    expect(byId.get("office")).toMatchObject({ official: true, now: true });
    expect(byId.get("office")?.score).toBe(25);
    expect(byId.get("forged")).toMatchObject({ suspect: true });
    expect(byId.get("forged")?.official).toBeUndefined();
    expect(list.at(-1)?.threadId).toBe("forged");
  });
});

describe("a sender nobody can vouch for, in the list (ADR 0066, rule 5)", () => {
  it("marks money asked from a free-mail address nobody wrote to, and a failed check of who sent it", async () => {
    const money = (id: string, key: number) => owes(id, key, { stakes: "money" });
    const { deps } = setup(
      [money("free", 1), money("forged", 2), money("friend", 3)],
      {
        free: { from: "pay@gmail.com" },
        forged: { from: "billing@northwind.example", senderAuth: "fail" },
        friend: { from: "ola@gmail.com" },
      },
      {
        "ola@gmail.com": { sent: 3, lastMs: NOW - DAY },
        "x@elsewhere.example": { sent: 1, lastMs: NOW - DAY },
      },
    );
    const list = (await rankedThings(deps, NOW)).ranked.map((r) => r.thing);
    const byId = new Map(list.map((t) => [t.threadId, t]));
    expect(byId.get("free")?.suspect).toBe(true);
    expect(byId.get("forged")?.suspect).toBe(true);
    expect(byId.get("friend")?.suspect).toBeUndefined();
    expect(list.at(-1)?.suspect).toBe(true);
    expect(list[0]?.threadId).toBe("friend");
  });
});

describe("the history line (ADR 0066, rule 1)", () => {
  const sent = {
    "anna@northwind.example": { sent: 3, lastMs: Date.UTC(2025, 5, 1) },
    "tax@mail.northwind.example": { sent: 1, lastMs: Date.UTC(2026, 1, 1) },
    "ola@gmail.com": { sent: 2, lastMs: Date.UTC(2024, 0, 1) },
  };
  const message = (from: string, own = false): Message =>
    ({
      key: 1,
      dateMs: NOW,
      from: { address: own ? ME : from },
      to: [{ address: own ? from : ME }],
      cc: [],
    }) as unknown as Message;
  const store = (map: Record<string, WrittenTo>) => ({
    listWrittenTo: async () => new Map(Object.entries(map)),
  });
  const own = new Set([ME]);

  it("counts messages to the whole company and gives the year of the last", async () => {
    expect(await senderHistory(store(sent), NOW, [message("new@northwind.example")], own)).toBe(
      "You wrote 4 messages to this company, the last in 2026",
    );
    expect(await senderHistory(store(sent), NOW, [message("new@elsewhere.example")], own)).toBe(
      "You have never written to this company",
    );
  });

  it("speaks of the sender, not a company, at a shared mail domain", async () => {
    expect(await senderHistory(store(sent), NOW, [message("ola@gmail.com")], own)).toBe(
      "You wrote 2 messages to this sender, the last in 2024",
    );
    expect(await senderHistory(store(sent), NOW, [message("eve@gmail.com")], own)).toBe(
      "You have never written to this sender",
    );
  });

  it("does not count the thread's own reply, which the model sees in the thread", async () => {
    const thread = [
      message("tax@mail.northwind.example"),
      message("tax@mail.northwind.example", true),
    ];
    const only = { "tax@mail.northwind.example": { sent: 1, lastMs: NOW } };
    expect(await senderHistory(store(only), NOW, thread, own)).toBe(
      "You have never written to this company",
    );
  });

  it("is absent while no Sent mail is known at all, and carries no address", async () => {
    expect(
      await senderHistory(store({}), NOW, [message("a@northwind.example")], own),
    ).toBeUndefined();
    const line = await senderHistory(store(sent), NOW, [message("a@northwind.example")], own);
    expect(line).not.toMatch(/@|northwind/);
  });
});
