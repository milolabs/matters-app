import { describe, expect, it } from "vitest";
import { splitBody } from "../src/renderer/body.ts";

describe("splitBody", () => {
  it("separates fresh text from quoted lines and keeps line breaks", () => {
    const text =
      "Dzień dobry,\n\nDziękuję.\n\nW dniu x napisał(a):\n> Cześć,\n>\n> > starsze\n> koniec";
    expect(splitBody(text)).toEqual([
      { quoted: false, text: "Dzień dobry,\n\nDziękuję.\n\nW dniu x napisał(a):", lines: 5 },
      { quoted: true, text: "Cześć,\n\n> starsze\nkoniec", lines: 4 },
    ]);
  });

  it("handles text with quotes in the middle, CRLF and no quotes at all", () => {
    expect(splitBody("a\r\n> b\r\nc")).toEqual([
      { quoted: false, text: "a", lines: 1 },
      { quoted: true, text: "b", lines: 1 },
      { quoted: false, text: "c", lines: 1 },
    ]);
    expect(splitBody("tylko\ntekst")).toEqual([{ quoted: false, text: "tylko\ntekst", lines: 2 }]);
    expect(splitBody("")).toEqual([]);
    expect(splitBody("\n\n")).toEqual([]);
  });
});
