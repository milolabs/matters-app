import { describe, expect, it } from "vitest";
import { highlight, hitWords } from "../src/renderer/hits.ts";

const marked = (text: string, words: string | string[], anywhere = false) =>
  highlight(text, words, { anywhere })
    .map((s) => (s.hit ? `[${s.text}]` : s.text))
    .join("");

describe("hitWords", () => {
  it("folds, splits at punctuation, drops repeats and puts the longest first", () => {
    expect(hitWords("Zażółć, fak faktura FAK")).toEqual(["faktura", "zazolc", "fak"]);
    expect(hitWords([])).toEqual([]);
    expect(hitWords("  ...  ")).toEqual([]);
  });
});

describe("highlight", () => {
  it("marks the start of words, whatever the case", () => {
    expect(marked("Faktura za listopad", "faktura")).toBe("[Faktura] za listopad");
    expect(marked("Re: FAKTURA 12", "faktura")).toBe("Re: [FAKTURA] 12");
    expect(marked("Faktura za listopad", "fakt")).toBe("[Fakt]ura za listopad");
  });

  it("does not mark inside a word", () => {
    expect(marked("Faktura", "tura")).toBe("Faktura");
    expect(marked("Faktura", "tura", true)).toBe("Fak[tura]");
  });

  it("ignores diacritics on both sides", () => {
    expect(marked("Załącznik do umowy", "zalacznik")).toBe("[Załącznik] do umowy");
    expect(marked("Zalacznik", "załącznik")).toBe("[Zalacznik]");
    expect(marked("Łódź i Kraków", "lodz krakow")).toBe("[Łódź] i [Kraków]");
    // decomposed letters (e + combining acute) stay whole
    expect(marked("Café René", "cafe")).toBe("[Café] René");
  });

  it("marks every word typed, in the order of the text", () => {
    expect(marked("Bilet do Krakowa, bilet z Krakowa", "kraków bilet")).toBe(
      "[Bilet] do [Krakow]a, [bilet] z [Krakow]a",
    );
  });

  it("places the longer of overlapping words and does not mark twice", () => {
    expect(marked("Faktura 2026", "fak faktura")).toBe("[Faktura] 2026");
    expect(marked("Faktura 2026", ["faktura", "fakt"])).toBe("[Faktura] 2026");
  });

  it("joins marks that touch", () => {
    expect(marked("ab-cd", "ab cd")).toBe("[ab]-[cd]");
    expect(highlight("abcabc", "abc", { anywhere: true }).filter((s) => s.hit)).toHaveLength(1);
  });

  it("reads punctuation in the text and in the words as separators", () => {
    expect(marked("(faktura), nr.12!", "faktura, 12")).toBe("([faktura]), nr.[12]!");
    expect(marked("a+b", "a+b")).toBe("[a]+[b]");
  });

  it("never builds a pattern from what was typed", () => {
    expect(marked("a.c (x) [y] a*c", ".*")).toBe("a.c (x) [y] a*c");
    expect(marked("a(b", "(b a(")).toBe("[a]([b]");
    expect(marked("ab", "\\")).toBe("ab");
  });

  it("returns the text whole when nothing matches or nothing was typed", () => {
    expect(highlight("Faktura", "")).toEqual([{ text: "Faktura", hit: false }]);
    expect(highlight("Faktura", [])).toEqual([{ text: "Faktura", hit: false }]);
    expect(highlight("Faktura", "bilet")).toEqual([{ text: "Faktura", hit: false }]);
    expect(highlight("", "bilet")).toEqual([]);
  });

  it("covers the text exactly", () => {
    const text = "Re: Faktura Łódź (2026) — Zażółć";
    for (const words of ["faktura", "lodz 2026", "zazolc re", "x"]) {
      expect(
        highlight(text, words)
          .map((s) => s.text)
          .join(""),
      ).toBe(text);
    }
  });
});
