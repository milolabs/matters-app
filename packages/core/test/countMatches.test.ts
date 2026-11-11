import { describe, expect, it, vi } from "vitest";
import type { AccountStorePort, MessageStorePort, SearchIndexPort } from "../src/index.ts";
import { countMatches, searchMessages } from "../src/index.ts";

type Chunk = { keys: number[]; nextBeforeKey?: number };

function rig(chunks: Chunk[]) {
  let i = 0;
  const searchChunk = vi.fn(
    async (..._args: unknown[]) => chunks[Math.min(i++, chunks.length - 1)] as Chunk,
  );
  const getByKeys = vi.fn(async () => []);
  const list = vi.fn(async () => [{ id: "a1", address: "jan@example.com", displayName: "Jan" }]);
  return {
    searchChunk,
    getByKeys,
    deps: {
      index: { searchChunk } as unknown as SearchIndexPort,
      accounts: { list } as unknown as AccountStorePort,
    },
  };
}

describe("countMatches (ADR 0027)", () => {
  it("answers 0 for an empty query without touching the index", async () => {
    const r = rig([{ keys: [1] }]);
    for (const q of ["", "  ", "from:", "is:un", " -- "]) {
      await expect(countMatches(r.deps, q, { cap: 99 })).resolves.toEqual({ count: 0 });
    }
    expect(r.searchChunk).not.toHaveBeenCalled();
  });

  it("answers 0 for a query with a prompt, which shows no badge (ADR 0116, rule 10)", async () => {
    const r = rig([{ keys: [1] }]);
    for (const q of ["prompt:x", 'from:jan prompt:"what needs me"']) {
      await expect(countMatches(r.deps, q, { cap: 99 })).resolves.toEqual({ count: 0 });
    }
    expect(r.searchChunk).not.toHaveBeenCalled();
    // A prompt that is dropped leaves the filters as they are.
    await expect(countMatches(r.deps, "from:jan -prompt:x", { cap: 99 })).resolves.toEqual({
      count: 1,
    });
  });

  it("ANDs the root with is:unread and asks for cap keys", async () => {
    const r = rig([{ keys: [5, 4, 3] }]);
    await expect(countMatches(r.deps, "faktura", { cap: 99 })).resolves.toEqual({ count: 3 });
    const [query, options] = r.searchChunk.mock.calls[0] as unknown as [
      { root: unknown },
      { limit: number; beforeKey?: number },
    ];
    expect(query.root).toEqual({
      kind: "and",
      children: [
        { kind: "text", field: "any", match: "prefix", value: "faktura" },
        { kind: "flag", flag: "unread" },
      ],
    });
    expect(options).toEqual({ limit: 99 });
  });

  it("clamps the cap and passes beforeKey; returns the cursor", async () => {
    const r = rig([{ keys: [9, 8], nextBeforeKey: 8 }]);
    const out = await countMatches(r.deps, "is:unread", { cap: 100_000, beforeKey: 20 });
    expect(out).toEqual({ count: 2, nextBeforeKey: 8 });
    expect(r.searchChunk.mock.calls[0]?.[1]).toEqual({ limit: 500, beforeKey: 20 });
    await countMatches(r.deps, "is:unread", { cap: 0 });
    expect(r.searchChunk.mock.calls[1]?.[1]).toEqual({ limit: 1 });
  });

  it("chunks concatenate: following cursors adds the counts up", async () => {
    const r = rig([
      { keys: [10, 9], nextBeforeKey: 9 },
      { keys: [], nextBeforeKey: 5 },
      { keys: [4] },
    ]);
    let total = 0;
    let before: number | undefined;
    for (;;) {
      const c = await countMatches(r.deps, "x", {
        cap: 99,
        ...(before === undefined ? {} : { beforeKey: before }),
      });
      total += c.count;
      if (c.nextBeforeKey === undefined) break;
      before = c.nextBeforeKey;
    }
    expect(total).toBe(3);
    expect(r.searchChunk).toHaveBeenCalledTimes(3);
  });

  it("reads accounts and the clock like search, and never loads messages", async () => {
    const r = rig([{ keys: [1] }]);
    await countMatches(
      { ...r.deps, now: () => new Date(2026, 10, 4, 12).getTime() },
      "from:me after:today",
      { cap: 99 },
    );
    const [query] = r.searchChunk.mock.calls[0] as unknown as [{ root: { kind: string } }];
    expect(query.root.kind).toBe("and");
    expect(JSON.stringify(query.root)).toContain("jan example com");
    // The same text through search gives the same plan apart from the unread flag.
    const s = rig([{ keys: [1] }]);
    await searchMessages(
      {
        index: s.deps.index,
        store: { getByKeys: s.getByKeys } as unknown as MessageStorePort,
        accounts: s.deps.accounts,
        now: () => new Date(2026, 10, 4, 12).getTime(),
      },
      "from:me after:today",
      { limit: 99 },
    );
    const [plain] = s.searchChunk.mock.calls[0] as unknown as [{ root: unknown }];
    expect((query.root as unknown as { children: unknown[] }).children[0]).toEqual(plain.root);
    expect(r.getByKeys).not.toHaveBeenCalled();
  });
});
