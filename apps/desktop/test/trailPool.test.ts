import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { Message } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { followTrail } from "../src/backend/talkTrail.ts";
import { createTrailPool } from "../src/backend/trailPool.ts";

// ADR 0081. The candidate pipeline of a question across all mail, over the real SQLite index and
// invented mail: floods, conversations split in many threads, the plan's `time`, and inflection.

const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const ME = "me@home.test";

async function mailbox() {
  const storage = createSqliteStorage(":memory:");
  let n = 0;
  const add = async (spec: {
    thread: string;
    from: string;
    to?: string;
    ageDays: number;
    subject: string;
    body?: string;
    automated?: boolean;
    replyTo?: string;
  }) => {
    const message: Message = makeMessage({
      providerId: `m${++n}`,
      threadId: spec.thread,
      accountId: "acc1",
      dateMs: NOW - spec.ageDays * DAY + n,
      seq: n % 1024,
      from: { address: spec.from },
      to: [{ address: spec.to ?? ME }],
      subject: spec.subject,
      ...(spec.automated === undefined ? {} : { automated: spec.automated }),
      ...(spec.replyTo === undefined ? {} : { replyTo: [{ name: "Kim", address: spec.replyTo }] }),
    });
    const { keys } = await storage.store.upsertMessages([message]);
    const stored = (await storage.store.getByKeys(keys))[0] ?? message;
    await storage.index.indexMessages([{ message: stored, bodyText: spec.body ?? "" }]);
  };
  const context = (time: "recent" | "any" = "any") => ({
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    visibleText: () => "",
    nowMs: NOW,
    consented: new Set(["acc1"]),
    accounts: [{ id: "acc1", address: ME, displayName: "Me" }],
    rules: [],
    olderThanDays: undefined,
    carry: undefined,
    fragments: false,
    time,
  });
  const pool = (time: "recent" | "any" = "any") => createTrailPool(context(time));
  return { storage, add, pool, context };
}

const ids = (list: readonly { summary: { threadId: string } }[]) =>
  list.map((c) => c.summary.threadId);

