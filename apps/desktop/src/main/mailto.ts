// What leaves the app for the system's mail program (ADR 0048, RFC 6068 section 4 and 7). Pure, so
// main and the tests use the same function.

const NOT_AN_ADDRESS = /[\p{Cc}\s<>"\\?#]/u;
const LINE_BREAKS = /[\r\n]+/g;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Percent-encoded, with `@` left readable. */
const encode = (text: string) => encodeURIComponent(text).replaceAll("%40", "@");

/**
 * A `mailto:` rebuilt from only what is believed safe: the address list, and the `subject` and
 * `body` fields. Everything else is dropped, whatever it is called and however its name is spelled
 * (`attach`, `attachment`, `%61ttach`, `bcc`, `cc`, `to`, unknown fields, a fragment): a mail
 * program may act on them, for example by attaching a local file (RFC 6068 section 4: only
 * `subject`, `keywords` and `body` are believed safe). An address that is malformed is dropped.
 * Line breaks are removed from a subject so it cannot become a second header. Never throws.
 */
export function safeMailto(href: string): string {
  const withoutScheme = href.trim().replace(/^mailto:/i, "");
  const hash = withoutScheme.indexOf("#");
  const body = hash < 0 ? withoutScheme : withoutScheme.slice(0, hash);
  const question = body.indexOf("?");
  const path = question < 0 ? body : body.slice(0, question);
  const query = question < 0 ? "" : body.slice(question + 1);

  const addresses: string[] = [];
  for (const part of path.split(",")) {
    const address = decode(part);
    if (address === null || address === "" || !address.includes("@")) continue;
    if (NOT_AN_ADDRESS.test(address) || address.includes(",")) continue;
    addresses.push(encode(address));
  }

  const fields = new Map<"subject" | "body", string>();
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    const name = decode(pair.slice(0, equals))?.toLowerCase();
    if (name !== "subject" && name !== "body") continue;
    // The first of a repeated field wins; a later one cannot replace it.
    if (fields.has(name)) continue;
    const value = decode(pair.slice(equals + 1));
    if (value === null) continue;
    fields.set(name, encode(name === "subject" ? value.replace(LINE_BREAKS, " ") : value));
  }

  const hfields = [...fields].map(([name, value]) => `${name}=${value}`).join("&");
  return `mailto:${addresses.join(",")}${hfields === "" ? "" : `?${hfields}`}`;
}

/**
 * The address to hand to the system for a link, or `null` when nothing may leave: only web
 * addresses (unchanged) and mail addresses (rebuilt by `safeMailto`).
 */
export function linkForSystem(href: string): string | null {
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return safeMailto(href);
  return null;
}
