// ADR 0068: mail from a public office, rules about a kind of mail, and the name of a person.
import { describe, expect, it } from "vitest";
import type { AgentRule, CandidateThread, ThreadAnalysis } from "../src/index.ts";
import {
  acceptAnalysis,
  categoryRuleCovers,
  isOfficialAddress,
  normalizeRuleSubject,
  orderForReading,
  personKey,
  rankThings,
  rulesCoverThread,
  selectCandidates,
  sharesTopic,
  THREAD_CATEGORIES,
} from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 12);

describe("isOfficialAddress (ADR 0068, rule 4)", () => {
  it.each([
    "urzad@mf.gov.pl",
    "kontakt@krakow.gov.pl",
    "noreply@epuap.gov",
    "service@hmrc.gov.uk",
    "info@europa.eu",
    "noreply@zus.pl",
    "kontakt@pue.zus.pl",
    "sekretariat@powiat-wielicki.pl",
    "biuro@gmina-wieliczka.pl",
    "no-reply@starostwo-x.pl",
    "wydzial@urzad-miasta.pl",
    "wydzial@um.krakow.pl",
    "kancelaria@ug.wieliczka.pl",
  ])("%s is an office", (address) => {
    expect(isOfficialAddress(address)).toBe(true);
  });

  it.each([
    "anna@northwind.example",
    "me@gmail.com",
    "x@gov.example",
    "x@notgov.pl",
    "x@um.example",
    "x@mail.example.pl",
    "nobody",
    "",
  ])("%s is not", (address) => {
    expect(isOfficialAddress(address)).toBe(false);
  });

  it("does not count a public body's bulletin", () => {
    for (const local of [
      "newsletter",
      "Newsletters",
      "news",
      "biuletyn",
      "biuletyn-info",
      "news.pl",
    ]) {
      expect(isOfficialAddress(`${local}@mf.gov.pl`), local).toBe(false);
    }
    expect(isOfficialAddress("noreply@mf.gov.pl")).toBe(true);
  });
});

describe("selectCandidates and orderForReading with offices (ADR 0068, rule 4)", () => {
  const candidate = (over: Partial<CandidateThread>): CandidateThread => ({
    threadId: "t",
    accountId: "a1",
    lastMessageKey: 1,
    lastDateMs: NOW - DAY,
    lastFromOwn: false,
    messages: [{ from: "noreply@shop.example" }],
    ...over,
  });
  const options = { nowMs: NOW, windowDays: 30, ownAddresses: ["me@example.com"] };

  it("keeps a no-reply notice from an office whatever its subject, and drops a bulletin", () => {
    const picked = selectCandidates(
      [
        candidate({
          threadId: "notice",
          subject: "Zawiadomienie",
          messages: [{ from: "noreply@mf.gov.pl", automated: true }],
        }),
        candidate({
          threadId: "bulletin",
          subject: "Informacje dla podatników",
          messages: [{ from: "newsletter@mf.gov.pl", automated: true }],
        }),
        candidate({
          threadId: "shop",
          subject: "Sale",
          messages: [{ from: "noreply@shop.example" }],
        }),
      ],
      options,
    );
    expect(picked.map((t) => t.threadId)).toEqual(["notice"]);
  });

  it("reads threads from an office before all the rest", () => {
    const ordered = orderForReading(
      [
        candidate({
          threadId: "newest",
          lastDateMs: NOW - 1,
          messages: [{ from: "anna@northwind.example", automated: false }],
        }),
        candidate({
          threadId: "office",
          lastDateMs: NOW - 20 * DAY,
          messages: [{ from: "kontakt@krakow.gov.pl" }],
        }),
        candidate({
          threadId: "mine",
          lastDateMs: NOW - 2,
          lastFromOwn: true,
          messages: [{ from: "me@example.com" }],
        }),
      ],
      ["me@example.com"],
    );
    expect(ordered.map((t) => t.threadId)).toEqual(["office", "newest", "mine"]);
  });
});

describe("rules about a kind of mail (ADR 0068, rule 3)", () => {
  const rule = (subject: string, scope: AgentRule["scope"] = "category"): AgentRule => ({
    id: 1,
    scope,
    subject,
    action: "noReply",
    actor: "person",
    atMs: 1,
  });

  it("takes only a kind in the list, in any case, and not `other`", () => {
    expect(normalizeRuleSubject("category", "Offer")).toBe("offer");
    expect(normalizeRuleSubject("category", " PaymentProblem ")).toBe("paymentProblem");
    expect(normalizeRuleSubject("category", "other")).toBeNull();
    expect(normalizeRuleSubject("category", "cats")).toBeNull();
    expect(normalizeRuleSubject("category", "")).toBeNull();
    for (const kind of THREAD_CATEGORIES.filter((c) => c !== "other")) {
      expect(normalizeRuleSubject("category", kind)).toBe(kind);
    }
  });

  it("hides a reading of that kind at read time, and no other", () => {
    expect(categoryRuleCovers([rule("offer")], { category: "offer" })).toBe(true);
    expect(categoryRuleCovers([rule("offer")], { category: "bill" })).toBe(false);
    expect(categoryRuleCovers([rule("offer")], {})).toBe(false);
    expect(categoryRuleCovers([], { category: "offer" })).toBe(false);
    // An address rule is not a rule about a kind.
    expect(categoryRuleCovers([rule("offer@x.example", "sender")], { category: "offer" })).toBe(
      false,
    );
  });

  it("never stops a thread from being read: it is no address rule", () => {
    expect(
      rulesCoverThread([rule("newsletter")], [{ from: "news@shop.example" }], ["me@example.com"]),
    ).toBe(false);
  });
});

