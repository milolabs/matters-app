import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SCHEMA,
  MAX_REASON_CHARS,
  PREPARED_DRAFT_SCHEMA,
  PREPARED_GUIDED_SCHEMA,
  PREPARED_SCHEMA,
  parseAnalysisAnswer,
  parsePreparedAnswer,
} from "../src/index.ts";

const fact = {
  kind: "promise",
  who: "you",
  message: 2,
  quote: "I will send it",
  due: "2026-11-10",
};
const answer = {
  state: "onYou",
  headline: "Send the offer",
  facts: [fact],
  stakes: "money",
  confidence: 0.8,
  intent: "reply",
  intentQuote: "I will send it",
  forYou: "generic",
  status: "open",
  category: "other",
};

describe("parseAnalysisAnswer", () => {
  it("accepts a well-formed answer, with or without a date", () => {
    expect(parseAnalysisAnswer(answer)).toEqual(answer);
    const { due: _, ...bare } = fact;
    expect(parseAnalysisAnswer({ ...answer, facts: [bare] })?.facts[0]).toEqual(bare);
    expect(parseAnalysisAnswer({ ...answer, facts: [], state: "none" })).not.toBeNull();
  });

  it("rejects extra keys at both levels", () => {
    expect(parseAnalysisAnswer({ ...answer, extra: 1 })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, extra: 1 }] })).toBeNull();
  });

  it("rejects missing keys and wrong types", () => {
    const { stakes: _, ...noStakes } = answer;
    expect(parseAnalysisAnswer(noStakes)).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, headline: 3 })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: "none" })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, message: "2" }] })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, message: 1.5 }] })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, message: 0 }] })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, due: 5 }] })).toBeNull();
    expect(parseAnalysisAnswer(null)).toBeNull();
    expect(parseAnalysisAnswer([answer])).toBeNull();
    expect(parseAnalysisAnswer("onYou")).toBeNull();
  });

  it("rejects unknown enum values", () => {
    expect(parseAnalysisAnswer({ ...answer, state: "urgent" })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, stakes: "love" })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, who: "me" }] })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, kind: "threat" }] })).toBeNull();
  });

  it("rejects confidence outside 0 to 1, NaN included", () => {
    for (const confidence of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "0.9"]) {
      expect(parseAnalysisAnswer({ ...answer, confidence })).toBeNull();
    }
    expect(parseAnalysisAnswer({ ...answer, confidence: 0 })).not.toBeNull();
    expect(parseAnalysisAnswer({ ...answer, confidence: 1 })).not.toBeNull();
  });

  it("rejects blank strings and too many facts", () => {
    expect(parseAnalysisAnswer({ ...answer, headline: "   " })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: [{ ...fact, quote: " \n" }] })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, facts: Array(13).fill(fact) })).toBeNull();
  });

  it("is described by a schema that forbids extra keys", () => {
    expect(ANALYSIS_SCHEMA.additionalProperties).toBe(false);
    expect(ANALYSIS_SCHEMA.properties.facts.items.additionalProperties).toBe(false);
    expect(ANALYSIS_SCHEMA.properties.amount.additionalProperties).toBe(false);
  });

  it("requires the reading of ADR 0066: intent, its quote, forYou and status", () => {
    for (const key of ["intent", "intentQuote", "forYou", "status", "category"] as const) {
      expect(ANALYSIS_SCHEMA.required).toContain(key);
      const { [key]: _, ...without } = answer;
      expect(parseAnalysisAnswer(without)).toBeNull();
    }
    expect(ANALYSIS_SCHEMA.required).not.toContain("amount");
    expect(ANALYSIS_SCHEMA.required).not.toContain("windowEnd");
  });

  it("rejects unknown intent, forYou, status and amount role", () => {
    expect(parseAnalysisAnswer({ ...answer, intent: "panic" })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, forYou: "maybe" })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, status: "finished" })).toBeNull();
    const amount = { value: 1090, currency: "pln", role: "price", quote: "1090 PLN" };
    expect(parseAnalysisAnswer({ ...answer, amount: { ...amount, role: "gift" } })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, amount: { ...amount, currency: "zloty" } })).toBeNull();
    expect(parseAnalysisAnswer({ ...answer, amount: { ...amount, extra: 1 } })).toBeNull();
  });

  it("accepts an amount, a window end and a personal passage, and upper-cases the currency", () => {
    const parsed = parseAnalysisAnswer({
      ...answer,
      intent: "decide",
      amount: { value: 1090, currency: "pln", role: "price", quote: "1090 PLN" },
      windowEnd: "2026-12-31",
      forYou: "specific",
      forYouQuote: "your 2025 tax return",
    });
    expect(parsed).toMatchObject({
      intent: "decide",
      amount: { value: 1090, currency: "PLN", role: "price", quote: "1090 PLN" },
      windowEnd: "2026-12-31",
      forYou: "specific",
      forYouQuote: "your 2025 tax return",
    });
  });

  it("lets the quote of an intent be empty at this level; acceptAnalysis decides what it means", () => {
    expect(parseAnalysisAnswer({ ...answer, intent: "none", intentQuote: "" })).not.toBeNull();
  });
});

