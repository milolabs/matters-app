// ADR 0116, rule 4b, on the page: a ranked order without a prompt is computed only after `↵`,
// its line says how, editing the text goes back to the dated list, and a prompt's rows by date
// keep their day headings.
import type { BackendEvent } from "@matters/contracts";
import { type Message, parseQuery, type SortRanked } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/renderer/client.ts";
import {
  createSortRun,
  rankedSortOf,
  SORT_FAILED,
  SORT_READY,
  SORTING,
  sortedText,
} from "../src/renderer/sortRun.ts";
import { createMailStore } from "../src/renderer/store.ts";

const msg = (key: number, threadId = `t${key}`): Message =>
  makeMessage({ key, providerId: `p${key}`, threadId, dateMs: key * 1000 });

const ranked = (over: Partial<SortRanked> = {}): SortRanked => ({
  sort: "relevance",
  rows: [msg(3), msg(9), msg(5)],
  pool: 3,
  matches: 3,
  ...over,
});

function rig(answer: (q: string) => Promise<SortRanked> = async () => ranked()) {
  const listeners = new Set<(e: BackendEvent) => void>();
  const timers: (() => void)[] = [];
  const sortRanked = vi.fn(answer);
  const backend = {
    sortRanked,
    onEvent(l: (e: BackendEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as Backend;
  const run = createSortRun(backend, {
    schedule: (fn) => {
      timers.push(fn);
      return () => {};
    },
  });
  const emit = (e: BackendEvent) => {
    for (const l of listeners) l(e);
  };
  return { run, sortRanked, emit, timers };
}

describe("a ranked order without a prompt (ADR 0116, rule 4b)", () => {
  it("is asked for by relevance only, and only without a prompt", () => {
    expect(rankedSortOf(parseQuery("invoice sort:relevance"))).toBe("relevance");
    expect(rankedSortOf(parseQuery("sort:relevance"))).toBeNull();
    expect(rankedSortOf(parseQuery("invoice sort:oldest"))).toBeNull();
    expect(rankedSortOf(parseQuery('invoice sort:relevance prompt:"x"'))).toBeNull();
  });

  it("asks nothing while typing; ↵ computes it, and other text goes back to the dated list", async () => {
    const r = rig();
    r.run.setQuery("invoice sort:relevance", "relevance");
    expect(r.sortRanked).not.toHaveBeenCalled();
    expect(r.run.rows()).toBeNull();
    expect(r.run.line()).toEqual({ kind: "ready", text: SORT_READY });
    expect(SORT_READY).toBe("↵ to sort by relevance.");
    const done = r.run.run();
    expect(r.run.line()).toEqual({ kind: "sorting", text: SORTING });
    await done;
    expect(r.sortRanked).toHaveBeenCalledWith("invoice sort:relevance");
    expect(r.run.rows()?.map((m) => m.key)).toEqual([3, 9, 5]);
    expect(r.run.line()).toEqual({ kind: "sorted", text: "Sorted by relevance." });
    r.run.setQuery("invoice sort:relevance x", "relevance");
    expect(r.run.rows()).toBeNull();
    expect(r.run.line()?.kind).toBe("ready");
    r.run.setQuery("invoice", null);
    expect(r.run.line()).toBeNull();
  });

  it("drops an answer for text no longer in the bar, and says when it failed", async () => {
    let release: (v: SortRanked) => void = () => {};
    const r = rig(() => new Promise((res) => (release = res)));
    r.run.setQuery("a sort:relevance", "relevance");
    const done = r.run.run();
    r.run.setQuery("b sort:relevance", "relevance");
    release(ranked());
    await done;
    expect(r.run.rows()).toBeNull();
    const failing = rig(async () => {
      throw new Error("down");
    });
    failing.run.setQuery("a sort:relevance", "relevance");
    await failing.run.run();
    expect(failing.run.line()).toEqual({ kind: "problem", text: SORT_FAILED });
  });

  it("computes the order again after mail changed under it, after a quiet moment", async () => {
    const r = rig();
    r.run.setQuery("a sort:relevance", "relevance");
    r.emit({ type: "changes", changeSeq: 1, changedKeys: [1], removedKeys: [] });
    expect(r.timers).toHaveLength(0);
    await r.run.run();
    r.emit({ type: "changes", changeSeq: 2, changedKeys: [1], removedKeys: [] });
    expect(r.timers).toHaveLength(1);
    r.timers[0]?.();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sortRanked).toHaveBeenCalledTimes(2);
  });

  it("says on one line how it sorted, and when the pool cut the matches", () => {
    expect(sortedText(ranked({ pool: 2000, matches: 14_300 }))).toBe(
      "Sorted by relevance, newest 2,000 of 14,300.",
    );
    expect(sortedText(ranked({ pool: 2000, matches: 50_000, more: true }))).toBe(
      "Sorted by relevance, newest 2,000 of 50,000+.",
    );
    expect(sortedText(ranked())).toBe("Sorted by relevance.");
    // The 380 px column holds about 56 characters of the line.
    expect(
      sortedText(ranked({ pool: 2000, matches: 50_000, more: true })).length,
    ).toBeLessThanOrEqual(56);
  });
});

describe("rows in an order of their own, in the list (ADR 0116, rule 4b)", () => {
  const backend = {
    async listNewest() {
      return { messages: [msg(1), msg(2)] };
    },
    async search() {
      return { messages: [msg(1), msg(2)] };
    },
    async openThread() {
      return null;
    },
  } as unknown as Backend;

  it("by date, keep their headings; ranked, have none; other text goes back to the dated list", async () => {
    const store = createMailStore(backend);
    await store.start();
    store.setQuery('x prompt:"y" sort:newest');
    store.showOrdered('x prompt:"y" sort:newest', [msg(9), msg(4)], true);
    expect(store.ordered()).toBe(true);
    expect(store.orderedDated()).toBe(true);
    store.setQuery("x sort:relevance");
    expect(store.ordered()).toBe(false);
    expect(store.orderedDated()).toBe(false);
    store.showOrdered("x sort:relevance", [msg(4), msg(9)]);
    expect(store.ordered()).toBe(true);
    expect(store.orderedDated()).toBe(false);
    expect(store.messages().map((m) => m.key)).toEqual([4, 9]);
    store.showOrdered("x sort:relevance", null);
    expect(store.ordered()).toBe(false);
  });
});
