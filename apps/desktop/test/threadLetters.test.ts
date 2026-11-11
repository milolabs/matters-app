import { describe, expect, it } from "vitest";
import { type FoldInput, foldRun, sameRun } from "../src/renderer/threadLetters.ts";

const closed = (dateMs: number): FoldInput => ({ open: false, dateMs });
const open = (dateMs: number): FoldInput => ({ open: true, dateMs });

describe("foldRun", () => {
  it("folds nothing for fewer than three collapsed before the first open", () => {
    expect(foldRun([])).toBeNull();
    expect(foldRun([open(1)])).toBeNull();
    expect(foldRun([closed(1), open(2)])).toBeNull();
    expect(foldRun([closed(1), closed(2), open(3)])).toBeNull();
  });

  it("keeps the first and folds the rest of a run of three", () => {
    const run = foldRun([closed(10), closed(20), closed(30), open(40)]);
    expect(run).toEqual({ start: 1, end: 3, count: 2, fromMs: 20, toMs: 30 });
  });

  it("folds a long run and gives the date range of the folded ones", () => {
    const run = foldRun([closed(5), closed(9), closed(7), closed(8), closed(12), open(20)]);
    expect(run).toEqual({ start: 1, end: 5, count: 4, fromMs: 7, toMs: 12 });
  });

  it("counts a run that has no open letter after it", () => {
    expect(foldRun([closed(1), closed(2), closed(3)])?.count).toBe(2);
  });

  it("does not fold collapsed letters after the first open one", () => {
    expect(foldRun([open(1), closed(2), closed(3), closed(4), closed(5)])).toBeNull();
    const run = foldRun([
      closed(1),
      closed(2),
      closed(3),
      open(4),
      closed(5),
      closed(6),
      closed(7),
    ]);
    expect(run?.end).toBe(3);
  });

  it("compares runs", () => {
    const a = foldRun([closed(1), closed(2), closed(3), open(4)]);
    expect(sameRun(a, foldRun([closed(1), closed(2), closed(3), open(4)]))).toBe(true);
    expect(sameRun(a, null)).toBe(false);
    expect(sameRun(null, null)).toBe(true);
  });
});
