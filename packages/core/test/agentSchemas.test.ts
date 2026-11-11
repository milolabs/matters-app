import { describe, expect, it } from "vitest";
import {
  MAX_REASON_CHARS,
  PREPARED_DRAFT_SCHEMA,
  PREPARED_GUIDED_SCHEMA,
  PREPARED_SCHEMA,
  parsePreparedAnswer,
} from "../src/index.ts";

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
