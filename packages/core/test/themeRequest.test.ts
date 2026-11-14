import { describe, expect, it } from "vitest";
import {
  buildThemeRequest,
  CURRENT_OPEN,
  DESCRIBED_CLOSE,
  DESCRIBED_OPEN,
  MAX_THEME_DESCRIPTION_CHARS,
  MAX_THEME_PROBLEMS,
  PREVIOUS_OPEN,
  PROBLEMS_CLOSE,
  PROBLEMS_OPEN,
  type ThemeFormat,
  themeInstructions,
  themeTextOf,
} from "../src/index.ts";

// ADR 0134, rules 12 and 14: the turn that makes a theme is built from the format it is handed,
// and gives back the theme's text as a file would hold it.

const FORMAT: ThemeFormat = {
  tokens: [
    { token: "bg", use: "the ground" },
    { token: "ink", use: "the text" },
    { token: "hairline", use: "lines" },
  ],
  schemes: ["light", "dark"],
  nameLimit: 60,
  fileLimit: 100,
  needed: 4.5,
  pairs: [{ ink: "ink", surfaces: ["bg"] }],
  defaults: {
    light: { bg: "#ffffff", ink: "#1d1d1f", hairline: "#ededeb" },
    dark: { bg: "#1e1e20", ink: "#f5f5f7", hairline: "#34343a" },
  },
};

describe("the request (rule 14)", () => {
  it("says the format from the data it is given, and nothing of mail", () => {
    const text = themeInstructions(FORMAT);
    expect(text).toContain("- bg: the ground\n- ink: the text\n- hairline: lines");
    expect(text).toContain("at least 4.5:1");
    expect(text).toContain("- ink on bg");
    // Only the tokens the check reads must be opaque; a line may be see-through.
    expect(text).toContain('must be opaque (no "aa" part): ink, bg.');
    expect(text).toContain("- light: bg #ffffff, ink #1d1d1f, hairline #ededeb");
    expect(text).toContain("1 to 60 characters");
    expect(text).toContain("at most 100 bytes");
    expect(text).toContain("You have no tools, and there is no mail here.");
  });

  it("gives the description alone, one line and capped, under the person's heading", () => {
    const long = `sea ${"x".repeat(MAX_THEME_DESCRIPTION_CHARS)}`;
    const request = buildThemeRequest({ description: `  a calm\n\nsea​ ` }, FORMAT);
    expect(request.untrusted).toBe(`${DESCRIBED_OPEN}\na calm sea\n${DESCRIBED_CLOSE}`);
    const capped = buildThemeRequest({ description: long }, FORMAT).untrusted;
    expect(capped.length).toBe(
      DESCRIBED_OPEN.length + DESCRIBED_CLOSE.length + 2 + MAX_THEME_DESCRIPTION_CHARS,
    );
    expect(request.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["theme"],
      properties: { theme: { type: "string", minLength: 2, maxLength: 100 } },
    });
  });

  it("adds the theme that is on and, on the retry, the answer and its problems, as data", () => {
    const problems = Array.from({ length: MAX_THEME_PROBLEMS + 3 }, (_, i) => `Problem ${i}.`);
    const { untrusted } = buildThemeRequest(
      { description: "warmer", current: '{"name":"Paper"}', retry: { previous: "{}", problems } },
      FORMAT,
    );
    expect(untrusted.indexOf(CURRENT_OPEN)).toBeGreaterThan(untrusted.indexOf(DESCRIBED_CLOSE));
    expect(untrusted).toContain(`${CURRENT_OPEN}\n{"name":"Paper"}\n`);
    expect(untrusted).toContain(`${PREVIOUS_OPEN}\n{}\n`);
    const listed = untrusted.slice(
      untrusted.indexOf(PROBLEMS_OPEN),
      untrusted.indexOf(PROBLEMS_CLOSE),
    );
    expect(listed.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(MAX_THEME_PROBLEMS);
  });
});

describe("the answer (rule 12)", () => {
  const theme = '{"name": "Moss", "dark": {"bg": "#18201a"}}';
  it("is the one JSON object, bare, fenced or among words", () => {
    expect(themeTextOf({ theme }, FORMAT)).toBe(theme);
    expect(themeTextOf({ theme: `\`\`\`json\n${theme}\n\`\`\`` }, FORMAT)).toBe(theme);
    expect(themeTextOf({ theme: `\`\`\`\n${theme}\`\`\`` }, FORMAT)).toBe(theme);
    expect(themeTextOf({ theme: `Sure! ${theme} Hope you like it.` }, FORMAT)).toBe(theme);
    expect(JSON.parse(themeTextOf({ theme: JSON.parse(theme) }, FORMAT) ?? "")).toEqual(
      JSON.parse(theme),
    );
  });

  it("is nothing for anything else", () => {
    for (const value of [
      null,
      "text",
      [theme],
      { other: theme },
      { theme: "" },
      { theme: "none" },
      { theme: "[1]" },
      { theme: '{"name": ' },
      { theme: "{} and {}" },
      { theme: 3 },
      { theme: "x".repeat(201) },
    ]) {
      expect(themeTextOf(value, FORMAT), JSON.stringify(value)).toBeNull();
    }
  });
});
