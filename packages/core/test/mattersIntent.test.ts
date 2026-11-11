// ADR 0066: what the person would regret not seeing. The reading of what a thread asks, the checks
// that make the reading trustworthy, the gate that lets it in, and what keeps the list honest.
import { describe, expect, it } from "vitest";
import type {
  AnalyzedThread,
  CandidateThread,
  PromptMessage,
  Thing,
  ThingFeedback,
  ThingSignals,
  ThreadAnalysis,
  ThreadFact,
} from "../src/index.ts";
import {
  ANALYSIS_INSTRUCTIONS,
  acceptAnalysis,
  agoInWords,
  collapseSeries,
  describeHistory,
  interactionPointsFor,
  parseIsoDay,
  rankThings,
  renderThread,
  selectCandidates,
  shownPath,
} from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 12);

// --- acceptAnalysis: code checks every claim of the new reading ---

describe("acceptAnalysis with the reading of ADR 0066", () => {
  const msgs: Pick<PromptMessage, "key" | "text" | "fromOwn">[] = [
    { key: 10, fromOwn: false, text: "Dzień dobry, proponujemy pakiet za 1090 PLN netto." },
    { key: 20, fromOwn: true, text: "Dziękuję, wrócę do tematu." },
    {
      key: 30,
      fromOwn: false,
      text: "Oferta ważna do 2026-12-31. Dotyczy Twojej deklaracji za 2025.",
    },
  ];
  const meta = { threadId: "t1", lastMessageKey: 30, analyzerVersion: 4, analyzedAtMs: NOW };
  const answer = (over: Record<string, unknown> = {}) => ({
    state: "fyi",
    headline: "Oferta",
    facts: [],
    stakes: "money",
    confidence: 0.9,
    intent: "decide",
    intentQuote: "proponujemy pakiet za 1090 PLN",
    forYou: "specific",
    forYouQuote: "Twojej deklaracji za 2025",
    status: "open",
    category: "offer",
    ...over,
  });
  const read = (over: Record<string, unknown> = {}) => acceptAnalysis(answer(over), msgs, meta);

  it("keeps an intent whose passage is in a message, with the key of that message", () => {
    const a = read();
    expect(a?.intent).toBe("decide");
    expect(a?.intentEvidence).toEqual({
      quote: "proponujemy pakiet za 1090 PLN",
      messageKey: 10,
    });
  });

  it.each(["decide", "act", "reply", "know", "wait"] as const)(
    "turns %s into none when its passage is not in the thread, or empty",
    (intent) => {
      for (const intentQuote of ["Zapłać do piątku, inaczej odłączymy usługę", "", "   "]) {
        const a = read({ intent, intentQuote });
        expect(a?.intent, `${intent}: ${intentQuote}`).toBe("none");
        expect(a).not.toHaveProperty("intentEvidence");
      }
    },
  );

  it("takes none with an empty passage, and ignores a passage given with none", () => {
    expect(read({ intent: "none", intentQuote: "" })?.intent).toBe("none");
    const a = read({ intent: "none", intentQuote: "proponujemy pakiet za 1090 PLN" });
    expect(a?.intent).toBe("none");
    expect(a).not.toHaveProperty("intentEvidence");
  });

  it("matches a passage across white space and curly quotes, as every other quote", () => {
    const a = read({ intentQuote: "proponujemy   pakiet\nza 1090 PLN" });
    expect(a?.intent).toBe("decide");
  });

  it("takes `specific` only on a passage that is found", () => {
    expect(read()?.forYouEvidence).toEqual({
      quote: "Twojej deklaracji za 2025",
      messageKey: 30,
    });
    // A passage that is not in the thread, and none at all: no claim.
    expect(read({ forYouQuote: "Pańskiej deklaracji za 2019" })).not.toHaveProperty(
      "forYouEvidence",
    );
    const { forYouQuote: _gone, ...noQuote } = answer();
    expect(acceptAnalysis(noQuote, msgs, meta)).not.toHaveProperty("forYouEvidence");
  });

  it("leaves out a personal passage the model gave for `generic`", () => {
    const a = read({ forYou: "generic" });
    expect(a).not.toHaveProperty("forYouEvidence");
  });

  it("keeps an amount with its role when its passage has digits and is found", () => {
    const a = read({ amount: { value: 1090, currency: "PLN", role: "price", quote: "1090 PLN" } });
    expect(a?.amount).toEqual({
      value: 1090,
      currency: "PLN",
      role: "price",
      evidence: { quote: "1090 PLN", messageKey: 10 },
    });
    // The same number is another thing as a debt or a refund.
    expect(
      read({ amount: { value: 1090, currency: "PLN", role: "refund", quote: "1090 PLN" } })?.amount
        ?.role,
    ).toBe("refund");
  });

  it("drops an amount whose passage is not found, has no digits, or whose number is not positive", () => {
    const base = { currency: "PLN", role: "debt" };
    const cases = [
      { ...base, value: 1090, quote: "2090 PLN" },
      { ...base, value: 1090, quote: "pakiet za" },
      { ...base, value: 0, quote: "1090 PLN" },
      { ...base, value: -5, quote: "1090 PLN" },
      { ...base, value: Number.NaN, quote: "1090 PLN" },
      { ...base, value: Number.POSITIVE_INFINITY, quote: "1090 PLN" },
    ];
    for (const amount of cases) {
      const a = read({ amount });
      expect(a, JSON.stringify(amount)).not.toBeNull();
      expect(a, JSON.stringify(amount)).not.toHaveProperty("amount");
    }
  });

  it("reads the end of an offer through parseIsoDay: a real day or nothing", () => {
    expect(read({ windowEnd: "2026-12-31" })?.windowEndMs).toBe(parseIsoDay("2026-12-31"));
    expect(read({ windowEnd: "2026-02-30" })).not.toHaveProperty("windowEndMs");
    expect(read({ windowEnd: "soon" })).not.toHaveProperty("windowEndMs");
    expect(read()).not.toHaveProperty("windowEndMs");
  });

  it("carries the status the thread shows, apart from the intent", () => {
    expect(read({ status: "done" })?.status).toBe("done");
    expect(read({ status: "unknown" })?.status).toBe("unknown");
  });
});