describe("the trail's candidate pipeline (ADR 0081)", () => {
  it("keeps a conversation the person took part in ahead of a flood of newsletters that merely match the words", async () => {
    const m = await mailbox();
    for (let i = 0; i < 50; i++) {
      await m.add({
        thread: `news-${i}`,
        from: "digest@newsmail.test",
        ageDays: 1 + i,
        subject: `Contract news ${i}`,
        body: "contract contract contract",
      });
    }
    await m.add({
      thread: "talk",
      from: "kim@partner.test",
      ageDays: 500,
      subject: "Our work",
      body: "about the contract terms",
    });
    await m.add({
      thread: "talk",
      from: ME,
      to: "kim@partner.test",
      ageDays: 499,
      subject: "Re: Our work",
      body: "the contract looks fine",
    });
    const pool = m.pool();
    await pool.runRound(["contract"]);
    await pool.refresh();
    const shown = ids(pool.shown());
    expect(shown.indexOf("talk")).toBeGreaterThanOrEqual(0);
    expect(shown.indexOf("talk")).toBeLessThan(3);
    // The newsletters are still there behind it, but one query put only two of them ahead.
    expect(pool.ran[0]?.threads).toBe(40);
    expect(
      pool.lists[0]?.slice(0, 3).filter((t) => t.threadId.startsWith("news-")).length,
    ).toBeLessThanOrEqual(2);
    m.storage.close();
  });

  it("counts a conversation split in many threads once, as the longest, and ranks its fragments there", async () => {
    const m = await mailbox();
    for (let i = 0; i < 4; i++) {
      await m.add({
        thread: `frag-${i}`,
        from: "kim@partner.test",
        ageDays: 20,
        subject: i % 2 ? "Re: Signing the deal" : "Signing the deal",
        body: "signing the deal",
      });
      await m.add({
        thread: `frag-${i}`,
        from: ME,
        to: "kim@partner.test",
        ageDays: 19,
        subject: "Re: Signing the deal",
        body: "signing the deal",
      });
    }
    for (let i = 0; i < 6; i++) {
      await m.add({
        thread: "whole",
        from: i % 2 ? ME : "kim@partner.test",
        to: i % 2 ? "kim@partner.test" : ME,
        ageDays: 25 - i,
        subject: "RE: RE: Signing the deal",
        body: "signing the deal",
      });
    }
    await m.add({
      thread: "other",
      from: "lee@elsewhere.test",
      ageDays: 5,
      subject: "Signing a lease",
      body: "signing the lease",
    });
    const pool = m.pool();
    await pool.runRound(["signing"]);
    await pool.refresh();
    const shown = ids(pool.shown());
    expect(shown.filter((id) => id === "whole" || id.startsWith("frag-"))).toEqual(["whole"]);
    expect(shown).toContain("other");
    expect(pool.repOf("frag-2")).toBe("whole");
    const rank = pool.rankOf(new Set(["frag-0", "frag-3"]), pool.shown());
    expect(rank).toBe(shown.indexOf("whole") + 1);
    m.storage.close();
  });

  it("passes the plan's time to the ranking: age weighs far less for any than for recent", async () => {
    const m = await mailbox();
    await m.add({
      thread: "old",
      from: "kim@partner.test",
      ageDays: 6 * 365,
      subject: "Agreement",
      body: "agreement",
      automated: false,
    });
    await m.add({
      thread: "new",
      from: "lee@elsewhere.test",
      ageDays: 2,
      subject: "Agreement",
      body: "agreement",
      automated: false,
    });
    const any = m.pool("any");
    await any.runRound(["agreement"]);
    const recent = m.pool("recent");
    await recent.runRound(["agreement"]);
    const score = (pool: typeof any, id: string) =>
      pool.lists[0]?.find((t) => t.threadId === id)?.score as number;
    // The newest thread hardly changes; the one from six years ago gains about 2.5 points.
    expect(score(any, "new") - score(recent, "new")).toBeLessThan(0.1);
    expect(score(any, "old") - score(recent, "old")).toBeGreaterThan(2);
    expect(recent.lists[0]?.[0]?.threadId).toBe("new");
    m.storage.close();
  });

  it("finds the other forms of a word the plan wrote in one form", async () => {
    const m = await mailbox();
    await m.add({
      thread: "t1",
      from: "kim@partner.test",
      ageDays: 3,
      subject: "Podpisanie umowy",
      body: "dzień dobry",
    });
    await m.add({
      thread: "t2",
      from: "kim@partner.test",
      ageDays: 4,
      subject: "Wypowiedziałem umowę",
      body: "dzień dobry",
    });
    await m.add({
      thread: "t3",
      from: "kim@partner.test",
      ageDays: 5,
      subject: "Obiad",
      body: "dzień dobry",
    });
    const pool = m.pool();
    await pool.runRound(["umowa"]);
    expect(new Set(pool.lists[0]?.map((t) => t.threadId))).toEqual(new Set(["t1", "t2"]));
    m.storage.close();
  });

  it("keeps envelopes a service sent for people the person wrote to, and shows them as the person via the service", async () => {
    const m = await mailbox();
    // An e-signature service sends many envelopes; each names the person it was sent for.
    await m.add({
      thread: "out",
      from: ME,
      to: "kim@client.test",
      ageDays: 400,
      subject: "Hello",
      body: "hi",
    });
    for (let i = 0; i < 8; i++) {
      await m.add({
        thread: `cold-${i}`,
        from: "dse@esign.test",
        ageDays: 10 + i,
        subject: `Termination certificate ${i}`,
        body: "termination",
        replyTo: `p${i}@cold${i}.test`,
      });
    }
    await m.add({
      thread: "known",
      from: "dse@esign.test",
      ageDays: 300,
      subject: "Termination certificate",
      body: "termination",
      replyTo: "kim@client.test",
    });
    const pool = m.pool();
    await pool.runRound(["termination"]);
    await pool.refresh();
    const list = pool.shown();
    const known = list.find((c) => c.summary.threadId === "known");
    expect(known).toBeDefined();
    expect(known?.summary.senderAddress).toBe("kim@client.test");
    expect(known?.summary.senderName).toBe("Kim (via esign.test)");
    m.storage.close();
  });

  describe("mail a query required the sender of (ADR 0082)", () => {
    const withMail = async () => {
      const m = await mailbox();
      const program = async (thread: string, from: string, ageDays: number) =>
        m.add({
          thread,
          from,
          ageDays,
          subject: "Your reservation",
          body: "reservation reservation",
          automated: true,
        });
      await program("trip", "noreply@stays.example", 3);
      await program("promo", "news@shop.example", 2);
      for (let i = 0; i < 2; i++) {
        await m.add({
          thread: `kim-${i}`,
          from: "kim@partner.test",
          ageDays: 5 + i,
          subject: `Reservation ${i}`,
          body: "about the reservation",
        });
      }
      return m;
    };
    const run = async (m: Awaited<ReturnType<typeof mailbox>>, queries: string[]) => {
      const pool = m.pool();
      await pool.runRound(queries);
      await pool.refresh();
      return ids(pool.shown());
    };

    it("puts programs behind people when found by plain words, and the asked one in front", async () => {
      const m = await withMail();
      const plain = await run(m, ["reservation"]);
      expect(plain.slice(0, 2)).toEqual(["kim-0", "kim-1"]);
      expect(plain.slice(2).sort()).toEqual(["promo", "trip"]);
      const asked = await run(m, ["reservation", "from:stays.example"]);
      expect(asked[0]).toBe("trip");
      expect(asked.slice(1, 3)).toEqual(["kim-0", "kim-1"]);
      expect(asked[3]).toBe("promo");
      m.storage.close();
    });

    it("does not promote what a query matched by a word alone", async () => {
      const m = await withMail();
      const pool = m.pool();
      await pool.runRound(["reservation OR from:stays.example"]);
      await pool.refresh();
      expect(pool.askedReps().size).toBe(0);
      const shown = ids(pool.shown());
      expect(shown.slice(0, 2)).toEqual(["kim-0", "kim-1"]);
      expect(shown.indexOf("trip")).toBeGreaterThanOrEqual(2);
      const asking = m.pool();
      await asking.runRound(["from:stays.example reservation"]);
      await asking.refresh();
      expect([...asking.askedReps()]).toEqual(["trip"]);
      m.storage.close();
    });

    it("keeps the flags on the right lists when a list was pushed from outside", async () => {
      const m = await withMail();
      const pool = m.pool();
      pool.lists.push([{ threadId: "promo", accountId: "", messageKey: 0, score: 100 }]);
      await pool.runRound(["reservation", "from:stays.example"]);
      await pool.refresh();
      const shown = ids(pool.shown());
      expect(shown[0]).toBe("trip");
      expect(shown.at(-1)).toBe("promo");
      m.storage.close();
    });

    it("does not promote or uncap `from:me`, the person's own mail", async () => {
      const m = await mailbox();
      const colleagues = ["ann", "bob", "cy", "dee"];
      for (const [i, who] of colleagues.entries()) {
        await m.add({
          thread: `c-${who}`,
          from: `${who}@corp.example`,
          ageDays: 1 + i,
          subject: "Plans",
          body: "plans",
        });
        await m.add({
          thread: `c-${who}`,
          from: ME,
          to: `${who}@corp.example`,
          ageDays: 1 + i - 0.5,
          subject: "Re: Plans",
          body: "plans",
        });
      }
      await m.add({
        thread: "o-1",
        from: "pat@other.test",
        ageDays: 20,
        subject: "Plans",
        body: "plans",
      });
      await m.add({
        thread: "o-1",
        from: ME,
        to: "pat@other.test",
        ageDays: 19,
        subject: "Re: Plans",
        body: "plans",
      });
      const shown = await run(m, ["from:me"]);
      expect(shown).toHaveLength(5);
      // Four people at one company: the fourth waits behind the person at another one.
      expect(shown[4]).toBe("c-dee");
      m.storage.close();
    });

    const planOf = (...queries: string[]) =>
      ({
        goal: "Find the reservation",
        assumptions: [],
        trails: [{ name: "Main", why: "It is likely", priority: 5, queries }],
        traps: [],
      }) as never;
    const trail = (
      m: Awaited<ReturnType<typeof mailbox>>,
      follow: (request: { untrusted: string }) => unknown,
      plan: never,
    ) =>
      followTrail(
        {
          ...m.context(),
          words: "reservation",
          follow: async (request) => follow(request),
          sent: async () => {},
          step: () => {},
          check: () => {},
          over: () => false,
        },
        plan,
      );
    /** The number the follow turn is shown for the thread last written by this address. */
    const numberOf = (request: { untrusted: string }, address: string): number => {
      const hit = new RegExp(
        `\\[Thread (\\d+)\\][^\\n]*\\n[^\\n]*\\nFrom: [^\\n]*<${address}>`,
      ).exec(request.untrusted);
      return Number(hit?.[1]);
    };

    it("reads an asked program thread when the follow turn gives nothing usable", async () => {
      const m = await withMail();
      const garbage = () => "not a follow turn";
      const plain = (await trail(m, garbage, planOf("reservation"))).threadIds;
      expect(plain).toContain("kim-0");
      expect(plain).not.toContain("trip");
      const asked = (
        await trail(m, garbage, planOf("reservation", "from:stays.example reservation"))
      ).threadIds;
      expect(asked).toContain("kim-0");
      expect(asked).toContain("trip");
      expect(asked).not.toContain("promo");
      m.storage.close();
    });

    it("adds an asked program thread to what the last round kept, and no other program", async () => {
      const m = await withMail();
      const turns: string[][] = [["from:stays.example"], ["reservation"]];
      let turn = 0;
      const out = await trail(
        m,
        (request) => ({
          decision: "follow",
          keep: [numberOf(request, "kim@partner.test")],
          newQueries: turns[turn++],
          hypothesis: "It is in the stays mail",
        }),
        planOf("from:partner.test"),
      );
      expect(turn).toBe(2);
      expect(out.threadIds).toContain("kim-0");
      expect(out.threadIds).toContain("trip");
      expect(out.threadIds).not.toContain("promo");
      m.storage.close();
    });
  });

  it("drops a query with a fault and runs the rest, as before", async () => {
    const m = await mailbox();
    await m.add({ thread: "t1", from: "kim@partner.test", ageDays: 3, subject: "Umowa" });
    const pool = m.pool();
    await pool.runRound(["umowa", "after:notadate"]);
    expect(pool.ran.map((r) => r.query)).toEqual(["umowa"]);
    expect(pool.dropped).toHaveLength(1);
    m.storage.close();
  });
});
