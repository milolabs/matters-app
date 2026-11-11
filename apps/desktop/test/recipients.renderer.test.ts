// The recipient field's chips (ADR 0101): the text splits and joins without changing what is sent.
import { describe, expect, it } from "vitest";
import { chipLabel, joinRecipients, pieceOf, splitRecipients } from "../src/renderer/recipients.ts";

describe("splitRecipients", () => {
  it("makes a chip of each finished piece and keeps the one being typed", () => {
    expect(splitRecipients("Anna <anna@x.pl>, b@x.pl, jo")).toEqual({
      chips: ["Anna <anna@x.pl>", "b@x.pl"],
      typing: "jo",
    });
    expect(splitRecipients("b@x.pl,")).toEqual({ chips: ["b@x.pl"], typing: "" });
  });

  it("does not split inside quotes or angle brackets", () => {
    expect(splitRecipients('"Kowalski, Jan" <jan@x.pl>, ')).toEqual({
      chips: ['"Kowalski, Jan" <jan@x.pl>'],
      typing: "",
    });
  });

  it("joins back to text the draft parses the same way", () => {
    const { chips, typing } = splitRecipients("Anna <anna@x.pl>; b@x.pl, c");
    expect(joinRecipients(chips, typing)).toBe("Anna <anna@x.pl>, b@x.pl, c");
    expect(joinRecipients([], "")).toBe("");
  });
});

describe("chips", () => {
  it("shows the name, or the address, and says when it is not an address", () => {
    expect(chipLabel("Anna <anna@x.pl>")).toEqual({
      label: "Anna",
      address: "anna@x.pl",
      valid: true,
    });
    expect(chipLabel("b@x.pl").label).toBe("b@x.pl");
    expect(chipLabel("nope").valid).toBe(false);
  });

  it("writes a suggestion as a piece, quoting a name with a comma", () => {
    expect(pieceOf({ name: "Kowalski, Jan", address: "jan@x.pl" })).toBe(
      '"Kowalski, Jan" <jan@x.pl>',
    );
    expect(pieceOf({ address: "a@x.pl" })).toBe("a@x.pl");
  });
});