// --- The prompt ---

describe("the prompt of ADR 0066", () => {
  it("tells the model what to do with the pay-by line and what the new fields mean", () => {
    expect(ANALYSIS_INSTRUCTIONS).toContain("Zapłać do: 15.09.2026");
    expect(ANALYSIS_INSTRUCTIONS).toContain("has no due is a mistake");
    expect(ANALYSIS_INSTRUCTIONS).toContain('"History"');
    expect(ANALYSIS_INSTRUCTIONS).toContain(
      "an old relationship alone does not make a thread specific",
    );
    for (const word of ["intent:", "intentQuote", "amount", "windowEnd", "forYou", "status:"]) {
      expect(ANALYSIS_INSTRUCTIONS).toContain(word);
    }
  });

  it("puts the history line from code next to Depth, with no address in it", () => {
    const text = renderThread(
      {
        subject: "Oferta",
        history: describeHistory({ sent: 3, lastMs: Date.UTC(2024, 5, 1) }, "company"),
        messages: [
          {
            key: 1,
            dateMs: NOW,
            from: { name: "Anna", address: "anna@northwind.example" },
            fromOwn: false,
            text: "Hello",
          },
        ],
      },
      NOW,
    );
    const lines = text.split("\n");
    const depth = lines.findIndex((l) => l.startsWith("Depth:"));
    expect(lines[depth + 1]).toBe(
      "History: You wrote 3 messages to this company, the last in 2024",
    );
    expect(text.split("[Message 1]")[0]).not.toContain("northwind");
  });

  it("says what is known: counts and a year, or never", () => {
    expect(describeHistory({ sent: 1, lastMs: Date.UTC(2023, 0, 1) }, "company")).toBe(
      "You wrote 1 message to this company, the last in 2023",
    );
    expect(describeHistory(undefined, "company")).toBe("You have never written to this company");
    expect(describeHistory(undefined, "sender")).toBe("You have never written to this sender");
  });

  it("leaves the line out when there is none", () => {
    const text = renderThread({ subject: "S", messages: [] }, NOW);
    expect(text).not.toContain("History:");
  });
});

// --- The gate and the order ---

const ev = (quote = "q", messageKey = 100) => ({ quote, messageKey });

const reading = (over: Partial<ThreadAnalysis> = {}): ThreadAnalysis => ({
  threadId: "t1",
  lastMessageKey: 100,
  analyzerVersion: 4,
  state: "fyi",
  headline: "A thing",
  facts: [],
  stakes: "none",
  confidence: 0.9,
  analyzedAtMs: NOW,
  status: "open",
  ...over,
});

const signals = (over: Partial<ThingSignals> = {}, lastDays = 1): ThingSignals => ({
  dateOf: new Map([[100, NOW - lastDays * DAY]]),
  ...over,
});

const entry = (a: ThreadAnalysis, s?: ThingSignals, sender = "anna@northwind.example") =>
  ({
    analysis: a,
    accountId: "a1",
    who: "Anna",
    senderAddress: sender,
    ...(s === undefined ? {} : { signals: s }),
  }) satisfies AnalyzedThread;

const first = (a: ThreadAnalysis, s?: ThingSignals, feedback: ThingFeedback[] = []) =>
  rankThings([entry(a, s)], feedback, NOW)[0];

const fact = (over: Partial<ThreadFact> = {}): ThreadFact => ({
  kind: "ask",
  who: "you",
  evidence: ev("Prosimy o płatność"),
  ...over,
});

const decide = (over: Partial<ThreadAnalysis> = {}) =>
  reading({
    intent: "decide",
    intentEvidence: ev("proponujemy pakiet"),
    forYouEvidence: ev("Twojej deklaracji"),
    ...over,
  });

