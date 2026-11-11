import { describe, expect, it, vi } from "vitest";
import type { AccountStorePort, PeoplePort, PersonSuggestion } from "../src/index.ts";
import { suggestPeople } from "../src/index.ts";

function setup(found: PersonSuggestion[], own: string[] = ["Me@Example.com"]) {
  const suggest = vi.fn(async (_prefix: string, limit: number) => found.slice(0, limit));
  const frequent = vi.fn(async (limit: number) => found.slice(0, limit));
  const list = vi.fn(async () =>
    own.map((address, i) => ({ id: `a${i}`, address, displayName: "Me" })),
  );
  return {
    suggest,
    frequent,
    deps: {
      people: { suggest, frequent } as unknown as PeoplePort,
      accounts: { list } as unknown as AccountStorePort,
    },
  };
}

const p = (address: string, count = 1): PersonSuggestion => ({ address, count });

describe("suggestPeople", () => {
  it("answers blank input with the most frequent people, without the user's own", async () => {
    const s = setup([p("me@example.com", 9), p("a@b.c", 5), p("d@e.f", 2)]);
    for (const input of ["", "   "]) {
      const found = await suggestPeople(s.deps, input, 1);
      expect(found.map((x) => x.address)).toEqual(["a@b.c"]);
    }
    expect(s.suggest).not.toHaveBeenCalled();
  });

  it("asks for nothing when the input has only other characters", async () => {
    const s = setup([p("a@b.c")]);
    for (const input of ["@@", "..."]) {
      expect(await suggestPeople(s.deps, input, 5)).toEqual([]);
    }
    expect(await suggestPeople(s.deps, "a", 0)).toEqual([]);
    expect(s.suggest).not.toHaveBeenCalled();
  });

  it("folds the input before it reaches the port", async () => {
    const s = setup([]);
    await suggestPeople(s.deps, "  ŁÓdź.Kow ", 5);
    expect(s.suggest).toHaveBeenCalledWith("lodz kow", expect.any(Number));
  });

  it("leaves out the user's own addresses and still fills the limit", async () => {
    const s = setup([p("me@example.com", 9), p("a@x.pl"), p("b@x.pl"), p("c@x.pl")]);
    const got = await suggestPeople(s.deps, "x", 3);
    expect(got.map((x) => x.address)).toEqual(["a@x.pl", "b@x.pl", "c@x.pl"]);
    expect(s.suggest).toHaveBeenCalledWith("x", 4);
  });

  it("caps the limit", async () => {
    const s = setup([]);
    await suggestPeople(s.deps, "x", 10_000);
    expect(s.suggest.mock.calls[0]?.[1]).toBeLessThanOrEqual(25);
  });
});
