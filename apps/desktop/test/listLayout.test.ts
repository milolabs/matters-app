import { describe, expect, it } from "vitest";
import {
  bucketLabel,
  dayBucket,
  HEAD_HEIGHT,
  itemAt,
  layoutList,
  ROW_HEIGHT,
} from "../src/renderer/listLayout.ts";

// Wednesday 4 November 2026, noon local time.
const NOW = new Date(2026, 10, 4, 12).getTime();
const at = (month: number, day: number, hour = 9) => new Date(2026, month, day, hour).getTime();

describe("dayBucket", () => {
  it("names today, yesterday, the rest of the week, then months", () => {
    expect(dayBucket(at(10, 4, 1), NOW)).toBe("today");
    expect(dayBucket(at(10, 5), NOW)).toBe("today");
    expect(dayBucket(at(10, 3, 23), NOW)).toBe("yesterday");
    expect(dayBucket(at(10, 2), NOW)).toBe("week");
    expect(dayBucket(at(10, 1), NOW)).toBe("m2026-10");
    expect(bucketLabel("m2026-9", NOW)).toBe("October");
    expect(bucketLabel("m2025-9", NOW)).toBe("October 2025");
  });
});

describe("layoutList", () => {
  const messages = [at(10, 4), at(10, 4), at(10, 3), at(9, 20)].map((dateMs) => ({ dateMs }));

  it("puts a heading before each day and keeps offsets fixed by kind", () => {
    const l = layoutList(messages, NOW);
    expect(l.items.map((i) => (i.kind === "head" ? i.label : i.index))).toEqual([
      "Today",
      0,
      1,
      "Yesterday",
      2,
      "October",
      3,
    ]);
    expect(l.rowItem).toEqual([1, 2, 4, 6]);
    expect(l.starts[4]).toBe(2 * HEAD_HEIGHT + 2 * ROW_HEIGHT);
    expect(l.total).toBe(3 * HEAD_HEIGHT + 4 * ROW_HEIGHT);
  });

  it("tops search results with one heading", () => {
    const l = layoutList(messages, NOW, "Results");
    expect(l.items.filter((i) => i.kind === "head")).toHaveLength(1);
    expect(layoutList([], NOW, "Results").items).toEqual([]);
  });

  it("finds the item under an offset", () => {
    const l = layoutList(messages, NOW);
    expect(itemAt(l, 0)).toBe(0);
    expect(itemAt(l, HEAD_HEIGHT)).toBe(1);
    expect(itemAt(l, HEAD_HEIGHT + ROW_HEIGHT - 1)).toBe(1);
    expect(itemAt(l, l.total + 100)).toBe(l.items.length - 1);
  });
});
