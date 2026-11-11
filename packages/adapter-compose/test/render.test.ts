import { describe, expect, it } from "vitest";
import { MarkdownComposeRenderer } from "../src/index.ts";

const renderer = new MarkdownComposeRenderer();
const html = (md: string) => renderer.render(md).html;

const TAGS = new Set(
  "html head meta body div p a strong em s ul ol li blockquote code pre h1 h2 h3 h4 h5 h6 hr br table thead tbody tr th td".split(
    " ",
  ),
);
const ATTRIBUTES = new Set(["href", "style", "class", "title", "charset", "start", "align"]);
const SAFE_HREF = /^(https?:|mailto:)/i;

/**
 * Reads the output the way a mail client would: every real tag must be one of ours, every real
 * attribute one we set, every href a safe scheme. Text that merely looks like markup is escaped
 * and has no `<`, so it never reaches this check.
 */
function assertInert(out: string): void {
  const body = out.replace(/<!doctype html>/i, "");
  for (const m of body.matchAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g,
  )) {
    const tag = (m[2] as string).toLowerCase();
    expect(TAGS.has(tag), `tag <${tag}>`).toBe(true);
    for (const a of (m[3] as string).matchAll(/\s+([^\s=>]+)(?:="([^"]*)")?/g)) {
      const name = (a[1] as string).toLowerCase();
      expect(ATTRIBUTES.has(name), `attribute ${name} on <${tag}>`).toBe(true);
      if (name === "href") expect(SAFE_HREF.test(a[2] as string), `href ${a[2]}`).toBe(true);
    }
  }
  // Nothing that looks like a tag is left outside the ones we just checked.
  const remaining = body.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  expect(remaining).not.toMatch(/</);
}