describe("what may become a thing (ADR 0066, rule 2)", () => {
  it("lets a decision in on a passage that makes it the person's own, and says so in code", () => {
    const t = first(decide(), signals());
    expect(t?.quote).toEqual(ev("proponujemy pakiet"));
    expect(t?.score).toBe(18);
    expect(t?.intent).toBe("decide");
    expect(t?.why).toBe("You can take this or leave it. It is about your own matter.");
  });

  it("does not let a decision in with no personal reason, even from a company the person knows", () => {
    const a = decide({ forYouEvidence: undefined as never });
    delete (a as { forYouEvidence?: unknown }).forYouEvidence;
    const known = signals({
      wroteToSender: true,
      wroteToCompany: true,
      interaction: { address: NOW - DAY },
    });
    expect(first(a, known)).toBeUndefined();
    expect(first(a, signals({ sharesTopic: false }))).toBeUndefined();
    expect(first(a)).toBeDefined(); // no signals at all: the coarse pass lets it by
    expect(shownPath(a, { feedback: [], nowMs: NOW, signals: known })).toBeNull();
  });

  it("lets a decision in when the person wrote to that company about the same thing", () => {
    const a = decide();
    delete (a as { forYouEvidence?: unknown }).forYouEvidence;
    const t = first(a, signals({ sharesTopic: true }));
    expect(t?.why).toBe("You can take this or leave it. You wrote to them about this before.");
  });

  it("lets an act or a reply in when the state says nothing is owed but the quote says there is something", () => {
    for (const intent of ["act", "reply"] as const) {
      const t = first(reading({ intent, intentEvidence: ev("Prosimy o płatność") }), signals());
      expect(t?.score, intent).toBe(20);
      expect(t?.quote).toEqual(ev("Prosimy o płatność"));
      expect(t?.why).toContain(
        intent === "act" ? "This is for you to do." : "They expect an answer from you.",
      );
    }
    expect(
      first(reading({ state: "none", intent: "act", intentEvidence: ev() }), signals()),
    ).toBeDefined();
  });

  it("lets news in only on a personal passage from a sender the person knows, and never for now", () => {
    const news = reading({
      intent: "know",
      intentEvidence: ev("zmiana warunków"),
      forYouEvidence: ev("Twojej umowy"),
    });
    for (const known of [
      signals({ wroteToSender: true }),
      signals({ wroteToSender: false, wroteToCompany: true }),
    ]) {
      const t = first(news, known);
      expect(t?.score).toBe(6);
      expect(t?.now).toBeUndefined();
      expect(t?.why).toContain("This changes something for you.");
    }
    expect(first(news, signals({ wroteToSender: false, wroteToCompany: false }))).toBeUndefined();
    expect(first(news, signals())).toBeUndefined();
    const generic = { ...news };
    delete (generic as { forYouEvidence?: unknown }).forYouEvidence;
    expect(first(generic, signals({ wroteToSender: true }))).toBeUndefined();
  });

  it("keeps the old path as it was: a quoted fact on the needed side", () => {
    const t = first(reading({ state: "onYou", facts: [fact()] }), signals());
    expect(t?.score).toBe(28);
    expect(t?.quote).toEqual(ev("Prosimy o płatność"));
    expect(first(reading({ state: "onYou", facts: [fact({ who: "them" })] }), signals())).toBe(
      undefined,
    );
    expect(first(reading({ state: "fyi" }), signals())).toBeUndefined();
  });

  it("shows nothing that is sure of less than the bar, that the thread shows done, or that was hidden", () => {
    const onYou = reading({ state: "onYou", facts: [fact()] });
    expect(first({ ...onYou, confidence: 0.4 }, signals())).toBeUndefined();
    expect(first({ ...onYou, status: "done" }, signals())).toBeUndefined();
    expect(first({ ...decide(), status: "done" }, signals())).toBeUndefined();
    const closed: ThingFeedback = {
      threadId: "t1",
      lastMessageKey: 100,
      senderAddress: "anna@northwind.example",
      kind: "closed",
      atMs: NOW,
    };
    expect(first(onYou, signals(), [closed])).toBeUndefined();
    expect(first(decide(), signals(), [{ ...closed, kind: "notImportant" }])).toBeUndefined();
  });

  it("is for now when an offer ends within three days, or arrived from someone dealt with lately (ADR 0068, rule 6)", () => {
    const lately = { address: NOW - 20 * DAY };
    // Arrived yesterday, no dealings: in the rest, whatever its topic or the model's word.
    expect(first(decide(), signals({}, 1))?.now).toBeUndefined();
    expect(first(decide(), signals({ sharesTopic: true }, 1))?.now).toBeUndefined();
    // The same, from someone the person wrote to within 180 days.
    expect(first(decide(), signals({ interaction: lately }, 1))?.now).toBe(true);
    expect(
      first(decide(), signals({ interaction: { company: NOW - 200 * DAY } }, 1))?.now,
    ).toBeUndefined();
    // Dealt with lately, but the offer is a week old.
    expect(first(decide(), signals({ interaction: lately }, 10))?.now).toBeUndefined();
    const ends = (days: number) => decide({ windowEndMs: NOW + days * DAY });
    expect(first(ends(2), signals({}, 10))?.now).toBe(true);
    expect(first(ends(5), signals({}, 10))?.now).toBeUndefined();
    expect(first(ends(2), signals({}, 10))?.why).toContain("It ends");
  });

  it("does not hold against an offer that nothing is lost by waiting", () => {
    const t = first({ ...decide(), consequence: "none" }, signals());
    const plain = first(decide(), signals());
    expect(t?.score).toBe(plain?.score);
    expect(t?.why).not.toContain("Nothing is lost");
  });

  it("passes the intent, the amount and the end of an offer on", () => {
    const amount = { value: 1090, currency: "PLN", role: "price" as const, evidence: ev("1090") };
    const t = first(decide({ amount, windowEndMs: NOW + 9 * DAY }), signals());
    expect(t).toMatchObject({ intent: "decide", amount, windowEndMs: NOW + 9 * DAY });
  });

  it("lets the old path's intent through too, and leaves out `none`", () => {
    const t = first(reading({ state: "onYou", facts: [fact()], intent: "reply" }), signals());
    expect(t?.intent).toBe("reply");
    expect(
      first(reading({ state: "onYou", facts: [fact()], intent: "none" }), signals()),
    ).not.toHaveProperty("intent");
  });
});

