// ADR 0068: mail from a public office, and rules about a kind of mail. ADR 0066, rule 6: service
// mail from programs.
import { describe, expect, it } from "vitest";
import type { AgentRule, CandidateThread } from "../src/index.ts";
import {
  categoryRuleCovers,
  isOfficialAddress,
  normalizeRuleSubject,
  rulesCoverThread,
  THREAD_CATEGORIES,
  talkEligibility,
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

describe("talkEligibility with offices (ADR 0068, rule 4)", () => {
  const candidate = (over: Partial<CandidateThread>): CandidateThread => ({
    threadId: "t",
    accountId: "a1",
    lastMessageKey: 1,
    lastDateMs: NOW - DAY,
    lastFromOwn: false,
    messages: [{ from: "noreply@shop.example" }],
    ...over,
  });
  const options = { ownAddresses: ["me@example.com"] };

  it("keeps a no-reply notice from an office whatever its subject, and drops a bulletin", () => {
    const check = (t: CandidateThread) => talkEligibility(t, options);
    expect(
      check(
        candidate({
          subject: "Zawiadomienie",
          messages: [{ from: "noreply@mf.gov.pl", automated: true }],
        }),
      ),
    ).toBe("ok");
    expect(
      check(
        candidate({
          subject: "Informacje dla podatników",
          messages: [{ from: "newsletter@mf.gov.pl", automated: true }],
        }),
      ),
    ).toBe("automated");
    expect(
      check(candidate({ subject: "Sale", messages: [{ from: "noreply@shop.example" }] })),
    ).toBe("automated");
  });
});

describe("talkEligibility keeps service mail from programs (ADR 0066, rule 6)", () => {
  const candidate = (over: Partial<CandidateThread>): CandidateThread => ({
    threadId: "t",
    accountId: "a1",
    lastMessageKey: 1,
    lastDateMs: NOW - DAY,
    lastFromOwn: false,
    messages: [{ from: "noreply@shop.example" }],
    ...over,
  });
  const check = (t: CandidateThread) => talkEligibility(t, { ownAddresses: ["me@example.com"] });

  it("keeps a no-reply payment notice and drops a no-reply newsletter", () => {
    expect(check(candidate({ subject: "Faktura FV/17/2026 do opłacenia" }))).toBe("ok");
    expect(check(candidate({ subject: "Nowości w naszym sklepie" }))).toBe("automated");
    expect(check(candidate({}))).toBe("automated");
    expect(
      check(
        candidate({
          subject: "Your payment is overdue",
          messages: [{ from: "billing@shop.example", automated: true }],
        }),
      ),
    ).toBe("ok");
    expect(
      check(
        candidate({
          subject: "Ten things we liked",
          messages: [{ from: "messaging-digest-noreply@shop.example" }],
        }),
      ),
    ).toBe("automated");
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
