import type { ThingBundle } from "@matters/core";
import { describe, expect, it } from "vitest";
import { matterRows, matterSummary, pathOf, railAt } from "../src/renderer/matterMap.ts";

const bundle = (ids: readonly string[], edges: readonly [string, string][] = []): ThingBundle => ({
  id: "m",
  name: "Matter",
  members: ids.map((threadId) => ({ threadId, who: threadId.toUpperCase(), headline: threadId })),
  edges: edges.map(([blocker, blocked]) => ({ blocker, blocked, quote: `${blocker}-${blocked}` })),
});
const shape = (b: ThingBundle) => matterRows(b).map((r) => `${r.threadId}:${r.depth}`);

describe("a matter as an order of work (ADR 0059, rule 5)", () => {
  it("draws what waits under what holds it up, with the reason on its line", () => {
    const rows = matterRows(
      bundle(
        ["c", "b", "a"],
        [
          ["a", "b"],
          ["b", "c"],
        ],
      ),
    );
    expect(rows.map((r) => r.threadId)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.ready)).toEqual([true, false, false]);
    expect(rows[0]?.quote).toBeUndefined();
    expect(rows[1]?.quote).toBe("a-b");
  });

  it("puts what frees the most first", () => {
    const b = bundle(
      ["x", "a", "b", "c"],
      [
        ["a", "b"],
        ["a", "c"],
      ],
    );
    expect(shape(b)).toEqual(["a:0", "b:1", "c:1", "x:0"]);
  });

  it("draws a thread once, and says who else it waits on", () => {
    const rows = matterRows(
      bundle(
        ["a", "b", "c"],
        [
          ["a", "c"],
          ["b", "c"],
        ],
      ),
    );
    expect(rows.filter((r) => r.threadId === "c")).toHaveLength(1);
    expect(rows.find((r) => r.threadId === "c")?.alsoWaitsOn).toEqual(["B"]);
  });

  it("runs a line past a row only while more of its level come", () => {
    const rows = matterRows(
      bundle(
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["a", "c"],
          ["b", "d"],
        ],
      ),
    );
    const of = (id: string) => rows.find((r) => r.threadId === id);
    expect(of("b")?.guides).toEqual([true]);
    expect(of("d")?.guides).toEqual([true, false]);
    expect(of("c")?.guides).toEqual([false]);
    expect(of("a")?.stem).toBe(true);
    expect(of("c")?.stem).toBe(false);
  });

  it("ignores a line to a thread that is not on the map", () => {
    expect(shape(bundle(["a"], [["a", "gone"]]))).toEqual(["a:0"]);
    expect(matterRows(bundle(["a"], [["gone", "a"]]))[0]?.ready).toBe(true);
  });
});

describe("the sentence of a matter", () => {
  it("says where to start and what that does", () => {
    expect(
      matterSummary(
        bundle(
          ["a", "b", "c"],
          [
            ["a", "b"],
            ["b", "c"],
          ],
        ),
      ),
    ).toEqual({
      text: "Start with A. It frees 2 others.",
      agent: true,
    });
    expect(matterSummary(bundle(["a", "b"], [["a", "b"]])).text).toBe(
      "Start with A. It frees 1 other.",
    );
  });

  it("counts several starts", () => {
    const b = bundle(
      ["a", "b", "c", "d"],
      [
        ["a", "c"],
        ["b", "d"],
      ],
    );
    expect(matterSummary(b).text).toBe("2 can start now, and free 2 others.");
  });

  it("claims nothing of the agent's when nothing blocks anything", () => {
    expect(matterSummary(bundle(["a", "b"]))).toEqual({
      text: "2 threads about the same thing. None holds up another.",
      agent: false,
    });
  });
});

describe("what lights up with a row", () => {
  const b = bundle(
    ["a", "b", "c", "x"],
    [
      ["a", "b"],
      ["b", "c"],
    ],
  );
  it("is what it waits for and what waits for it, and nothing beside", () => {
    expect([...pathOf(b, "b")].sort()).toEqual(["a", "b", "c"]);
    expect(pathOf(b, "x")).toEqual(new Set(["x"]));
    expect(pathOf(b, null).size).toBe(0);
  });
});

describe("the rail of a matter in the list", () => {
  const ids = ["x", undefined, "m", "m", "m", "n"];
  it("marks where it starts, runs and ends, and not a row alone", () => {
    expect(ids.map((_, i) => railAt(ids, i))).toEqual([
      undefined,
      undefined,
      "first",
      "middle",
      "last",
      undefined,
    ]);
  });
});