describe("interaction recency, the strongest signal (ADR 0068, rule 2)", () => {
  const onYou = reading({ state: "onYou", facts: [fact()] });
  const base = first(onYou, signals())?.score as number;
  const withInteraction = (interaction: ThingSignals["interaction"], extra = {}) =>
    first(onYou, signals({ wroteToSender: false, interaction, ...extra }));

  it("halves every 180 days: full at 0, half at 180, nearly nothing at 1000", () => {
    expect(interactionPointsFor("address", 0)).toBe(30);
    expect(interactionPointsFor("address", 180)).toBe(15);
    expect(interactionPointsFor("address", 360)).toBe(8);
    expect(interactionPointsFor("address", 1000)).toBe(1);
    expect(interactionPointsFor("person", 0)).toBe(24);
    expect(interactionPointsFor("company", 0)).toBe(12);
    expect(interactionPointsFor("company", 180)).toBe(6);
    expect(interactionPointsFor("company", 1000)).toBe(0);
  });

  it("gives the best level and says which, in words the person reads", () => {
    const at = (days: number) => NOW - days * DAY;
    const same = withInteraction({ address: at(0) }, { wroteToSender: true });
    expect(same?.score).toBe(base + 30);
    expect(same?.why).toContain("You last wrote to them today.");
    const person = withInteraction({ person: at(0), company: at(0) });
    expect(person?.score).toBe(base + 24);
    expect(person?.why).toContain(
      "You last wrote to what looks like the same person at another address today.",
    );
    const company = withInteraction({ company: at(10) });
    expect(company?.score).toBe(base + interactionPointsFor("company", 10));
    expect(company?.why).toContain("You last wrote to this company 10 days ago.");
    // The best of the levels, not the nearest: a stale address beats nothing but not a fresh person.
    expect(withInteraction({ address: at(900), person: at(0) })?.score).toBe(base + 24);
    expect(withInteraction({ address: at(30), company: at(0) })?.score).toBe(
      base + interactionPointsFor("address", 30),
    );
  });

  it("says long spans in months and years", () => {
    expect(agoInWords(1)).toBe("1 day ago");
    expect(agoInWords(45)).toBe("45 days ago");
    expect(agoInWords(200)).toBe("7 months ago");
    expect(agoInWords(1100)).toBe("3 years ago");
    expect(withInteraction({ company: NOW - 400 * DAY })?.why).toContain("13 months ago.");
  });

  it("falls with time by itself: an old relation gives nothing and costs nothing", () => {
    const old = withInteraction({ address: NOW - 3 * 365 * DAY });
    expect(old?.score).toBe(base + 0);
    expect(old?.why).not.toContain("never written");
    expect(withInteraction({ company: NOW - 3 * 365 * DAY })?.score).toBe(base);
  });

  it("is a stranger only with no level at all, and an office is none", () => {
    const stranger = first(onYou, signals({ wroteToSender: false, wroteToCompany: false }));
    expect(stranger?.score).toBe(base - 15);
    expect(stranger?.why).toContain("You have never written to them.");
    // A level, however old, is not strangeness.
    expect(withInteraction({ company: NOW - 3 * 365 * DAY })?.why).not.toContain("never");
    const office = reading({ state: "onYou", facts: [fact()], category: "official" });
    expect(first(office, signals({ wroteToSender: false, wroteToCompany: false }))?.score).toBe(
      base,
    );
  });

  it("applies on every path", () => {
    const interaction = { address: NOW - DAY };
    const act = reading({ intent: "act", intentEvidence: ev() });
    expect(first(act, signals({ interaction }))?.score).toBe(
      (first(act, signals())?.score as number) + interactionPointsFor("address", 1),
    );
    const waiting = reading({ state: "waiting", facts: [fact({ who: "them" })] });
    expect(first(waiting, signals({ interaction }, 5))?.score).toBe(
      (first(waiting, signals({}, 5))?.score as number) + interactionPointsFor("address", 1),
    );
  });

  it("lets news in without a personal passage from someone written to at address or person level within 180 days", () => {
    const news = reading({ intent: "know", intentEvidence: ev("zmiana") });
    const at = (days: number) => NOW - days * DAY;
    expect(first(news, signals({ interaction: { address: at(100) } }))).toBeDefined();
    expect(first(news, signals({ interaction: { person: at(100) } }))).toBeDefined();
    expect(first(news, signals({ interaction: { address: at(200) } }))).toBeUndefined();
    expect(first(news, signals({ interaction: { company: at(10) } }))).toBeUndefined();
    expect(first(news, signals())).toBeUndefined();
  });

  it("marks news from someone written to within a year only after 45 days, others after 14", () => {
    const news = reading({ intent: "know", intentEvidence: ev(), forYouEvidence: ev() });
    const related = (d: number) =>
      first(news, signals({ wroteToSender: true, interaction: { address: NOW - 100 * DAY } }, d))
        ?.check;
    expect(related(40)).toBeUndefined();
    expect(related(46)).toBe(true);
    const old = (d: number) =>
      first(news, signals({ wroteToSender: true, interaction: { address: NOW - 400 * DAY } }, d))
        ?.check;
    expect(old(15)).toBe(true);
  });
});

