import { describe, expect, it } from "vitest";
import {
  darkColor,
  darkenCss,
  darkenMail,
  mailTheme,
  mailView,
} from "../src/renderer/mailTheme.ts";

describe("what a message says about themes", () => {
  it("has its own dark variant in a media query", () => {
    const clean =
      "<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style>";
    expect(mailTheme(clean, clean)).toBe("dark");
  });

  it("declares dark in a color-scheme meta or property", () => {
    expect(mailTheme('<meta name="color-scheme" content="light dark">', "<p>x</p>")).toBe("dark");
    expect(mailTheme("<meta name=supported-color-schemes content='light dark'>", "")).toBe("dark");
    expect(mailTheme("", '<html style="color-scheme: light dark"><body></body></html>')).toBe(
      "dark",
    );
    expect(mailTheme("", "<style>:root{color-scheme:light dark}</style>")).toBe("dark");
  });

  it("asks to stay light", () => {
    expect(mailTheme('<meta name="color-scheme" content="only light">', "")).toBe("light-only");
    expect(mailTheme("", "<style>:root { color-scheme: light only; }</style>")).toBe("light-only");
  });

  it("says nothing, and text of the message never counts", () => {
    expect(mailTheme("", "<p>Use prefers-color-scheme: dark and color-scheme: dark</p>")).toBe(
      "none",
    );
    expect(mailTheme('<meta name="viewport" content="dark">', "")).toBe("none");
    expect(mailTheme("", "<style>/* prefers-color-scheme: dark */ p{}</style>")).toBe("none");
  });
});

describe("the view for the app's theme", () => {
  const darken = (html: string) => `dark:${html}`;

  it("leaves every message alone in light", () => {
    for (const theme of ["dark", "light-only", "none"] as const) {
      expect(mailView({ html: "m", theme }, false, darken)).toEqual({ html: "m", scheme: "light" });
    }
  });

  it("gives the sender's own dark variant, keeps light-only light, recolors the rest", () => {
    expect(mailView({ html: "m", theme: "dark" }, true, darken)).toEqual({
      html: "m",
      scheme: "dark",
    });
    expect(mailView({ html: "m", theme: "light-only" }, true, darken)).toEqual({
      html: "m",
      scheme: "light",
    });
    expect(mailView({ html: "m", theme: "none" }, true, darken)).toEqual({
      html: "dark:m",
      scheme: "dark",
    });
  });
});

const lightness = ([r, g, b]: readonly number[]) =>
  0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);

describe("one color for dark", () => {
  it("turns a light ground dark and white into the app's ground", () => {
    const white = darkColor([1, 1, 1], "ground");
    expect(white).not.toBeNull();
    const hex = (white ?? []).map((c) => Math.round(c * 255));
    // #1e1e20 is the app's ground; the hue of white has none, so it lands on the grey of it.
    for (const c of hex) expect(Math.abs(c - 0x1e)).toBeLessThanOrEqual(3);
  });

  it("keeps dark grounds and light ink, which were already right", () => {
    expect(darkColor([0.1, 0.1, 0.1], "ground")).toBeNull();
    expect(darkColor([1, 1, 1], "ink")).toBeNull();
  });

  it("turns dark ink light and keeps its hue", () => {
    const blue = darkColor([0.1, 0.34, 0.77], "ink");
    expect(blue).not.toBeNull();
    const [r, g, b] = blue ?? [0, 0, 0];
    expect(lightness([r, g, b])).toBeGreaterThan(0.35);
    expect(b).toBeGreaterThan(r);
  });
});

describe("recoloring markup, as text", () => {
  it("recolors grounds and ink in declarations, and leaves other properties", () => {
    const out = darkenCss(
      "body{background:#ffffff;color:#000;font-family:Red Hat}a:hover{color:navy}p{color:red}",
    );
    expect(out).not.toContain("#ffffff");
    expect(out).not.toContain("color:#000;");
    expect(out).toContain("font-family:Red Hat");
    expect(out).toContain("a:hover{color:#");
    expect(out).toContain("p{color:red}");
  });

  it("keeps what is in url(), alpha, and !important", () => {
    const out = darkenCss(
      "background: #fff url(white.png) no-repeat !important; color: rgba(0,0,0,0.5)",
    );
    expect(out).toContain("url(white.png)");
    expect(out).toContain("!important");
    expect(out).toMatch(/color: #[0-9a-f]{6}80/);
  });

  it("recolors style sheets, style and color attributes, but not the message's text", () => {
    const html =
      '<style>td{background-color:white}</style><table bgcolor="#FFFFFF"><tr><td style="color: #222">' +
      'white text says color: black</td></tr></table><font color="black">x</font>';
    const out = darkenMail(html);
    expect(out).not.toContain("background-color:white");
    expect(out).not.toContain('bgcolor="#FFFFFF"');
    expect(out).not.toContain("color: #222");
    expect(out).not.toContain('color="black"');
    expect(out).toContain("white text says color: black");
  });

  it("leaves a message without colors as it is", () => {
    const html = '<p class="x">Hello <a href="https://example.com">there</a></p>';
    expect(darkenMail(html)).toBe(html);
  });

  it("stays fast on a big newsletter", () => {
    const row =
      '<tr><td bgcolor="#f4f4f4" style="color:#333;border-bottom:1px solid #e5e5e5">Item</td></tr>';
    const html = `<style>${"p{color:#111;background:#fafafa}".repeat(500)}</style><table>${row.repeat(5000)}</table>`;
    const started = performance.now();
    darkenMail(html);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
