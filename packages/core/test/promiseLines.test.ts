import { describe, expect, it } from "vitest";
import {
  openSummary,
  promiseLines,
  type ThreadFactView,
  trimQuote,
} from "../src/domain/promiseLines.ts";

const day = (m: number, d: number, y = 2026) => Date.UTC(y, m - 1, d);
const fact = (over: Partial<ThreadFactView> = {}): ThreadFactView => ({
  kind: "promise",
  who: "you",
  quote: "I will send the report",
  messageKey: 1,
  ...over,
});

describe("promiseLines", () => {
  const noon = Date.UTC(2026, 10, 12, 12);

  it("marks undated, open and late", () => {
    const lines = promiseLines(
      [
        fact({ messageKey: 1 }),
        fact({ messageKey: 2, dueMs: day(11, 12) }),
        fact({ messageKey: 3, dueMs: day(11, 8) }),
      ],
      noon,
    );
    expect(lines.map((l) => l.status)).toEqual(["undated", "open", "late"]);
    expect(lines[1]).toMatchObject({ daysLeft: 0, dueMs: day(11, 12) });
    expect(lines[2]).toMatchObject({ daysLate: 4 });
  });

  it("counts a date as due until its day ends, like the list does", () => {
    const due = [fact({ dueMs: day(11, 12) })];
    expect(promiseLines(due, Date.UTC(2026, 10, 12, 23, 59, 59))[0]?.status).toBe("open");
    const next = promiseLines(due, Date.UTC(2026, 10, 13, 0, 0, 0))[0];
    expect(next).toMatchObject({ status: "late", daysLate: 1 });
    expect(promiseLines(due, Date.UTC(2026, 10, 14, 0, 0, 0))[0]).toMatchObject({ daysLate: 2 });
  });

  it("reads today in the given time zone (Europe/Warsaw)", () => {
    const due = [fact({ dueMs: day(11, 12) })];
    // 23:30 UTC on the 12th is 00:30 on the 13th in Warsaw (UTC+1 in November).
    const now = Date.UTC(2026, 10, 12, 23, 30);
    expect(promiseLines(due, now)[0]?.status).toBe("open");
    expect(promiseLines(due, now, "Europe/Warsaw")[0]).toMatchObject({
      status: "late",
      daysLate: 1,
    });
    // 22:30 UTC is still the 12th in Warsaw.
    expect(promiseLines(due, Date.UTC(2026, 10, 12, 22, 30), "Europe/Warsaw")[0]).toMatchObject({
      status: "open",
      daysLeft: 0,
    });
  });

  it("counts days left across a summer-time change", () => {
    const due = [fact({ dueMs: day(10, 27) })];
    // Warsaw leaves summer time on 25 Oct 2026.
    const now = Date.UTC(2026, 9, 24, 23, 30); // 01:30 on the 25th in Warsaw
    expect(promiseLines(due, now, "Europe/Warsaw")[0]).toMatchObject({
      status: "open",
      daysLeft: 2,
    });
  });

  it("sorts by message, then by due date with the undated last", () => {
    const lines = promiseLines(
      [
        fact({ messageKey: 2, quote: "b-undated" }),
        fact({ messageKey: 2, quote: "b-late", dueMs: day(11, 1) }),
        fact({ messageKey: 1, quote: "a-undated" }),
        fact({ messageKey: 2, quote: "b-soon", dueMs: day(11, 20) }),
        fact({ messageKey: 2, quote: "b-sooner", dueMs: day(11, 14) }),
      ],
      noon,
    );
    expect(lines.map((l) => l.quote)).toEqual([
      "a-undated",
      "b-late",
      "b-sooner",
      "b-soon",
      "b-undated",
    ]);
  });

  it("keeps who and kind", () => {
    const [line] = promiseLines([fact({ kind: "ask", who: "them" })], noon);
    expect(line).toMatchObject({ kind: "ask", who: "them", messageKey: 1 });
  });

  it("is empty without facts", () => {
    expect(promiseLines([], noon)).toEqual([]);
    expect(openSummary([], noon)).toEqual([]);
  });
});

describe("trimQuote", () => {
  it("keeps six words and marks the cut", () => {
    expect(trimQuote("one two three")).toBe("one two three");
    expect(trimQuote("one two three four five six")).toBe("one two three four five six");
    expect(trimQuote("one two three four five six seven")).toBe("one two three four five six…");
    expect(trimQuote("  spaced   out \n words ")).toBe("spaced out words");
  });
});

describe("openSummary", () => {
  const now = Date.UTC(2026, 10, 8, 10);

  it("says whose promise it is, with the date or the days late", () => {
    const parts = openSummary(
      [
        fact({ who: "them", quote: "refund", dueMs: day(11, 12), messageKey: 1 }),
        fact({ who: "you", quote: "damage report", dueMs: day(11, 4), messageKey: 2 }),
      ],
      now,
    );
    expect(parts).toEqual([
      { text: "your promise „damage report”, 4 days late", late: true },
      { text: "their promise „refund”, by 12 Nov", late: false },
    ]);
  });

  it("puts late first, then by due date, undated last, and keeps two", () => {
    const parts = openSummary(
      [
        fact({ quote: "undated" }),
        fact({ quote: "later", dueMs: day(11, 30) }),
        fact({ quote: "sooner", dueMs: day(11, 10) }),
        fact({ quote: "late", dueMs: day(11, 7) }),
      ],
      now,
    );
    expect(parts.map((p) => p.text)).toEqual([
      "your promise „late”, 1 day late",
      "your promise „sooner”, by 10 Nov",
    ]);
  });

  it("gives an undated fact no date and a long quote an ellipsis", () => {
    const [part] = openSummary(
      [fact({ who: "them", quote: "we will ship the parcel by courier on Monday" })],
      now,
    );
    expect(part).toEqual({ text: "their promise „we will ship the parcel by…”", late: false });
  });

  it("calls an ask a request and gives it to the side that asked", () => {
    // `who` is who is on the hook: an ask on the person was made by the other side.
    const [theirs] = openSummary(
      [fact({ kind: "ask", who: "you", quote: "Czy możemy przesunąć spotkanie?" })],
      now,
    );
    expect(theirs).toEqual({
      text: "their request „Czy możemy przesunąć spotkanie?”",
      late: false,
    });
    const [yours] = openSummary(
      [fact({ kind: "ask", who: "them", quote: "Proszę o fakturę" })],
      now,
    );
    expect(yours).toEqual({ text: "your request „Proszę o fakturę”", late: false });
  });

  it("names the year when the date is in another year", () => {
    const [part] = openSummary([fact({ dueMs: day(1, 5, 2027) })], now);
    expect(part?.text).toBe("your promise „I will send the report”, by 5 Jan 2027");
  });
});