describe("offers from someone who is never answered (ADR 0068, rule 6)", () => {
  const years = (n: number) => NOW - n * 365 * DAY;

  it("sits a long-silent offer sender's mail in the rest with the penalty and no interaction points", () => {
    const offer = decide();
    const quiet = signals({ interaction: { company: years(3) }, ignoredSince: 20 }, 1);
    const t = first(offer, quiet);
    expect(t?.now).toBeUndefined();
    // 18 base, 0 interaction points at three years, minus the ten.
    expect(t?.score).toBe(18 - 10);
    expect(t?.why).toContain("They have sent 20 messages since you last wrote.");
    expect(first(offer, signals({ interaction: { company: years(3) } }, 1))?.score).toBe(18);
  });

  it("needs five messages, applies to news too, and never to an office or to a state path", () => {
    const at = (n: number) => first(decide(), signals({ ignoredSince: n }))?.score;
    expect(at(4)).toBe(18);
    expect(at(5)).toBe(8);
    const news = reading({ intent: "know", intentEvidence: ev(), forYouEvidence: ev() });
    expect(first(news, signals({ wroteToSender: true, ignoredSince: 9 }))?.score).toBe(6 - 10);
    const office = decide({ category: "official" });
    expect(first(office, signals({ ignoredSince: 30 }))?.score).toBe(25);
    const onYou = reading({ state: "onYou", facts: [fact()] });
    expect(first(onYou, signals({ ignoredSince: 30 }))?.score).toBe(28);
  });
});

describe("a public office (ADR 0068, rule 4)", () => {
  const office = (over: Partial<ThreadAnalysis> = {}) =>
    reading({
      category: "official",
      intent: "act",
      intentEvidence: ev("Prosimy o uzupełnienie wniosku"),
      ...over,
    });
  const SUSPECT =
    "It says it comes from a public office, from a free mail address. It may not be genuine.";

  it("shows with no personal reason and no relation, with its own base and words", () => {
    const t = first(office(), signals({ wroteToSender: false, wroteToCompany: false }));
    expect(t?.score).toBe(25);
    expect(t?.official).toBe(true);
    expect(t?.category).toBe("official");
    expect(t?.why).toContain("This is from a public office.");
    expect(t?.now).toBe(true);
    expect(shownPath(office(), { feedback: [], nowMs: NOW })).toBe("official");
  });

  it("needs a passage and an intent", () => {
    expect(first(office({ intent: "none" }), signals())).toBeUndefined();
    const bare = office();
    delete (bare as { intentEvidence?: unknown }).intentEvidence;
    expect(first(bare, signals())).toBeUndefined();
  });

  it("adds ten on the state path when the address is an office's, and nothing else", () => {
    const onYou = reading({ state: "onYou", facts: [fact()], category: "official" });
    expect(first(onYou, signals({ senderIsOfficial: true }))?.score).toBe(38);
    expect(first(onYou, signals())?.score).toBe(28);
    expect(first(onYou, signals({ senderIsOfficial: true }))?.why).toContain(
      "This is from a public office.",
    );
  });

  it("is for now on an act, a reply or a decision, a near date, or news within 14 days", () => {
    expect(first(office({ intent: "decide" }), signals({}, 20))?.now).toBe(true);
    const news = office({ intent: "know" });
    expect(first(news, signals({}, 10))?.now).toBe(true);
    expect(first(news, signals({}, 20))?.now).toBeUndefined();
  });

  it("is marked only after 60 days, never drops out, and stays alive while a date is ahead", () => {
    const old = first(office(), signals({}, 70));
    expect(old).toBeDefined();
    expect(old?.check).toBe(true);
    expect(old?.now).toBeUndefined();
    expect(first(office(), signals({}, 50))?.check).toBeUndefined();
    // Not removed like an old offer.
    expect(first(office({ intent: "decide" }), signals({}, 100))?.check).toBe(true);
    const dated = office({ facts: [fact({ dueMs: Date.UTC(2026, 11, 20) })] });
    expect(first(dated, signals({}, 100))?.check).toBeUndefined();
  });

  it("is suspect, not official, when it comes from a free mail address", () => {
    const t = first(office(), signals({ freeMail: true, wroteToSender: false }));
    expect(t?.suspect).toBe(true);
    expect(t?.official).toBeUndefined();
    expect(t?.now).toBeUndefined();
    expect(t?.why).toContain(SUSPECT);
    expect(t?.why).not.toContain("asks for money");
    // The money sentence stays for the other case.
    const pay = reading({ intent: "act", stakes: "money", intentEvidence: ev() });
    expect(first(pay, signals({ freeMail: true, wroteToSender: false }))?.why).toContain(
      "asks for money",
    );
  });

  it("is not suspect for a free-mail sender who is not claiming an office", () => {
    expect(
      first(
        reading({ category: "personal", intent: "reply", intentEvidence: ev() }),
        signals({ freeMail: true, wroteToSender: false }),
      )?.suspect,
    ).toBeUndefined();
  });
});

