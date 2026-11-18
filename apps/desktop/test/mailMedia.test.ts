import { describe, expect, it } from "vitest";
import { type DeviceQuery, screenMediaCss, screenMediaList } from "../src/renderer/mailMedia.ts";

/** A retina screen that updates fast, in colour. */
const retina: DeviceQuery = (feature) => {
  if (/resolution|pixel-ratio/.test(feature)) return /min/.test(feature) || />/.test(feature);
  if (/update/.test(feature)) return /fast/.test(feature);
  return !/monochrome/.test(feature);
};

const sheet = (css: string) => screenMediaCss(css, retina);

describe("screenMediaList (ADR 0144, rule 3)", () => {
  it("never matches print, and always matches screen", () => {
    expect(screenMediaList("print", retina)).toBeNull();
    expect(screenMediaList("only print", retina)).toBeNull();
    expect(screenMediaList("print and (color)", retina)).toBeNull();
    expect(screenMediaList("screen", retina)).toBe("all");
    expect(screenMediaList("only screen and (max-width: 600px)", retina)).toBe(
      "only all and (max-width: 600px)",
    );
  });

  it("keeps the meaning of not", () => {
    // `not print` is true on screen whatever follows; `not screen` never is.
    expect(screenMediaList("not print", retina)).toBe("all");
    expect(screenMediaList("not print and (min-width: 1px)", retina)).toBe("all");
    expect(screenMediaList("not screen", retina)).toBe("not all");
    expect(screenMediaList("not screen and (max-width: 600px)", retina)).toBe(
      "not all and (max-width: 600px)",
    );
  });

  it("keeps a list of queries that can match on screen, and drops the others", () => {
    expect(screenMediaList("print, screen and (min-width: 400px)", retina)).toBe(
      "all and (min-width: 400px)",
    );
    expect(screenMediaList("print, speech", retina)).toBe("speech");
    expect(screenMediaList("", retina)).toBe("all");
    expect(screenMediaList("print, ", retina)).toBeNull();
  });

  it("reads escapes and comments as the browser does", () => {
    expect(screenMediaList("pr\\69nt", retina)).toBeNull();
    expect(screenMediaList("PRINT", retina)).toBeNull();
    expect(screenMediaList("/* x */ print /* y */", retina)).toBeNull();
    expect(screenMediaList("\\70 rint", retina)).toBeNull();
  });

  it("answers features of the output device by the screen, and leaves the frame's own", () => {
    expect(screenMediaList("(min-resolution: 2dppx)", retina)).toBe("(min-width:0px)");
    expect(screenMediaList("(max-resolution: 1dppx)", retina)).toBe("(max-width:0px)");
    expect(screenMediaList("(-webkit-min-device-pixel-ratio: 2)", retina)).toBe("(min-width:0px)");
    expect(screenMediaList("(update: fast)", retina)).toBe("(min-width:0px)");
    expect(screenMediaList("(update: none)", retina)).toBe("(max-width:0px)");
    expect(screenMediaList("(monochrome)", retina)).toBe("(max-width:0px)");
    expect(screenMediaList("not (color)", retina)).toBe("not (min-width:0px)");
    expect(screenMediaList("(resolution >= 2dppx)", retina)).toBe("(min-width:0px)");
    expect(screenMediaList("screen and (max-width: 600px) and (update: none)", retina)).toBe(
      "all and (max-width: 600px) and (max-width:0px)",
    );
    // The theme and the frame's size stay questions: the reader answers them (ADR 0085).
    expect(screenMediaList("(prefers-color-scheme: dark)", retina)).toBe(
      "(prefers-color-scheme: dark)",
    );
    expect(screenMediaList("(orientation: portrait)", retina)).toBe("(orientation: portrait)");
  });
});

describe("screenMediaCss (ADR 0144, rule 3)", () => {
  it("drops a print block, so paper cannot show what the screen hides", () => {
    const css = ".iban{display:none}@media print{.iban{display:block}}p{color:red}";
    expect(sheet(css)).toBe(".iban{display:none}p{color:red}");
  });

  it("applies a screen block everywhere, so paper cannot hide what the screen shows", () => {
    const css = ".amount{display:none}@media screen{.amount{display:block}}";
    expect(sheet(css)).toBe(".amount{display:none}@media all{.amount{display:block}}");
  });

  it("drops @page, whose margin boxes write only on paper", () => {
    expect(sheet('@page{margin:0;@top-center{content:"IBAN"}}a{b:c}')).toBe("a{b:c}");
    expect(sheet("@PA\\47 E :first{margin:0}a{b:c}")).toBe("a{b:c}");
  });

  it("finds media rules inside other blocks and in nested rules", () => {
    expect(sheet("@supports (display:grid){@media print{x{y:z}}a{b:c}}")).toBe(
      "@supports (display:grid){a{b:c}}",
    );
    expect(sheet(".a{color:red;@media print{display:none}}")).toBe(".a{color:red;}");
    expect(sheet("@media screen{@media print{x{y:z}}a{b:c}}")).toBe("@media all{a{b:c}}");
  });

  it("reads an escaped at-keyword as the browser does", () => {
    expect(sheet("@\\6d edia print{x{y:z}}a{b:c}")).toBe("a{b:c}");
    expect(sheet("@MEDIA PRINT{x{y:z}}")).toBe("");
  });

  it("steps over strings and comments, never reading them as rules", () => {
    const css = 'a::before{content:"@media print{"}/* @media print{ */b{c:d}';
    expect(sheet(css)).toBe(css);
    expect(sheet("a{content:'}'}@media print{x{y:z}}")).toBe("a{content:'}'}");
  });

  it("closes a block left open at the end, as the browser does", () => {
    expect(sheet("a{b:c}@media print{x{y:z}")).toBe("a{b:c}");
    expect(sheet("@media screen{x{y:z}")).toBe("@media all{x{y:z}}");
  });

  it("keeps statements and everything else as written", () => {
    const css = '@charset "utf-8";@import url(x.css) print;@font-face{font-family:a}h1{x:y}';
    expect(sheet(css)).toBe(css);
    expect(sheet("@media (prefers-color-scheme:dark){a{b:c}}")).toBe(
      "@media (prefers-color-scheme:dark){a{b:c}}",
    );
  });

  it("takes linear time on a long sheet", () => {
    const css = `${"a{b:c}".repeat(50_000)}${"@media print{x{y:z}}".repeat(5_000)}`;
    const start = performance.now();
    expect(sheet(css)).toBe("a{b:c}".repeat(50_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
