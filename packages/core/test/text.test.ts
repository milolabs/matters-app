import { describe, expect, it } from "vitest";
import { foldText, tokenize } from "../src/index.ts";

describe("foldText", () => {
  it.each([
    ["zolw", "Żółw"],
    ["lodzi", "Łodzi"],
    ["zrodlo", "źródło"],
    ["przyslal", "przysłał"],
  ])("folds %s and %s to the same text", (ascii, polish) => {
    expect(foldText(polish)).toBe(ascii);
    expect(foldText(ascii)).toBe(ascii);
  });

  it("lowercases and handles uppercase Ł", () => {
    expect(foldText("ŁÓDŹ")).toBe("lodz");
  });

  it("is idempotent", () => {
    const once = foldText("Zażółć gęślą jaźń");
    expect(foldText(once)).toBe(once);
    expect(once).toBe("zazolc gesla jazn");
  });
});

describe("tokenize", () => {
  it("splits on anything that is not a letter or digit", () => {
    expect(tokenize("Jan.Kowalski@Example.com, Łódź-42")).toEqual([
      "jan",
      "kowalski",
      "example",
      "com",
      "lodz",
      "42",
    ]);
  });
});
