// Property test (ADR 0125, ADR 0143, rule 3): a `mailto:` link's body is plain text, and what the
// app's own renderer makes of it must read as that text. For any body, the HTML of
// `plainBodyMarkdown(body)` holds the body's text and nothing else (white space aside, which HTML
// collapses), in paragraphs and line breaks, with no element but a link that a bare address makes
// to itself. The core cannot import the renderer, so the property lives here.
import { plainBodyMarkdown } from "@matters/core";
import fc from "fast-check";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { MarkdownComposeRenderer } from "../src/index.ts";

const renderer = new MarkdownComposeRenderer();

/** What a body is made of: Markdown's markup, its block starts, addresses, and anything at all. */
const piece = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(..."\\[]`*_~<>&!#+-=|:.)(\"' \t\n0123456789aZ") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "\n\n",
      "    ",
      "\t",
      "   ",
      "word",
      "snake_case",
      "-- ",
      "> ",
      "# ",
      "1. ",
      "2) ",
      "- ",
      "+ ",
      "* ",
      "===",
      "---",
      "***",
      "___",
      "```",
      "~~~",
      "~~",
      "|---|---|",
      "| a | b |",
      ":-:",
      "**",
      "__",
      "``",
      "![x](https://t.example/p.gif)",
      "[x](https://phish.example)",
      "[x]: https://phish.example",
      "<https://a.example>",
      "<a@b.example>",
      "<img src=x>",
      "&amp;",
      "&#38;",
      "&#x26;",
      "&copy;",
      "https://a.example/",
      "https://a.example/_next/x",
      "http://b.example",
      "a@b.example",
      "mailto:a@b.example",
      "\\\n",
      "  \n",
      "\u00a0",
      "ż",
      "😀",
    ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 6 }) },
);
const body = fc.array(piece, { maxLength: 40 }).map((pieces) => pieces.join(""));

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decode(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name.toLowerCase()];
    if (value === undefined) throw new Error(`unexpected entity ${whole}`);
    return value;
  });
}

/** The HTML inside the message's body. */
function inner(html: string): string {
  const open = /<div class="matters-body"[^>]*>/.exec(html);
  if (open === null) throw new Error("no body");
  return html.slice(open.index + open[0].length, html.lastIndexOf("</div>"));
}

/** The body's text as the person reads it: control characters gone, white space as one space. */
const plain = (text: string) =>
  text
    .replace(/[\r\u2028\u2029]/g, "\n")
    .replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .replace(/\s+/g, " ")
    .trim();

/** The href Markdown gives an address (punycode host, percent-encoded): markdown-it's own. */
const asUrl = (address: string) => new MarkdownIt().normalizeLink(address);

/** Markdown shows a web address in its link decoded (percent-escapes, punycode): not the text. */
const ADDRESS_DECODED = /:\/\/\S*(?:%[0-9a-f]{2}|xn--)/i;

describe("the body of a mailto: link, rendered (ADR 0143)", () => {
  it("reads as its text, in paragraphs and line breaks, with only bare addresses linked", () => {
    fc.assert(
      fc.property(body, (text) => {
        fc.pre(!ADDRESS_DECODED.test(text));
        const html = inner(renderer.render(plainBodyMarkdown(text)).html);
        for (const tag of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
          expect(["p", "br", "a"], `<${tag[1]}> for ${JSON.stringify(text)}`).toContain(tag[1]);
        }
        for (const link of html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)) {
          const href = decode(link[1] as string);
          const shown = decode(link[2] as string);
          expect(text).toContain(shown);
          // Its address is the text that is seen (an e-mail address gets `mailto:`), as a URL.
          expect([shown, `mailto:${shown}`].map(asUrl)).toContain(href);
        }
        const seen = plain(decode(html.replace(/<[^>]*>/g, "")));
        expect(seen, JSON.stringify(text)).toBe(plain(text));
      }),
      { numRuns: 5000 },
    );
  });

  it("keeps the text of a code span, a list, a heading, an entity and an autolink", () => {
    for (const text of [
      "`array[0]`",
      "```\nconst a = b[0];\n```",
      "~~~\nx\n~~~",
      "    indented[0]\n\tand tabbed_",
      "*really* _now_ **bold** ~~gone~~",
      "# title\nlist:\n- one\n+ two\n1. three\n2) four",
      "Title\n===\nOther\n---\n***\n| a | b |\n|---|---|",
      "&amp; &#38; <https://a.example> <a@b.example>",
      "line\\\nbreak",
    ]) {
      const html = inner(renderer.render(plainBodyMarkdown(text)).html);
      expect(html).not.toMatch(/<(?!\/?(?:p|br|a)\b)/);
      expect(plain(decode(html.replace(/<[^>]*>/g, "")))).toBe(plain(text));
    }
  });
});