describe("what kind of mail it is (ADR 0068, rule 3)", () => {
  it("passes the category on, and reads one the store does not know as other", () => {
    expect(
      first(reading({ state: "onYou", facts: [fact()], category: "bill" }), signals())?.category,
    ).toBe("bill");
    const msgs = [{ key: 1, fromOwn: false, text: "Hello" }];
    const meta = { threadId: "t", lastMessageKey: 1, analyzerVersion: 4, analyzedAtMs: NOW };
    const base = {
      state: "none",
      headline: "h",
      facts: [],
      stakes: "none",
      confidence: 0.9,
      intent: "none",
      intentQuote: "",
      forYou: "generic",
      status: "open",
    };
    expect(acceptAnalysis({ ...base, category: "paymentProblem" }, msgs, meta)?.category).toBe(
      "paymentProblem",
    );
    expect(acceptAnalysis({ ...base, category: "something-new" }, msgs, meta)?.category).toBe(
      "other",
    );
    expect(acceptAnalysis(base, msgs, meta)).toBeNull();
  });

  it("is in the prompt with its definitions, and the rule for the person's own instructions", () => {
    for (const word of ["category:", '"official"', '"paymentProblem"', '"newsletter"']) {
      expect(ANALYSIS_INSTRUCTIONS).toContain(word);
    }
    expect(ANALYSIS_INSTRUCTIONS).toContain('ublic body\'s bulletin or newsletter is "newsletter"');
    expect(ANALYSIS_INSTRUCTIONS).toContain('answer state "none" and intent "none"');
  });
});

describe("closing is not complaining (ADR 0066, rule 7)", () => {
  it("does not lower the sender after ten closings, and does after Not important", () => {
    const onYou = reading({ state: "onYou", facts: [fact()] });
    const fb = (kind: ThingFeedback["kind"], n: number): ThingFeedback => ({
      threadId: `old${n}`,
      lastMessageKey: 1,
      senderAddress: "anna@northwind.example",
      kind,
      atMs: NOW - n * DAY,
      ...(kind === "closed" ? { outcome: "done" as const } : {}),
    });
    const none = first(onYou, signals())?.score as number;
    const closed = Array.from({ length: 10 }, (_, i) => fb("closed", i));
    expect(first(onYou, signals(), closed)?.score).toBe(none);
    expect(first(onYou, signals(), [fb("notImportant", 1)])?.score).toBe(none - 10);
  });
});

describe("what the person's own labels taught (ADR 0067)", () => {
  const owed = (over: Partial<ThreadAnalysis> = {}) =>
    reading({
      state: "onYou",
      intent: "reply",
      intentEvidence: ev(),
      facts: [fact({ evidence: ev("x") })],
      ...over,
    });

  it("keeps a thread the person wrote in alive and for now when the other side wrote last", () => {
    const own = signals({ lastOwnKey: 50, wroteToSender: true }, 60);
    expect(first(owed(), own)?.check).toBeUndefined();
    expect(first(owed(), own)?.now).toBe(true);
    expect(first(owed(), signals({ wroteToSender: true }, 60))?.check).toBe(true);
  });

  it("lets a thread the person wrote in go quiet after 90 days", () => {
    const own = signals({ lastOwnKey: 50, wroteToSender: true }, 91);
    expect(first(owed(), own)?.check).toBe(true);
  });

  it("is for now when money is owed to the person, even if they wrote last", () => {
    const waiting = reading({
      state: "waiting",
      intent: "wait",
      stakes: "money",
      facts: [fact({ kind: "promise", who: "them" })],
    });
    const own = signals({ lastOwnKey: 200, wroteToSender: true }, 40);
    expect(first(waiting, own)?.now).toBe(true);
  });

  it("does not mark a thing whose date is still to come, however quiet", () => {
    const dated = owed({ status: "unknown", facts: [fact({ dueMs: NOW + 20 * DAY })] });
    expect(first(dated, signals({ wroteToSender: true }, 70))?.check).toBeUndefined();
  });

  it("shows a doubted request for money from nowhere, and nothing else that is doubted", () => {
    const doubted = owed({ confidence: 0.35, intent: "act", stakes: "money" });
    const stranger = signals({ wroteToSender: false, freeMail: true }, 6);
    expect(first(doubted, stranger)?.suspect).toBe(true);
    expect(first(doubted, signals({ wroteToSender: true }, 6))).toBeUndefined();
    expect(first({ ...doubted, confidence: 0.2 }, stranger)).toBeUndefined();
  });
});

