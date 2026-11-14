import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeProblem } from "@matters/contracts";
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES } from "../src/main/builtInThemes.ts";
import {
  CONTRAST_NEEDED,
  CONTRAST_PAIRS,
  contrastProblems,
  contrastRatio,
  DEFAULT_COLORS,
  normaliseHex,
  parseTheme,
  SHORT_IN_DEFAULT,
  serializeTheme,
  THEME_TOKENS,
  themeSchemes,
  themeSwatches,
} from "../src/main/themes.ts";
import { DEFAULT_SWATCHES } from "../src/renderer/appTheme.ts";
import { DEFAULT_MAIL_GROUND } from "../src/renderer/mailTheme.ts";

// ADR 0134, rules 4 to 6: the theme format, the contrast check, the defaults and the built-ins.

const renderer = join(import.meta.dirname, "../src/renderer");
const theme = (body: Record<string, unknown>) => JSON.stringify({ name: "T", ...body });
const refused = (text: string): ThemeProblem[] => {
  const r = parseTheme(text);
  if (r.ok) throw new Error("the theme was taken");
  return [...r.problems];
};
const reasons = (text: string) =>
  refused(text).map((p) => (p.kind === "format" ? `${p.reason}${p.at ? `@${p.at}` : ""}` : p.kind));

/** The tokens of a `:root { … }` block of the CSS, as hex. */
function cssTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)) {
    out[m[1] ?? ""] = (m[2] ?? "").toLowerCase();
  }
  return out;
}