describe("personKey (ADR 0068, rule 2)", () => {
  it("folds a name of two words or more", () => {
    expect(personKey("Anna Kowalska")).toBe("anna kowalska");
    expect(personKey("  ANNA  Kowalska-Nowak ")).toBe("anna kowalska nowak");
    expect(personKey("Zażółć Gęślą")).toBe("zazolc gesla");
  });

  it("is nothing for one word, for none, and for a role", () => {
    expect(personKey("Anna")).toBeNull();
    expect(personKey(undefined)).toBeNull();
    expect(personKey("")).toBeNull();
    for (const name of [
      "Biuro Obsługi",
      "Customer Service",
      "Support Team",
      "Sales Office",
      "Dział Pomoc",
      "Anna Kontakt",
      "Info Northwind",
      "Sekretariat Dyrektora",
      "Administracja Osiedla",
    ]) {
      expect(personKey(name), name).toBeNull();
    }
  });
});

describe("sharesTopic with the thread's subject (ADR 0068, bug)", () => {
  it("matches on the subject when the reading gave no name and no anchors", () => {
    expect(
      sharesTopic(
        undefined,
        undefined,
        ["Re: interpretacja indywidualna ip box"],
        "Oferta IP Box 2026",
      ),
    ).toBe(true);
    expect(sharesTopic(undefined, [], ["Re: interpretacja indywidualna ip box"])).toBe(false);
    expect(sharesTopic("", [], ["Przeprowadzka biura"], "Re: Przeprowadzka")).toBe(true);
  });
});

describe("real notices from an office's address (ADR 0068, rule 4)", () => {
  const notice = (over: Partial<ThreadAnalysis> = {}): ThreadAnalysis => ({
    threadId: "t1",
    lastMessageKey: 100,
    analyzerVersion: 4,
    state: "fyi",
    headline: "A document waits",
    facts: [],
    stakes: "none",
    confidence: 0.9,
    analyzedAtMs: NOW,
    status: "open",
    intent: "know",
    category: "notification",
    intentEvidence: { quote: "q", messageKey: 100 },
    ...over,
  });
  const top = (a: ThreadAnalysis, senderIsOfficial: boolean) =>
    rankThings(
      [
        {
          analysis: a,
          accountId: "a1",
          who: "Office",
          senderAddress: "noreply@office.gov.pl",
          signals: {
            dateOf: new Map([[100, NOW - DAY]]),
            ...(senderIsOfficial ? { senderIsOfficial: true } : {}),
          },
        },
      ],
      [],
      NOW,
    )[0];

  it("shows a plain notice from an office, in the rest", () => {
    expect(top(notice(), true)?.official).toBe(true);
    expect(top(notice(), true)?.now).toBeUndefined();
  });

  it("puts something to do from an office first, whatever the model called it", () => {
    expect(top(notice({ intent: "act" }), true)?.now).toBe(true);
    const owed = notice({
      state: "onYou",
      intent: "act",
      category: "official",
      facts: [{ kind: "ask", who: "you", evidence: { quote: "q", messageKey: 100 } }],
    });
    expect(top(owed, true)?.now).toBe(true);
  });

  it("leaves out an office's bulletin and offer, and the same notice from anyone else", () => {
    expect(top(notice({ category: "newsletter" }), true)).toBeUndefined();
    expect(top(notice({ category: "offer" }), true)).toBeUndefined();
    expect(top(notice(), false)).toBeUndefined();
  });
});

describe("what a name and a window may claim (ADR 0068)", () => {
  it("does not take a company's name for a person", () => {
    expect(personKey("Amazon Web Services")).toBeNull();
    expect(personKey("Anna Nowak")).toBe("anna nowak");
  });

  it("keeps a window only on an offer", () => {
    const answer = (intent: string) => ({
      state: "fyi",
      headline: "h",
      facts: [],
      stakes: "none",
      confidence: 0.9,
      consequence: "none",
      case: "",
      anchors: [],
      intent,
      intentQuote: "tekst",
      forYou: "generic",
      status: "open",
      category: "other",
      windowEnd: "2026-11-30",
    });
    const read = (intent: string) =>
      acceptAnalysis(answer(intent), [{ key: 1, text: "tekst", fromOwn: false }], {
        threadId: "t",
        lastMessageKey: 1,
        analyzerVersion: 4,
        analyzedAtMs: NOW,
      });
    expect(read("decide")?.windowEndMs).toBeDefined();
    expect(read("act")?.windowEndMs).toBeUndefined();
  });
});
