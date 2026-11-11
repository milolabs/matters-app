import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { personMark, personTint, TINT_COUNT } from "../src/renderer/personMark.ts";

type Rgb = readonly [number, number, number];

const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

/** The custom properties of the first block that opens with `opener` (light: `:root {`). */
function tokens(opener: string): Map<string, string> {
  const at = css.indexOf(opener);
  const end = css.indexOf("\n}", at);
  const out = new Map<string, string>();
  for (const m of css.slice(at, end).matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out.set(m[1] as string, m[2] as string);
  }
  return out;
}

const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const mix = (a: Rgb, b: Rgb, share: number): Rgb =>
  [0, 1, 2].map((i) => (a[i] as number) * share + (b[i] as number) * (1 - share)) as unknown as Rgb;
const lin = (c: number) =>
  c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const HUES = ["blue", "ochre", "green", "plum", "indigo", "rust", "teal", "graphite"] as const;

describe("personTint", () => {
  it("is stable, case-blind and inside the fixed set", () => {
    expect(personTint("anna@example.com")).toBe(personTint("anna@example.com"));
    expect(personTint("Anna@Example.COM")).toBe(personTint("anna@example.com"));
    for (const a of ["a@b.c", "x@y.z", "jan@lodz.pl", "", "Łukasz@zrodlo.pl"]) {
      const t = personTint(a);
      expect(Number.isInteger(t) && t >= 0 && t < TINT_COUNT).toBe(true);
    }
  });

  it("spreads people over the set", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(personTint(`person${i}@example.com`));
    expect(seen.size).toBe(TINT_COUNT);
  });

  it("has one css rule per hue, on the account palette", () => {
    expect(HUES).toHaveLength(TINT_COUNT);
    HUES.forEach((hue, i) => {
      expect(css).toContain(`.avatar[data-tint="${i}"] {\n  --tint: var(--acct-${hue});`);
    });
  });
});

describe("personMark", () => {
  it("gives the letters of the name, or of the address, and the tint of the address", () => {
    expect(personMark("anna@example.com", "Anna Nowak")).toEqual({
      initials: "AN",
      tint: personTint("anna@example.com"),
    });
    expect(personMark("anna.nowak@example.com").initials).toBe("AN");
  });

  it("answers the same object for the same person", () => {
    expect(personMark("a@b.c", "A B")).toBe(personMark("a@b.c", "A B"));
  });
});

describe("avatar contrast (ADR 0078)", () => {
  // The css: letters = hue 70 % + ink 30 %, on hue 24 % + page 76 %.
  const share = {
    wash: Number(/color-mix\(in srgb, var\(--tint\) (\d+)%, var\(--bg\)\)/.exec(css)?.[1]) / 100,
    ink:
      Number(/color: color-mix\(in srgb, var\(--tint\) (\d+)%, var\(--ink\)\)/.exec(css)?.[1]) /
      100,
  };
  const themes = [
    ["light", tokens(":root {")],
    ["dark", tokens("@media (prefers-color-scheme: dark) {\n  :root {")],
  ] as const;

  it("reads the shares from the stylesheet", () => {
    expect(share.wash).toBeCloseTo(0.24);
    expect(share.ink).toBeGreaterThan(0.5);
  });

  for (const [theme, t] of themes) {
    it(`keeps the letters at 4.5:1 or more on every hue in ${theme}`, () => {
      const bg = rgb(t.get("--bg") as string);
      const ink = rgb(t.get("--ink") as string);
      for (const hue of HUES) {
        const base = rgb(t.get(`--acct-${hue}`) as string);
        const ratio = contrast(mix(base, ink, share.ink), mix(base, bg, share.wash));
        expect(ratio, `${theme} ${hue}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
