// Property tests (ADR 0125, ADR 0143): `parseMailto` is given made-up links by the thousand, and
// what must hold for every one of them is checked. The cases written by hand are in
// mailtoLink.test.ts; these look for the link nobody thought of.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  draftSections,
  isValidAddress,
  MAILTO_MAX_BODY,
  MAILTO_MAX_RECIPIENTS,
  MAILTO_MAX_SUBJECT,
  parseMailto,
} from "../src/index.ts";

/** Pieces a real link is made of, mixed with anything at all. */
const piece = fc.oneof(
  fc.constantFrom(
    "mailto:",
    "?",
    "&",
    "=",
    ",",
    "#",
    "@",
    ".",
    "%",
    "%0D%0A",
    "%0a",
    "%00",
    "%2C",
    "%40",
    "%3E",
    "%5B",
    "%E2%80%8B",
    "%E2%80%A8",
    "%F0%9F%98",
    "to",
    "cc",
    "bcc",
    "subject",
    "body",
    "attach",
    "Bcc:",
    "a@example.com",
    "x",
    "\r\n",
    "\u0000",
    "![](https://t.example/p.gif)",
    "<img src=x>",
    "-- ",
    "> ",
    "\\",
    "`",
    "*",
    "    ",
  ),
  fc.string({ maxLength: 8 }),
  fc.string({ unit: "binary", maxLength: 6 }),
);
const link = fc.array(piece, { maxLength: 60 }).map((pieces) => `mailto:${pieces.join("")}`);

const CONTROL = /[\p{Cc}\u2028\u2029]/u;

describe("parseMailto, for any link (ADR 0143)", () => {
  it("never throws, for any string at all", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (text) => {
        parseMailto(text);
        parseMailto(`mailto:${text}`);
      }),
      { numRuns: 2000 },
    );
  });

  it("keeps within its limits, and gives addresses the composer takes, each once", () => {
    fc.assert(
      fc.property(link, (href) => {
        const draft = parseMailto(href);
        if (draft === null) return;
        const all = [...draft.to, ...draft.cc, ...draft.bcc];
        expect(all.length).toBeLessThanOrEqual(MAILTO_MAX_RECIPIENTS);
        expect(new Set(all.map((a) => a.toLowerCase())).size).toBe(all.length);
        for (const address of all) {
          expect(isValidAddress(address)).toBe(true);
          expect(CONTROL.test(address)).toBe(false);
        }
        expect(draft.subject.length).toBeLessThanOrEqual(MAILTO_MAX_SUBJECT);
        // Escaping adds at most one backslash per character.
        expect(draft.body.length).toBeLessThanOrEqual(2 * MAILTO_MAX_BODY);
      }),
      { numRuns: 3000 },
    );
  });

  it("has no control character in the subject, and only line feeds and tabs in the body", () => {
    fc.assert(
      fc.property(link, (href) => {
        const draft = parseMailto(href);
        if (draft === null) return;
        expect(CONTROL.test(draft.subject)).toBe(false);
        expect(CONTROL.test(draft.body.replace(/[\n\t]/g, ""))).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  it("never gives a body with a link, an image, code, a quote or a signature of its own", () => {
    fc.assert(
      fc.property(link, (href) => {
        const draft = parseMailto(href);
        if (draft === null) return;
        // Every bracket, backtick and asterisk is escaped: an odd run of backslashes before it.
        for (const match of draft.body.matchAll(/(\\*)[[\]`*]/g)) {
          expect((match[1] ?? "").length % 2).toBe(1);
        }
        // No line is indented enough to be a code block.
        for (const line of draft.body.split("\n")) expect(line).not.toMatch(/^(?: {4}| {0,3}\t)/);
        const sections = draftSections(draft.body);
        expect(sections.signature).toBe("");
        expect(sections.quote).toBe("");
      }),
      { numRuns: 3000 },
    );
  });
});