describe("the default's values", () => {
  const css = readFileSync(join(renderer, "styles.css"), "utf8");
  const light = cssTokens(
    css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")),
  );
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  const dark = cssTokens(css.slice(darkStart, css.indexOf("@theme inline")));

  it("are the values of styles.css, in light and in dark", () => {
    for (const token of THEME_TOKENS) {
      expect(DEFAULT_COLORS.light[token], `light ${token}`).toBe(light[token]);
      expect(DEFAULT_COLORS.dark[token], `dark ${token}`).toBe(dark[token]);
    }
  });

  it("are the loading screen's fallbacks, the mail's dark ground and the default's strip", () => {
    const boot = readFileSync(join(renderer, "boot.css"), "utf8");
    const darkBoot = boot.slice(boot.indexOf("@media (prefers-color-scheme: dark)"));
    const fallbacks = (text: string) => {
      const out: Record<string, string> = {};
      for (const m of text.matchAll(/var\(--([a-z-]+),\s*(#[0-9a-f]{6})\)/gi)) {
        out[m[1] ?? ""] ??= (m[2] ?? "").toLowerCase();
      }
      return out;
    };
    const lightBoot = fallbacks(boot.slice(0, boot.indexOf("@media (prefers-color-scheme: dark)")));
    for (const [token, value] of Object.entries(lightBoot)) {
      expect(value, `boot light ${token}`).toBe(DEFAULT_COLORS.light[token as "bg"]);
    }
    for (const [token, value] of Object.entries(fallbacks(darkBoot))) {
      expect(value, `boot dark ${token}`).toBe(DEFAULT_COLORS.dark[token as "bg"]);
    }
    expect(Object.keys(lightBoot).sort()).toEqual(["bg", "chrome", "hairline", "ink", "secondary"]);
    expect(DEFAULT_MAIL_GROUND).toEqual({
      bg: DEFAULT_COLORS.dark.bg,
      ink: DEFAULT_COLORS.dark.ink,
    });
    expect(DEFAULT_SWATCHES).toEqual(themeSwatches({ light: {}, dark: {} }));
  });

  it("pass the check in both modes", () => {
    expect(contrastProblems("light", {})).toEqual([]);
    expect(contrastProblems("dark", {})).toEqual([]);
  });

  it("fall short where the table leaves a pair out, by these ratios", () => {
    const ratios = SHORT_IN_DEFAULT.map(({ mode, ink, surface }) => [
      `${mode} ${ink}/${surface}`,
      Math.round(contrastRatio(DEFAULT_COLORS[mode][ink], DEFAULT_COLORS[mode][surface]) * 100) /
        100,
    ]);
    expect(Object.fromEntries(ratios)).toEqual({
      "light secondary/selected": 4.44,
      "light secondary/button": 4.21,
      "light secondary/pill": 4.17,
      "light late/selected": 4.49,
      "light late/button": 4.25,
      "dark secondary/selected": 4.45,
      "dark secondary/button": 3.95,
      "dark secondary/pill": 3.82,
    });
    // None of them is also in the table, which would refuse every theme.
    for (const { ink, surface } of SHORT_IN_DEFAULT) {
      expect(CONTRAST_PAIRS[ink] ?? []).not.toContain(surface);
    }
  });
});

describe("contrast", () => {
  it("is WCAG 2.1's ratio", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The well-known grey that just passes AA on white.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("names the pair, the mode, the ratio and the 4.5 needed, for every failing pair", () => {
    const problems = refused(theme({ dark: { mid: "#3a3a3f" } }));
    expect(problems.every((p) => p.kind === "contrast")).toBe(true);
    const bg = problems.find((p) => p.kind === "contrast" && p.surface === "bg");
    expect(bg).toMatchObject({
      kind: "contrast",
      mode: "dark",
      ink: "mid",
      needed: CONTRAST_NEEDED,
    });
    expect(bg?.kind === "contrast" && bg.ratio).toBeLessThan(4.5);
    expect(bg?.message).toMatch(
      /^In dark, the second text \(mid\) on the ground \(bg\) is 1\.\d\d:1; it needs 4\.5:1\. Make mid lighter, or bg darker\.$/,
    );
    // Every surface mid is drawn on fails, each said once.
    expect(problems.map((p) => (p.kind === "contrast" ? p.surface : ""))).toEqual(
      CONTRAST_PAIRS.mid,
    );
  });

  it("checks a surface a theme changes against the default inks on it", () => {
    const problems = refused(theme({ light: { hit: "#3d2c00" } }));
    expect(problems).toEqual([
      expect.objectContaining({ kind: "contrast", mode: "light", ink: "hit-ink", surface: "hit" }),
    ]);
    expect(problems[0]?.message).toMatch(/Make hit-ink lighter, or hit darker\./);
  });

  it("never shows a failing ratio as 4.50", () => {
    // #777777 on white is 4.48.
    const [p] = refused(theme({ light: { secondary: "#777777" } }));
    expect(p?.kind === "contrast" && p.ratio).toBe(4.47);
  });

  it("checks each set on its own, with the default's values for what it leaves out", () => {
    // Fine in light, where #555 on white passes; the same ink on the dark default ground fails.
    expect(parseTheme(theme({ light: { mid: "#555555" } })).ok).toBe(true);
    expect(refused(theme({ dark: { mid: "#555555" } }))[0]).toMatchObject({
      mode: "dark",
      ink: "mid",
    });
    expect(refused(theme({ light: { mid: "#555555" }, dark: { mid: "#555555" } }))).toHaveLength(
      CONTRAST_PAIRS.mid?.length ?? 0,
    );
  });
});

describe("the format", () => {
  it("takes a name and one set or both, keeping only known tokens in normalised hex", () => {
    const r = parseTheme(
      JSON.stringify({
        name: "  Paper  ",
        light: { bg: "#FFF", hairline: "#dddddd80" },
        dark: { ink: "#EEEEEEFF" },
      }),
    );
    expect(r).toEqual({
      ok: true,
      theme: {
        name: "Paper",
        sets: { light: { bg: "#ffffff", hairline: "#dddddd80" }, dark: { ink: "#eeeeee" } },
      },
    });
    expect(parseTheme(theme({ dark: {} }))).toEqual({
      ok: true,
      theme: { name: "T", sets: { dark: {} } },
    });
    if (r.ok) {
      expect(themeSchemes(r.theme.sets)).toEqual(["light", "dark"]);
      expect(parseTheme(serializeTheme(r.theme))).toEqual(r);
    }
  });

  it("normalises the three hex forms", () => {
    expect(normaliseHex("#AbC")).toBe("#aabbcc");
    expect(normaliseHex("#A1B2C3")).toBe("#a1b2c3");
    expect(normaliseHex("#a1b2c3FF")).toBe("#a1b2c3");
    expect(normaliseHex("#a1b2c380")).toBe("#a1b2c380");
  });

  it("refuses text over 16 KB before reading it", () => {
    const big = theme({ light: { bg: "#ffffff" }, pad: "x".repeat(16 * 1024) });
    expect(reasons(big)).toEqual(["too-big"]);
    expect(refused(big)[0]?.message).toMatch(/at most 16 KB/);
    // Bytes, not characters: 6000 three-byte letters are over the limit.
    expect(reasons(JSON.stringify({ name: "ł".repeat(9000), light: {} }))).toEqual(["too-big"]);
  });

  it("refuses what is not a JSON object", () => {
    for (const text of ["", "{", "theme", "<style>"]) expect(reasons(text)).toEqual(["not-json"]);
    for (const text of ["null", "42", '"x"', "[]"]) expect(reasons(text)).toEqual(["not-object"]);
  });

  it("refuses a key that is not a theme's, anywhere", () => {
    expect(reasons(theme({ light: {}, css: "body{}" }))).toEqual(["unknown-key@css"]);
    expect(
      reasons(theme({ light: { background: "#fff", "--bg": "#fff", "acct-blue": "#fff" } })),
    ).toEqual([
      "unknown-key@light.background",
      "unknown-key@light.--bg",
      "unknown-key@light.acct-blue",
    ]);
    expect(reasons(theme({ light: { "mark-ball": "#fff" } }))).toEqual([
      "unknown-key@light.mark-ball",
    ]);
    expect(reasons(theme({ light: { bg: "#fff" }, sepia: {} }))).toEqual(["unknown-key@sepia"]);
  });

  it("refuses a value that is not hex: no CSS, no url, no name, no other form", () => {
    for (const value of [
      "url(https://example.com/x.png)",
      "red",
      "rgb(0,0,0)",
      "#ffff",
      "#fffff",
      "#ggg",
      "#ffffff;background:url(x)",
      " #ffffff",
      "var(--ink)",
      0,
      null,
      ["#fff"],
    ]) {
      expect(reasons(theme({ dark: { bg: value } })), String(value)).toEqual(["not-hex@dark.bg"]);
    }
  });

  it("refuses see-through colours where text is read, and allows them on lines", () => {
    expect(reasons(theme({ light: { bg: "#ffffff80" } }))).toEqual(["alpha@light.bg"]);
    expect(reasons(theme({ dark: { ink: "#ffffff00" } }))).toEqual(["alpha@dark.ink"]);
    expect(refused(theme({ dark: { ink: "#ffffff00" } }))[0]?.message).toMatch(/has to be opaque/);
    expect(
      parseTheme(
        theme({ light: { hairline: "#00000020", edge: "#0000004d", "agent-edge": "#5b45c980" } }),
      ).ok,
    ).toBe(true);
  });

  it("refuses a name that is missing, empty, too long or on more than one line", () => {
    for (const name of [undefined, "", "   ", 7, "x".repeat(61), "a\nb"]) {
      expect(reasons(JSON.stringify({ name, light: {} })), String(name)).toEqual(["name@name"]);
    }
    expect(parseTheme(JSON.stringify({ name: "x".repeat(60), light: {} })).ok).toBe(true);
  });

  it("refuses a theme with no set, and a set that is not an object", () => {
    expect(reasons(JSON.stringify({ name: "T" }))).toEqual(["no-set"]);
    expect(reasons(theme({ light: "#ffffff" }))).toEqual(["not-object@light"]);
  });

  it("says every format problem at once, and no ratio until the format is right", () => {
    expect(reasons(JSON.stringify({ light: { bg: "red", ink: "#ffffff" }, x: 1 }))).toEqual([
      "unknown-key@x",
      "name@name",
      "not-hex@light.bg",
    ]);
  });
});

describe("the built-in themes", () => {
  it("all pass the same check as a file", () => {
    for (const t of BUILT_IN_THEMES) {
      const r = parseTheme(JSON.stringify(t.file));
      expect(r.ok, t.id).toBe(true);
    }
  });

  it("have plain ids and names, one with both sets and one with one", () => {
    const schemes = BUILT_IN_THEMES.map((t) => {
      const r = parseTheme(JSON.stringify(t.file));
      return r.ok ? themeSchemes(r.theme.sets).length : 0;
    });
    expect(schemes).toContain(2);
    expect(schemes).toContain(1);
    for (const t of BUILT_IN_THEMES) {
      expect(t.id).toMatch(/^[a-z]+$/);
      expect(t.file.name).toMatch(/^[A-Z][a-z]+$/);
    }
    expect(new Set(BUILT_IN_THEMES.map((t) => t.id)).size).toBe(BUILT_IN_THEMES.length);
  });
});
