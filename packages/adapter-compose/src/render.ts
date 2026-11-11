import type { ComposeRendererPort, RenderedMessage } from "@matters/core";
import juice from "juice";
import MarkdownIt from "markdown-it";
import { MAIL_CSS } from "./stylesheet.ts";

/** Only these schemes become links (ADR 0020, rule 11). */
const SAFE_LINK = /^(https?:|mailto:)/i;

function createMarkdown() {
  // `html: false`: raw HTML in the source is shown as text, so no user HTML ever enters the output.
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyIP: false });
  md.validateLink = (url) => SAFE_LINK.test(url.trim());
  // No remote or embedded images until attachments exist; the source stays visible instead.
  md.disable("image");
  return md;
}

const juiceOptions = {
  removeStyleTags: true,
  preserveMediaQueries: false,
  preserveFontFaces: false,
  preserveImportant: false,
  applyStyleTags: false,
  applyAttributesTableElements: false,
  inlinePseudoElements: false,
  insertPreservedExtraCss: false,
  // Nothing is fetched: there are no linked stylesheets, and there must never be.
  webResources: { links: false, images: false, scripts: false },
} as const;

/**
 * Markdown to the HTML part of a message (ADR 0020, rules 11-12): markdown-it with raw HTML off
 * and safe link schemes only, then juice inlines a small built-in stylesheet. `text` is the
 * Markdown source itself. The preview and the sent message call this very function.
 */
export class MarkdownComposeRenderer implements ComposeRendererPort {
  private readonly md = createMarkdown();

  render(markdown: string): RenderedMessage {
    const body = this.md.render(markdown);
    const page =
      '<!doctype html><html><head><meta charset="utf-8"></head>' +
      `<body><div class="matters-body">${body}</div></body></html>`;
    const html = juice.inlineContent(page, MAIL_CSS, juiceOptions);
    return { html, text: markdown };
  }
}