describe("safety", () => {
  it("the checker itself catches what it is meant to", () => {
    for (const bad of [
      "<script>x</script>",
      '<p onclick="x">a</p>',
      '<a href="javascript:x">a</a>',
      '<img src="x">',
      "<p>a</p><",
    ]) {
      expect(() => assertInert(bad), bad).toThrow();
    }
    expect(() => assertInert('<p style="a: b">ok &lt;script&gt;</p>')).not.toThrow();
  });

  const attacks: Record<string, string> = {
    "raw script": "<script>alert(1)</script>",
    "script in a paragraph": "hello <script>fetch('//evil')</script> world",
    "image onerror": '<img src=x onerror="alert(1)">',
    "markdown image with a handler": '![x](x" onerror="alert(1))',
    "svg onload": "<svg onload=alert(1)>",
    iframe: '<iframe src="https://evil.example"></iframe>',
    "style tag": "<style>body{background:url(//evil)}</style>",
    "javascript link": "[click](javascript:alert(1))",
    "javascript link, mixed case": "[click](JaVaScRiPt:alert(1))",
    "javascript link, entity": "[click](jav&#x61;script:alert(1))",
    "javascript link, tab": "[click](java\tscript:alert(1))",
    "javascript link, leading space": "[click]( javascript:alert(1))",
    "data link": "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "vbscript link": "[click](vbscript:msgbox(1))",
    "file link": "[click](file:///etc/passwd)",
    autolink: "<javascript:alert(1)>",
    "reference link": "[click][r]\n\n[r]: javascript:alert(1)",
    "entities hiding a tag": "&lt;script&gt;alert(1)&lt;/script&gt;",
    "entity-encoded tag": "&#60;script&#62;alert(1)&#60;/script&#62;",
    "html comment tricks": "<!-- --><script>alert(1)</script>",
    "attribute break-out in a link title": '[a](http://x.pl "t\\" onmouseover=\\"alert(1)")',
    "link text with markup": "[<b onclick=alert(1)>x</b>](http://x.pl)",
    "code span with a tag": "`<script>alert(1)</script>`",
    "fenced code": "```html\n<script>alert(1)</script>\n```",
    "table cell": "| a |\n|---|\n| <script>alert(1)</script> |",
    "meta refresh": '<meta http-equiv="refresh" content="0;url=//evil">',
  };

  for (const [name, source] of Object.entries(attacks)) {
    it(`leaves nothing executable: ${name}`, () => {
      assertInert(html(source));
    });
  }

  it("shows raw HTML as text instead of dropping it", () => {
    expect(html("<b>x</b>")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("links only http, https and mailto", () => {
    const out = html(
      "[a](https://example.com/a?b=1&c=2) [b](http://example.com) [c](mailto:anna@x.pl) [d](ftp://x.pl) [e](/relative) [f](#frag)",
    );
    expect(out).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(out).toContain('href="http://example.com"');
    expect(out).toContain('href="mailto:anna@x.pl"');
    expect(out).not.toContain('href="ftp:');
    expect(out).not.toContain('href="/relative"');
    expect(out).not.toContain('href="#frag"');
    expect(out.match(/<a /g)).toHaveLength(3);
  });

  it("links bare URLs but not file names that look like domains", () => {
    const out = html("see https://example.com/x and report.pdf or index.js");
    expect(out).toContain('<a href="https://example.com/x"');
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it("never fetches anything: no image, no remote stylesheet", () => {
    const out = html("![logo](https://evil.example/pixel.png)");
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/src=/i);
  });

  it("the preview is the sent HTML: same function, same bytes", () => {
    const md = "**x** [a](https://example.com)";
    expect(renderer.render(md)).toEqual(new MarkdownComposeRenderer().render(md));
  });
});

describe("rendering", () => {
  it("keeps Polish text intact in HTML and text", () => {
    const md = "Zażółć gęślą jaźń. **Pozdrawiam**, Łukasz";
    const out = renderer.render(md);
    expect(out.html).toContain("Zażółć gęślą jaźń.");
    expect(out.html).toContain("<strong");
    expect(out.html).toContain("Łukasz");
    expect(out.html).toContain('<meta charset="utf-8">');
    expect(out.text).toBe(md);
  });

  it("renders lists", () => {
    const out = html("- jeden\n- dwa\n\n1. pierwszy\n2. drugi");
    expect(out.match(/<li/g)).toHaveLength(4);
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
  });

  it("renders tables with inline styles", () => {
    const out = html("| Pozycja | Cena |\n|---|---|\n| Okna | 36 000 zł |");
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("36 000 zł");
    expect(out).toMatch(/<td style="[^"]*border/);
  });

  it("renders a quoted reply as a blockquote, keeping line breaks", () => {
    const out = html(
      "Dziękuję.\n\nOn 3 Nov 2026, 12:05, Anna wrote:\n> Prosimy o wycenę\n> do piątku",
    );
    expect(out).toContain("<blockquote");
    expect(out).toMatch(/Prosimy o wycenę<br>\s*do piątku/);
    expect(out).toContain("wrote:");
  });

  it("inlines the styles and leaves no style or class dependency behind", () => {
    const out = html("Hej\n\n> cytat");
    expect(out).not.toContain("<style");
    expect(out).toMatch(/<p style="[^"]+">Hej<\/p>/);
    expect(out).toMatch(/<blockquote style="[^"]*border-left/);
  });

  it("is a complete document, UTF-8", () => {
    const out = html("x");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("</html>");
  });

  it("copes with the empty draft and with CRLF", () => {
    expect(renderer.render("").text).toBe("");
    expect(html("a\r\nb")).toContain("a<br>");
  });

  it("is fast enough to render on every keystroke", () => {
    const md = "Cześć **Anna**,\n\n- a\n- b\n\n> cytat\n".repeat(20);
    renderer.render(md);
    const start = performance.now();
    for (let i = 0; i < 50; i++) renderer.render(md);
    expect((performance.now() - start) / 50).toBeLessThan(10);
  });
});
