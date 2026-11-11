import { describe, expect, it } from "vitest";
import { readablePieces } from "../src/renderer/body.ts";
import { countHits } from "../src/renderer/hits.ts";
import {
  letterMatches,
  locate,
  matchLabel,
  planReveal,
  stepMatch,
  totalMatches,
} from "../src/renderer/matchNav.ts";
import { createRowHits, ROW_CACHE_MAX } from "../src/renderer/rowHits.ts";

const slots = [
  { key: 1, count: 2 },
  { key: 2, count: 0 },
  { key: 3, count: 3 },
];

describe("locate and totals", () => {
  it("numbers matches through the letters", () => {
    expect(totalMatches(slots)).toBe(5);
    expect(locate(slots, 0)).toEqual({ key: 1, ordinal: 0 });
    expect(locate(slots, 1)).toEqual({ key: 1, ordinal: 1 });
    expect(locate(slots, 2)).toEqual({ key: 3, ordinal: 0 });
    expect(locate(slots, 4)).toEqual({ key: 3, ordinal: 2 });
    expect(locate(slots, 5)).toBeNull();
    expect(locate(slots, -1)).toBeNull();
  });
});

describe("stepMatch", () => {
  it("starts at the first going forwards and the last going back", () => {
    expect(stepMatch(-1, 1, 5)).toBe(0);
    expect(stepMatch(-1, -1, 5)).toBe(4);
  });
  it("wraps in both directions", () => {
    expect(stepMatch(4, 1, 5)).toBe(0);
    expect(stepMatch(0, -1, 5)).toBe(4);
    expect(stepMatch(2, 1, 5)).toBe(3);
    expect(stepMatch(2, -1, 5)).toBe(1);
  });
  it("has nowhere to go without matches", () => {
    expect(stepMatch(-1, 1, 0)).toBe(-1);
    expect(stepMatch(3, -1, 0)).toBe(-1);
  });
});

describe("planReveal", () => {
  it("unfolds a run and opens the letter in it", () => {
    expect(planReveal(7, { folded: new Set([6, 7]), open: new Set([9]) })).toEqual({
      unfold: true,
      open: true,
    });
  });
  it("opens a collapsed letter and leaves an open one alone", () => {
    expect(planReveal(3, { folded: new Set(), open: new Set([9]) })).toEqual({
      unfold: false,
      open: true,
    });
    expect(planReveal(9, { folded: new Set(), open: new Set([9]) })).toEqual({
      unfold: false,
      open: false,
    });
  });
});

describe("matchLabel", () => {
  it("says how many, then where", () => {
    expect(matchLabel(-1, 0)).toBe("");
    expect(matchLabel(-1, 1)).toBe("1 match");
    expect(matchLabel(-1, 4)).toBe("4 matches");
    expect(matchLabel(1, 4)).toBe("2 of 4");
  });
});

describe("letterMatches", () => {
  const body = [
    "Faktura 12 jest w załączniku, faktura korygująca później.",
    "Zobacz https://example.com/faktura/12 też.",
    "",
    "> faktura w cytacie",
    "",
    "-- ",
    "Jan, faktury",
  ].join("\n");

  it("counts what the reader marks and leaves quoted text out", () => {
    // two in the first line, one in the link text, one in the short signature ("faktury" starts with faktura? no)
    expect(readablePieces(body).join("|")).not.toContain("w cytacie");
    expect(letterMatches(body, ["faktura"])).toBe(3);
  });

  it("is the sum of the places the highlighter marks in the same pieces", () => {
    const pieces = readablePieces(body);
    expect(pieces.length).toBeGreaterThan(1);
    expect(letterMatches(body, ["faktur"])).toBeGreaterThanOrEqual(
      pieces.reduce((n, p) => n + countHits(p, ["faktura"]), 0),
    );
  });

  it("is zero without words or text", () => {
    expect(letterMatches(body, [])).toBe(0);
    expect(letterMatches("", ["faktura"])).toBe(0);
  });

  it("does not count a long signature that stays folded", () => {
    const long = ["Hi", "", "-- ", "a", "b", "c", "d", "faktura"].join("\n");
    expect(letterMatches(long, ["faktura"])).toBe(0);
  });
});

describe("rowHits", () => {
  const msg = (key: number, subject = "Faktura 12", snippet = "w załączniku") => ({
    key,
    subject,
    snippet,
  });

  it("does no work and keeps nothing without words", () => {
    const rows = createRowHits();
    expect(rows.of(msg(1), [])).toBeNull();
    expect(rows.size).toBe(0);
  });

  it("cuts a message once per query", () => {
    const rows = createRowHits();
    const a = rows.of(msg(1), ["faktura"]);
    expect(a?.subject.map((s) => s.hit)).toEqual([true, false]);
    expect(rows.of(msg(1), ["faktura"])).toBe(a);
    expect(rows.of(msg(1), ["zalacznik"])).not.toBe(a);
    expect(rows.size).toBe(1);
  });

  it("notices a message whose text changed, and stays bounded", () => {
    const rows = createRowHits();
    const a = rows.of(msg(1), ["faktura"]);
    expect(rows.of(msg(1, "Re: Faktura 12"), ["faktura"])).not.toBe(a);
    for (let i = 0; i < ROW_CACHE_MAX + 50; i++) rows.of(msg(i), ["faktura"]);
    expect(rows.size).toBeLessThanOrEqual(ROW_CACHE_MAX);
  });

  it("names an empty subject the way the list does", () => {
    const rows = createRowHits();
    expect(
      rows
        .of(msg(1, "  "), ["subject"])
        ?.subject.map((s) => s.text)
        .join(""),
    ).toBe("(no subject)");
  });
});
