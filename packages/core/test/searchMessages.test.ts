import { describe, expect, it, vi } from "vitest";
import type { AccountStorePort, MessageStorePort, SearchIndexPort } from "../src/index.ts";
import { searchMessages } from "../src/index.ts";

function deps(keys: number[], nextBeforeKey?: number) {
  const searchChunk = vi.fn(async () => ({
    keys,
    ...(nextBeforeKey === undefined ? {} : { nextBeforeKey }),
  }));
  const getByKeys = vi.fn(async () => []);
  const list = vi.fn(async () => [{ id: "a1", address: "jan@example.com", displayName: "Jan" }]);
  return {
    searchChunk,
    getByKeys,
    deps: {
      index: { searchChunk } as unknown as SearchIndexPort,
      store: { getByKeys } as unknown as MessageStorePort,
      accounts: { list } as unknown as AccountStorePort,
    },
  };
}

describe("searchMessages", () => {
  it("does not hit the index for an empty query", async () => {
    const d = deps([1]);
    for (const q of [" -- ", "from:", "is:un"]) {
      await expect(searchMessages(d.deps, q, { limit: 10 })).resolves.toEqual({ messages: [] });
    }
    expect(d.searchChunk).not.toHaveBeenCalled();
  });

  it("parses, searches a chunk, then loads messages in index order", async () => {
    const d = deps([3, 2]);
    await searchMessages(d.deps, "Żółw", { limit: 10 });
    expect(d.searchChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        root: { kind: "text", field: "any", match: "prefix", value: "zolw" },
      }),
      { limit: 10 },
    );
    expect(d.getByKeys).toHaveBeenCalledWith([3, 2]);
  });

  it("passes the accounts and the clock to the parser", async () => {
    const d = deps([]);
    await searchMessages(
      { ...d.deps, now: () => new Date(2026, 10, 4, 12).getTime() },
      "from:me after:today",
      {
        limit: 5,
      },
    );
    const [query] = d.searchChunk.mock.calls[0] as unknown as [{ root: unknown }];
    expect(query.root).toEqual({
      kind: "and",
      children: [
        {
          kind: "or",
          children: [{ kind: "text", field: "from", match: "phrase", value: "jan example com" }],
        },
        { kind: "after", ms: new Date(2026, 10, 4).getTime() },
      ],
    });
  });

  it("returns the cursor of the chunk, short or empty or not", async () => {
    expect((await searchMessages(deps([5, 4], 4).deps, "a", { limit: 2 })).nextBeforeKey).toBe(4);
    expect((await searchMessages(deps([5], 77).deps, "a", { limit: 2 })).nextBeforeKey).toBe(77);
    expect((await searchMessages(deps([], 77).deps, "a", { limit: 2 })).nextBeforeKey).toBe(77);
    expect((await searchMessages(deps([5]).deps, "a", { limit: 2 })).nextBeforeKey).toBeUndefined();
  });
});