describe("is it still alive (ADR 0066, rule 4)", () => {
  const due = (days: number) => Date.UTC(2026, 10, 5) - days * DAY;
  const owed = (over: Partial<ThreadAnalysis> = {}) =>
    reading({ state: "onYou", facts: [fact({ dueMs: due(20) })], ...over });
  const checkSentence = (days: number) =>
    `Nothing has come about this for ${days} days, so it is not known whether it is still open. Check it once.`;

  it("marks an act that is more than 14 days late after 14 days of silence, and says so", () => {
    const t = first(owed(), signals({}, 30));
    expect(t?.check).toBe(true);
    expect(t?.now).toBeUndefined();
    expect(t?.why).toContain(checkSentence(30));
    // The lateness stays a fact; it stops being points.
    expect(t?.lateByDays).toBe(20);
    const live = first(owed(), signals({}, 3));
    expect(live?.check).toBeUndefined();
    expect(live?.now).toBe(true);
    expect(t?.score).toBeLessThan(live?.score as number);
    expect((live?.score as number) - (t?.score as number)).toBe(3 * 10 + 10);
  });

  it("does not mark an act that is only a little late", () => {
    const t = first(owed({ facts: [fact({ dueMs: due(10) })] }), signals({}, 30));
    expect(t?.check).toBeUndefined();
  });

  it("marks an undated act or reply after 30 days", () => {
    for (const intent of ["act", "reply"] as const) {
      const a = (d: number) =>
        first(reading({ intent, intentEvidence: ev() }), signals({}, d))?.check;
      expect(a(29), intent).toBeUndefined();
      expect(a(31), intent).toBe(true);
    }
    const asked = (d: number) =>
      first(reading({ state: "onYou", facts: [fact()] }), signals({}, d))?.check;
    expect(asked(29)).toBeUndefined();
    expect(asked(31)).toBe(true);
  });

  it("marks what someone owes the person after 30 days, and 60 when money is owed to them", () => {
    const waiting = (over: Partial<ThreadAnalysis>, d: number) =>
      first(reading({ state: "waiting", facts: [fact({ who: "them" })], ...over }), signals({}, d))
        ?.check;
    expect(waiting({}, 29)).toBeUndefined();
    expect(waiting({}, 31)).toBe(true);
    expect(waiting({ stakes: "money" }, 45)).toBeUndefined();
    expect(waiting({ stakes: "money" }, 61)).toBe(true);
    const refund = { value: 80, currency: "PLN", role: "refund" as const, evidence: ev("80 PLN") };
    expect(waiting({ amount: refund }, 45)).toBeUndefined();
    expect(waiting({ amount: refund }, 61)).toBe(true);
  });

  it("ends a decision after 21 days or with its offer, and marks news after 14 (ADR 0067)", () => {
    expect(first(decide(), signals({}, 20))?.check).toBeUndefined();
    expect(first(decide(), signals({}, 22))).toBeUndefined();
    expect(first(decide({ windowEndMs: NOW - 3 * DAY }), signals({}, 1))).toBeUndefined();
    expect(first(decide({ windowEndMs: NOW + 3 * DAY }), signals({}, 1))?.check).toBeUndefined();
    const news = reading({
      intent: "know",
      intentEvidence: ev(),
      forYouEvidence: ev(),
    });
    const known = (d: number) => first(news, signals({ wroteToSender: true }, d))?.check;
    expect(known(13)).toBeUndefined();
    expect(known(15)).toBe(true);
  });

  it("marks a reading that does not know whether it is finished, after 30 days", () => {
    // A date a few days late: lateness alone does not mark it.
    const a = (status: ThreadAnalysis["status"], d: number) =>
      first(
        reading({ state: "onYou", facts: [fact({ dueMs: Date.UTC(2026, 10, 1) })], status }),
        signals({}, d),
      )?.check;
    expect(a("unknown", 15)).toBeUndefined();
    expect(a("unknown", 29)).toBeUndefined();
    expect(a("unknown", 31)).toBe(true);
    expect(a("open", 31)).toBeUndefined();
  });

  it("keeps a month-old unpaid invoice listed but not first, behind a fresh offer that scores less", () => {
    const invoice = reading({
      threadId: "invoice",
      state: "onYou",
      stakes: "money",
      facts: [fact({ dueMs: due(20) })],
      consequence: "real",
    });
    const offer = decide({ threadId: "offer" });
    const list = rankThings(
      [entry(invoice, signals({}, 30)), entry(offer, signals({}, 2))],
      [],
      NOW,
    );
    expect(list.map((t) => t.threadId)).toEqual(["offer", "invoice"]);
    expect(list[1]?.check).toBe(true);
    // Without the rule the invoice would have ruled for ever.
    const asBefore = first(invoice, signals({}, 3))?.score as number;
    expect(asBefore).toBeGreaterThan(list[0]?.score as number);
  });

  it("is never for now and goes after everything that is not marked, whatever it scores", () => {
    const a = rankThings(
      [
        entry(
          reading({
            threadId: "stale",
            state: "onYou",
            stakes: "contract",
            facts: [fact({ dueMs: due(30) })],
            consequence: "real",
          }),
          signals({}, 40),
        ),
        entry(
          reading({ threadId: "plain", state: "waiting", facts: [fact({ who: "them" })] }),
          signals({}, 5),
        ),
      ],
      [],
      NOW,
    );
    expect(a.map((t) => t.threadId)).toEqual(["plain", "stale"]);
    expect(a[1]?.now).toBeUndefined();
  });

  it("never drops a thing for silence alone", () => {
    const t = first(reading({ state: "onYou", facts: [fact()] }), signals({}, 400));
    expect(t).toBeDefined();
    expect(t?.check).toBe(true);
  });
});

