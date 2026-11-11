import { type PromiseLine, promiseLines } from "@matters/core";
import { describe, expect, it } from "vitest";
import { lineLabel, lineLead, linesByMessage, lineTrail } from "../src/renderer/promiseRows.ts";

const now = Date.UTC(2026, 10, 8, 10);
const day = (m: number, d: number) => Date.UTC(2026, m - 1, d);
const lineOf = (
  kind: "promise" | "ask",
  who: "you" | "them",
  dueMs?: number,
  messageKey = 1,
): PromiseLine => {
  const [line] = promiseLines(
    [{ kind, who, quote: "the report", messageKey, ...(dueMs === undefined ? {} : { dueMs }) }],
    now,
  );
  return line as PromiseLine;
};

describe("the words of a promise line (ADR 0075)", () => {
  it("names who is on the hook and whether it was promised or asked", () => {
    expect(lineLead(lineOf("promise", "you"))).toBe("You promised");
    expect(lineLead(lineOf("promise", "them"))).toBe("Promised");
    expect(lineLead(lineOf("ask", "you"))).toBe("Asks you");
    expect(lineLead(lineOf("ask", "them"))).toBe("You asked");
  });

  it("says how late, or the date and what is left, or nothing", () => {
    expect(lineTrail(lineOf("promise", "you", day(11, 4)), now)).toBe("4 days late");
    expect(lineTrail(lineOf("promise", "you", day(11, 7)), now)).toBe("1 day late");
    expect(lineTrail(lineOf("promise", "you", day(11, 12)), now)).toBe("by 12 Nov · 4 days left");
    expect(lineTrail(lineOf("promise", "you", day(11, 9)), now)).toBe("by 9 Nov · 1 day left");
    expect(lineTrail(lineOf("promise", "you", day(11, 8)), now)).toBe("by 8 Nov · today");
    expect(lineTrail(lineOf("promise", "you"), now)).toBe("");
  });

  it("reads the line as one sentence", () => {
    expect(lineLabel(lineOf("ask", "you", day(11, 4)), now)).toBe(
      "Asks you „the report”, 4 days late",
    );
    expect(lineLabel(lineOf("promise", "them"), now)).toBe("Promised „the report”");
  });

  it("groups lines by message and keeps their order", () => {
    const a = lineOf("promise", "you", day(11, 20), 2);
    const b = lineOf("ask", "you", undefined, 2);
    const c = lineOf("promise", "them", undefined, 5);
    const map = linesByMessage([a, b, c]);
    expect(map.get(2)).toEqual([a, b]);
    expect(map.get(5)).toEqual([c]);
    expect(map.has(3)).toBe(false);
  });
});
