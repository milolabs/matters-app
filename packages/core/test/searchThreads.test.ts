import { describe, expect, it } from "vitest";
import { type SearchThreadsDeps, threadsMatching } from "../src/index.ts";

function rig(mail: readonly (readonly [number, string])[], matching: readonly number[]) {
  const asked: (readonly number[])[] = [];
  const deps = {
    accounts: { list: async () => [] },
    now: () => 0,
    index: {
      matchesAmong: async (_q: unknown, keys: readonly number[]) => {
        asked.push(keys);
        return keys.filter((k) => matching.includes(k));
      },
    },
    store: {
      getThread: async (id: string) => ({
        messages: mail.filter(([, t]) => t === id).map(([key]) => ({ key })),
      }),
    },
  } as unknown as SearchThreadsDeps;
  return { deps, asked };
}

const MAIL = [
  [9, "a"],
  [8, "x"],
  [7, "b"],
  [6, "x"],
  [5, "a"],
] as const;

describe("threadsMatching (ADR 0056, rule 2)", () => {
  it("says which of the threads hold a match, in any message of theirs", async () => {
    const { deps } = rig(MAIL, [5, 8]);
    const found = await threadsMatching(deps, "faktura", ["a", "b"]);
    expect([...(found ?? [])]).toEqual(["a"]);
  });

  it("is null when the text constrains nothing", async () => {
    const { deps, asked } = rig(MAIL, []);
    expect(await threadsMatching(deps, "from:", ["a"])).toBeNull();
    expect(asked).toEqual([]);
  });

  it("asks the index once, about the messages of these threads alone", async () => {
    const { deps, asked } = rig(MAIL, []);
    await threadsMatching(deps, "faktura", ["a", "b", "a"]);
    expect(asked).toEqual([[9, 5, 7]]);
  });

  it("finds nothing among no threads", async () => {
    const { deps } = rig(MAIL, [9]);
    expect([...((await threadsMatching(deps, "faktura", [])) ?? [])]).toEqual([]);
  });
});