describe("a series and the date that decides (ADR 0066, rule 4)", () => {
  const input = (threadId: string, key: number, lastDateMs: number) => ({
    threadId,
    accountId: "a1",
    senderAddress: "billing@northwind.example",
    caseName: "Faktura 17",
    lastMessageKey: key,
    lastDateMs,
    answered: false,
  });
  const rankOne = (id: string, key: number, days: number): Thing => {
    const t = rankThings(
      [
        {
          analysis: reading({
            threadId: id,
            lastMessageKey: key,
            state: "onYou",
            facts: [fact({ dueMs: due(20) })],
            caseName: "Faktura 17",
          }),
          accountId: "a1",
          who: "Billing",
          senderAddress: "billing@northwind.example",
          signals: { dateOf: new Map([[key, NOW - days * DAY]]) },
        },
      ],
      [],
      NOW,
    )[0];
    if (t === undefined) throw new Error("no thing");
    return t;
  };
  const due = (days: number) => Date.UTC(2026, 10, 5) - days * DAY;

  it("lets a fresh reminder lead a series of mails that may be stale, and is not marked", () => {
    const old = rankOne("old", 100, 40);
    const fresh = rankOne("fresh", 200, 2);
    expect(old.check).toBe(true);
    expect(fresh.check).toBeUndefined();
    const [row] = collapseSeries(
      [fresh, old],
      [input("old", 100, NOW - 40 * DAY), input("fresh", 200, NOW - 2 * DAY)],
    );
    expect(row?.threadId).toBe("fresh");
    expect(row?.check).toBeUndefined();
    expect(row?.now).toBe(true);
    expect(row?.score).toBe(fresh.score);
    expect(row?.series?.mails).toHaveLength(2);
  });

  it("keeps a series whose newest mail may be stale as stale, never for now", () => {
    const older = rankOne("older", 100, 60);
    const newest = rankOne("newest", 200, 40);
    const [row] = collapseSeries(
      [newest, older],
      [input("older", 100, NOW - 60 * DAY), input("newest", 200, NOW - 40 * DAY)],
    );
    expect(row?.threadId).toBe("newest");
    expect(row?.check).toBe(true);
    expect(row?.now).toBeUndefined();
  });
});

describe("a sender nobody can vouch for (ADR 0066, rule 5)", () => {
  const pay = reading({
    intent: "act",
    stakes: "money",
    intentEvidence: ev("Zapłać 500 PLN dziś"),
  });
  const SUSPECT =
    "It asks for money from an address you have never written to. It may not be genuine.";
  const stranger = (over: Partial<ThingSignals> = {}) => signals({ wroteToSender: false, ...over });

  it("marks a request for money from a free-mail address nobody wrote to", () => {
    const t = first(pay, stranger({ freeMail: true }));
    expect(t?.suspect).toBe(true);
    expect(t?.now).toBeUndefined();
    expect(t?.why).toContain(SUSPECT);
    // It still shows.
    expect(t).toBeDefined();
  });

  it("marks money asked of the person on the old path too, and a failed sender check", () => {
    const onYou = reading({ state: "onYou", stakes: "money", facts: [fact()] });
    expect(first(onYou, stranger({ freeMail: true }))?.suspect).toBe(true);
    expect(first(onYou, stranger({ authFailed: true }))?.suspect).toBe(true);
  });

  it("does not mark mail from someone the person knows, or that asks nothing of the kind", () => {
    expect(first(pay, signals({ wroteToSender: true, freeMail: true }))?.suspect).toBeUndefined();
    expect(first(pay, stranger({ freeMail: true, wroteToCompany: true }))?.suspect).toBeUndefined();
    expect(first(pay, stranger())?.suspect).toBeUndefined();
    const reply = reading({ intent: "reply", intentEvidence: ev("Odpowiedz") });
    expect(first(reply, stranger({ freeMail: true }))?.suspect).toBeUndefined();
    expect(
      first(reading({ state: "onYou", facts: [fact()] }), stranger({ freeMail: true }))?.suspect,
    ).toBeUndefined();
  });

  it("warns on a failed sender check alone, and leaves its place and section (ADR 0079)", () => {
    const reply = reading({ intent: "reply", intentEvidence: ev("Odpowiedz do piątku") });
    const plain = first(reply, signals({ wroteToSender: true }));
    const failed = first(reply, signals({ wroteToSender: true, authFailed: true }));
    expect(failed?.unverified).toBe(true);
    expect(failed?.suspect).toBeUndefined();
    expect(failed?.why).toContain("The sender's domain did not confirm it sent this mail.");
    expect(failed?.now).toBe(plain?.now);
    expect(failed?.score).toBe(plain?.score);
  });

  it("says it once: a thing suspect for other reasons is not also marked unverified", () => {
    const t = first(pay, stranger({ authFailed: true }));
    expect(t?.suspect).toBe(true);
    expect(t?.unverified).toBeUndefined();
  });

  it("goes after the rest, with the stale, whatever it scores", () => {
    const list = rankThings(
      [
        entry(pay, stranger({ freeMail: true }), "x@gmail.com"),
        entry(
          reading({ threadId: "t2", state: "waiting", facts: [fact({ who: "them" })] }),
          signals({}, 5),
        ),
      ],
      [],
      NOW,
    );
    expect(list.map((t) => t.threadId)).toEqual(["t2", "t1"]);
    expect(list[1]?.suspect).toBe(true);
  });
});

// --- Choosing threads ---

describe("selectCandidates keeps service mail from programs (ADR 0066, rule 6)", () => {
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

  it("keeps a no-reply payment notice and drops a no-reply newsletter", () => {
    const picked = selectCandidates(
      [
        candidate({ threadId: "invoice", subject: "Faktura FV/17/2026 do opłacenia" }),
        candidate({ threadId: "news", subject: "Nowości w naszym sklepie" }),
        candidate({ threadId: "bare" }),
        candidate({
          threadId: "listed",
          subject: "Your payment is overdue",
          messages: [{ from: "billing@shop.example", automated: true }],
        }),
        candidate({
          threadId: "digest",
          subject: "Ten things we liked",
          messages: [{ from: "messaging-digest-noreply@shop.example" }],
        }),
      ],
      options,
    );
    expect(picked.map((t) => t.threadId).sort()).toEqual(["invoice", "listed"]);
  });
});