describe("parsePreparedAnswer", () => {
  it("accepts a draft and a question", () => {
    const draft = { kind: "draft", body: "Hi Anna,\n\nTomorrow.", nudge: false };
    const needs = {
      kind: "needs",
      missing: "The price",
      directions: ["Ask Anna", "Offer a range"],
    };
    expect(parsePreparedAnswer(draft)).toEqual(draft);
    expect(parsePreparedAnswer(needs)).toEqual(needs);
    expect(parsePreparedAnswer({ ...needs, directions: [] })).not.toBeNull();
  });

  it("rejects more than three directions", () => {
    const needs = { kind: "needs", missing: "x", directions: ["a", "b", "c", "d"] };
    expect(parsePreparedAnswer(needs)).toBeNull();
  });

  it("rejects blank text and blank directions", () => {
    expect(parsePreparedAnswer({ kind: "draft", body: " ", nudge: true })).toBeNull();
    expect(parsePreparedAnswer({ kind: "needs", missing: "", directions: [] })).toBeNull();
    expect(parsePreparedAnswer({ kind: "needs", missing: "x", directions: [" "] })).toBeNull();
  });

  it("rejects keys of the other kind, extra keys and wrong types", () => {
    expect(parsePreparedAnswer({ kind: "draft", body: "x", nudge: true, missing: "y" })).toBeNull();
    expect(
      parsePreparedAnswer({ kind: "needs", missing: "x", directions: [], body: "y" }),
    ).toBeNull();
    expect(parsePreparedAnswer({ kind: "draft", body: "x" })).toBeNull();
    expect(parsePreparedAnswer({ kind: "draft", body: "x", nudge: "no" })).toBeNull();
    expect(parsePreparedAnswer({ kind: "needs", missing: "x", directions: "a" })).toBeNull();
    expect(parsePreparedAnswer({ kind: "needs", missing: "x", directions: [1] })).toBeNull();
    expect(parsePreparedAnswer({ kind: "other" })).toBeNull();
    expect(parsePreparedAnswer(null)).toBeNull();
  });

  it("is described by a schema that forbids extra keys", () => {
    expect(PREPARED_SCHEMA.additionalProperties).toBe(false);
    expect(PREPARED_SCHEMA.properties.directions.maxItems).toBe(3);
  });

  it("accepts closed with a reason, and nothing else", () => {
    const closed = { kind: "closed", reason: "An automatic notification" };
    expect(parsePreparedAnswer(closed)).toEqual(closed);
    expect(parsePreparedAnswer({ ...closed, body: "x" })).toBeNull();
    expect(parsePreparedAnswer({ ...closed, nudge: false })).toBeNull();
    expect(parsePreparedAnswer({ kind: "closed" })).toBeNull();
    expect(parsePreparedAnswer({ kind: "closed", reason: "" })).toBeNull();
    expect(parsePreparedAnswer({ kind: "closed", reason: "  " })).toBeNull();
    expect(parsePreparedAnswer({ kind: "closed", reason: 3 })).toBeNull();
    expect(
      parsePreparedAnswer({ kind: "closed", reason: "x".repeat(MAX_REASON_CHARS) }),
    ).not.toBeNull();
    expect(
      parsePreparedAnswer({ kind: "closed", reason: "x".repeat(MAX_REASON_CHARS + 1) }),
    ).toBeNull();
  });

  it("offers closed only in the schema for the person's own words", () => {
    expect(PREPARED_SCHEMA.properties.kind.enum).toEqual(["draft", "needs"]);
    expect(PREPARED_DRAFT_SCHEMA.properties.kind.enum).toEqual(["draft"]);
    expect(PREPARED_GUIDED_SCHEMA.properties.kind.enum).toEqual(["draft", "closed"]);
    expect(PREPARED_GUIDED_SCHEMA.required).toEqual(["kind"]);
    expect(PREPARED_GUIDED_SCHEMA.additionalProperties).toBe(false);
    expect(PREPARED_GUIDED_SCHEMA.properties.reason.maxLength).toBe(MAX_REASON_CHARS);
    expect(JSON.stringify(PREPARED_SCHEMA)).not.toContain("closed");
    expect(JSON.stringify(PREPARED_DRAFT_SCHEMA)).not.toContain("closed");
  });
});

describe("the category of a reading (ADR 0068)", () => {
  it("reads a kind it does not know as other, and insists that the key is there", () => {
    expect(parseAnalysisAnswer({ ...answer, category: "teleportation" })?.category).toBe("other");
    expect(parseAnalysisAnswer({ ...answer, category: "official" })?.category).toBe("official");
    expect(parseAnalysisAnswer({ ...answer, category: 3 })).toBeNull();
    expect(ANALYSIS_SCHEMA.properties.category.enum).toContain("paymentProblem");
  });
});
