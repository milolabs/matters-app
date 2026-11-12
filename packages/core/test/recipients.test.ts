import { describe, expect, it } from "vitest";
import {
  formatRecipients,
  hasAddressShape,
  isPlausibleAddress,
  isValidAddress,
  type Participant,
  parseRecipients,
} from "../src/index.ts";
import { QUICK_MS, timed } from "./support.ts";

describe("isPlausibleAddress", () => {
  it.each(["anna@x.pl", "a@b.c", "a.b@c.d.e", "a@.b.c", "a@b..c", "!@!.!", "a<b>@c.d"])(
    "%j looks like an address",
    (address) => expect(isPlausibleAddress(address)).toBe(true),
  );

  it.each([
    "",
    "a",
    "@b.c",
    "a@",
    "a@b",
    "a@.b",
    "a@b.",
    "a@@b.c",
    "a@b@c.d",
    "a b@c.d",
    "a@b.c ",
    " a@b.c",
    "a@b.c\n",
    "a@b\t.c",
    "a@b.c ",
  ])("%j does not", (address) => expect(isPlausibleAddress(address)).toBe(false));

  it("takes linear time on a long domain of dots", () => {
    const address = `!@!.${"!.".repeat(50_000)} `;
    const { result, ms } = timed(() => isPlausibleAddress(address));
    expect(result).toBe(false);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});

describe("isValidAddress", () => {
  it("also refuses what separates or quotes an address in a field", () => {
    expect(isValidAddress(" anna@x.pl ")).toBe(true);
    for (const ch of ["<", ">", ",", ";", '"']) {
      expect(isValidAddress(`an${ch}na@x.pl`)).toBe(false);
      expect(hasAddressShape(`an${ch}na@x.pl`)).toBe(true);
    }
  });

  it("takes linear time on a long domain of dots", () => {
    const address = `!@!.${"!.".repeat(50_000)}"`;
    const { result, ms } = timed(() => isValidAddress(address));
    expect(result).toBe(false);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});

describe("parseRecipients", () => {
  it("reads names, quoted names and bare addresses", () => {
    expect(parseRecipients('Anna <anna@x.pl>, "Kowalski, Jan" <jan@x.pl>; b@x.pl, nope')).toEqual({
      participants: [
        { name: "Anna", address: "anna@x.pl" },
        { name: "Kowalski, Jan", address: "jan@x.pl" },
        { address: "b@x.pl" },
      ],
      invalid: ["nope"],
    });
  });

  it("reads a backslash in a quoted name as taking the next character as it is", () => {
    expect(parseRecipients(String.raw`"Jan \"JJ\", K" <jan@x.pl>, "a\\b" <b@x.pl>`)).toEqual({
      participants: [
        { name: 'Jan "JJ", K', address: "jan@x.pl" },
        { name: "a\\b", address: "b@x.pl" },
      ],
      invalid: [],
    });
  });

  it("takes linear time on a long domain of dots", () => {
    const text = `x <!@!.${"!.".repeat(50_000)}>`;
    const { result, ms } = timed(() => parseRecipients(text));
    expect(result.participants).toHaveLength(1);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});

describe("formatRecipients", () => {
  it("quotes a name with specials and escapes its quotes and backslashes", () => {
    expect(
      formatRecipients([
        { name: "Anna", address: "anna@x.pl" },
        { name: 'Jan "JJ", K', address: "jan@x.pl" },
        { name: String.raw`a\b, c`, address: "c@x.pl" },
        { address: "b@x.pl" },
      ]),
    ).toBe(String.raw`Anna <anna@x.pl>, "Jan \"JJ\", K" <jan@x.pl>, "a\\b, c" <c@x.pl>, b@x.pl`);
  });

  it.each<Participant[]>([
    [{ name: "Anna", address: "anna@x.pl" }],
    [{ name: "Kowalski, Jan", address: "jan@x.pl" }],
    [{ name: 'Jan "JJ" K', address: "jan@x.pl" }],
    [{ name: 'say "hi, there', address: "a@x.pl" }],
    [{ name: String.raw`back\slash`, address: "a@x.pl" }],
    [{ name: String.raw`back\slash, comma`, address: "a@x.pl" }],
    [{ name: String.raw`ends in \"`, address: "a@x.pl" }],
    [{ name: String.raw`\\"; <x@y.z>`, address: "a@x.pl" }],
    [{ name: '"quoted"', address: "a@x.pl" }],
    [{ address: "a@x.pl" }],
  ])("is undone by parseRecipients: %j", (participant) => {
    const list = [participant, { name: "Next, One", address: "next@x.pl" }];
    expect(parseRecipients(formatRecipients(list))).toEqual({ participants: list, invalid: [] });
  });
});
