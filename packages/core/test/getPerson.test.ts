import { describe, expect, it, vi } from "vitest";
import type { PeoplePort, PersonStats } from "../src/index.ts";
import { getPerson } from "../src/index.ts";

function setup(found: PersonStats | undefined) {
  const person = vi.fn(async (_address: string) => found);
  return { person, deps: { people: { person } as unknown as PeoplePort } };
}

describe("getPerson", () => {
  it("asks the port for the trimmed, lower-cased address", async () => {
    const stats = { address: "jan@lodz.pl", count: 3, lastMs: 9 };
    const s = setup(stats);
    expect(await getPerson(s.deps, "  Jan@Lodz.PL ")).toEqual(stats);
    expect(s.person).toHaveBeenCalledWith("jan@lodz.pl");
  });

  it("gives nothing for a blank or absurd address without asking", async () => {
    const s = setup({ address: "a@b.c", count: 1, lastMs: 1 });
    expect(await getPerson(s.deps, "   ")).toBeUndefined();
    expect(await getPerson(s.deps, `${"a".repeat(400)}@b.c`)).toBeUndefined();
    expect(s.person).not.toHaveBeenCalled();
  });

  it("gives nothing when the index holds no mail for them", async () => {
    expect(await getPerson(setup(undefined).deps, "nobody@x.org")).toBeUndefined();
  });
});
