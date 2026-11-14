import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAIL_GROUND,
  darkColor,
  darkenCss,
  darkenMail,
  groundLch,
  mailBaseStyle,
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

// ADR 0134, rule 10: in dark, the ground and ink under a message are the theme's.
describe("mail on a theme's ground", () => {
  const night = { bg: "#141416", ink: "#ececef" };
  const paper = { bg: "#1f1d1a", ink: "#f3efe7" };
  const bytes = (rgb: readonly number[] | null) => (rgb ?? []).map((c) => Math.round(c * 255));

  it("puts the theme's ground and ink in the base style, in dark only", () => {
    const html = `${mailBaseStyle()}<p>Hi</p>`;
    const dark = mailView({ html, theme: "none" }, true, undefined, night);
    expect(dark.html).toContain(
      "@media (prefers-color-scheme:dark){html{background:#141416;color:#ececef}",
    );
    expect(dark.html).not.toContain("#1e1e20");
    expect(dark.html.endsWith("<p>Hi</p>")).toBe(true);
    // A sender's own dark variant also lands on the theme's ground.
    expect(mailView({ html, theme: "dark" }, true, undefined, night).html).toContain(
      "background:#141416",
    );
    // In light a message is shown as sent, on white, whatever the theme.
    expect(mailView({ html, theme: "none" }, false, undefined, night)).toEqual({
      html,
      scheme: "light",
    });
    expect(mailView({ html, theme: "light-only" }, true, undefined, night)).toEqual({
      html,
      scheme: "light",
    });
  });

  it("leaves the default's ground as it was, and takes only plain hex", () => {
    const html = `${mailBaseStyle()}<p>Hi</p>`;
    expect(mailView({ html, theme: "dark" }, true, undefined, DEFAULT_MAIL_GROUND).html).toBe(html);
    expect(mailBaseStyle()).toContain("background:#1e1e20;color:#f5f5f7");
    const odd = { bg: "red;}body{display:none", ink: "#ffffff" };
    expect(mailView({ html, theme: "dark" }, true, undefined, odd).html).toBe(html);
  });

  it("recolors white onto the theme's ground itself, and keeps a brand's hue", () => {
    for (const ground of [night, paper]) {
      const white = bytes(darkColor([1, 1, 1], "ground", groundLch(ground)));
      const bg = [1, 3, 5].map((i) => Number.parseInt(ground.bg.slice(i, i + 2), 16));
      for (const [i, c] of white.entries()) {
        expect(Math.abs(c - (bg[i] ?? 0)), ground.bg).toBeLessThanOrEqual(2);
      }
    }
    // A light blue ground stays blue, a little darker than the theme's ground's lightness above it.
    const blue = darkColor([0.85, 0.9, 1], "ground", groundLch(night));
    expect((blue?.[2] ?? 0) > (blue?.[0] ?? 1)).toBe(true);
  });

  it("darkens a message's white table onto the theme's ground", () => {
    const out = mailView(
      {
        html: `${mailBaseStyle()}<table bgcolor="#ffffff"><tr><td>x</td></tr></table>`,
        theme: "none",
      },
      true,
      undefined,
      night,
    ).html;
    const m = /bgcolor="(#[0-9a-f]{6})"/.exec(out);
    expect(m?.[1]).toBeDefined();
    const got = [1, 3, 5].map((i) => Number.parseInt((m?.[1] ?? "").slice(i, i + 2), 16));
    const want = [0x14, 0x14, 0x16];
    for (const [i, c] of got.entries()) {
      expect(Math.abs(c - (want[i] ?? 0))).toBeLessThanOrEqual(2);
    }
    // Without a theme it lands on the default's, as before.
    expect(darkenMail('<table bgcolor="#ffffff"></table>')).toMatch(/bgcolor="#1[ef]1[ef]1[ef]"/);
  });
});
