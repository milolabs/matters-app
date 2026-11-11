import type { HtmlKind } from "@matters/core";

// What mail programs write around a person's own words, even with a layout table in a signature.
const WRITTEN_BY_A_PERSON =
  /class=["']?(?:MsoNormal|gmail_(?:quote|signature|default|attr)|moz-(?:cite-prefix|signature)|WordSection1)|id=["']?(?:divRplyFwdMsg|appendonsend|ms-outlook-mobile-signature)/i;

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

/**
 * Tells a page laid out by a sender from a letter written by a person. Bulk mail says so in its
 * headers; otherwise a page shows in its markup. A wrong guess is one click away from right: the
 * reader can switch views.
 */
export function classifyHtml(html: string, headerNames: ReadonlySet<string>): HtmlKind {
  if (headerNames.has("list-unsubscribe") || headerNames.has("list-id")) return "designed";
  if (WRITTEN_BY_A_PERSON.test(html)) return "simple";
  const tables = count(html, /<table[\s>]/gi);
  const images = count(html, /<img[\s>]/gi);
  const styled = /<style[\s>]/i.test(html);
  return tables >= 3 || (tables >= 1 && images >= 2) || (styled && images >= 1)
    ? "designed"
    : "simple";
}
