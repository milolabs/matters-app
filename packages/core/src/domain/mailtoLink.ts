/**
 * A `mailto:` link read as the start of a new message (ADR 0143, RFC 6068). The link comes from any
 * web page, any program or any mail, so it is hostile input: only the recipients, the subject and
 * the body are read, each within a limit, and nothing in it can attach a file, set another header
 * or put markup in the message that the person did not write. Pure, and never throws.
 */
import { hasAddressShape } from "./recipients.ts";

/** The longest link read, in characters as it arrives (still percent-encoded). Longer: refused. */
export const MAILTO_MAX_LENGTH = 32_768;
/** At most this many recipients, To, Cc and Bcc together; the ones after them are dropped. */
export const MAILTO_MAX_RECIPIENTS = 50;
/** A subject is cut to this many characters (998 is the longest line a header may have). */
export const MAILTO_MAX_SUBJECT = 998;
/** A body is cut to this many characters before it is made safe for the editor. */
export const MAILTO_MAX_BODY = 20_000;
/** The longest address kept (RFC 5321, section 4.5.3.1.3: a path of 256 with its brackets). */
const MAX_ADDRESS = 254;

/** A new message as a link asks for it. Addresses only, no names. */
export interface MailtoDraft {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  /** One line: no control characters and no line breaks. */
  readonly subject: string;
  /** Markdown that reads as the text the link carried (see `plainBodyMarkdown`). */
  readonly body: string;
}

type RecipientField = "to" | "cc" | "bcc";

/** What may not stand in an address taken from a link: it separates, quotes or comments one. */
const LINK_SPECIALS = '<>,;:"\\?#()[]';
/** Controls, format characters (zero-width, bidirectional), line and paragraph separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** The first `max` characters, never half of a pair of surrogates. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** An address as a link may give it: the address shape, nothing invisible, not too long. */
function isLinkAddress(text: string): boolean {
  return (
    text.length <= MAX_ADDRESS && !INVISIBLE.test(text) && hasAddressShape(text, LINK_SPECIALS)
  );
}

/** One line: line breaks and tabs become a space, other invisible characters go, then trimmed. */
function oneLine(text: string): string {
  return text
    .replace(/[\r\n\t\u2028\u2029\v\f]+/g, " ")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "")
    .trim();
}

/**
 * The text of a link's body as Markdown that reads as that text, so a link cannot write what the
 * person did not: no link or image (`[`, `]`; a bare web address still becomes a link, its address
 * the text that is seen), no quote that the reply's fold or the agent's split would take for
 * quoted mail (`>` at the start of a line), no signature delimiter that would stand for the
 * person's own (ADR 0142), and no backslash that would cancel one of these escapes. Raw HTML needs
 * nothing: the renderer shows it as text (ADR 0020, rule 11). Line ends become `\n`, and control
 * characters other than the line feed and the tab go.
 */
export function plainBodyMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\p{Cc}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .split("\n")
    .map((line) => {
      // A backslash before ASCII punctuation is Markdown's escape; doubled, it stays a backslash.
      let out = line.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\").replace(/[[\]]/g, "\\$&");
      out = out.replace(/^(\s*)>/, "$1\\>");
      if (/^--\s*$/.test(out)) out = `\\${out}`;
      return out;
    })
    .join("\n");
}

/**
 * Reads a `mailto:` link (RFC 6068): the addresses of its path and of its `to`, `cc` and `bcc`
 * fields, its `subject` and its `body`. Each part is percent-decoded once, after the link is split
 * at `?`, `&`, `=` and `,`, so an encoded `&` or `=` stays text; a decoded comma between addresses
 * separates them as a written one does. A field's name is read without regard to case. Every other
 * field is dropped, whatever it is called (`attach`, `attachment`, `from`, `reply-to`,
 * `in-reply-to`, `keywords`, unknown ones), and so is a fragment. A repeated `to`, `cc` or `bcc`
 * adds its addresses; for `subject` and `body` the first one wins. An address that is malformed,
 * or that is already a recipient, is dropped, never guessed. Null for a text that is not a
 * `mailto:` link or is longer than `MAILTO_MAX_LENGTH`.
 */
export function parseMailto(href: string): MailtoDraft | null {
  if (href.length > MAILTO_MAX_LENGTH) return null;
  const trimmed = href.trim();
  if (!/^mailto:/i.test(trimmed)) return null;
  const rest = trimmed.slice("mailto:".length);
  const hash = rest.indexOf("#");
  const link = hash < 0 ? rest : rest.slice(0, hash);
  const question = link.indexOf("?");
  const path = question < 0 ? link : link.slice(0, question);
  const query = question < 0 ? "" : link.slice(question + 1);

  const lists: Record<RecipientField, string[]> = { to: [], cc: [], bcc: [] };
  const seen = new Set<string>();
  let count = 0;
  const add = (field: RecipientField, raw: string) => {
    for (const piece of raw.split(",")) {
      const decoded = decode(piece);
      if (decoded === null) continue;
      for (const part of decoded.split(",")) {
        const address = part.trim();
        if (address === "" || !isLinkAddress(address)) continue;
        const key = address.toLowerCase();
        if (seen.has(key) || count >= MAILTO_MAX_RECIPIENTS) continue;
        seen.add(key);
        count++;
        lists[field].push(address);
      }
    }
  };

  add("to", path);
  let subject: string | null = null;
  let body: string | null = null;
  const later: { field: RecipientField; raw: string }[] = [];
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    const name = decode(pair.slice(0, equals))?.trim().toLowerCase();
    const raw = pair.slice(equals + 1);
    if (name === "to" || name === "cc" || name === "bcc") {
      // To before Cc before Bcc, whatever the order in the link: an address in two of them is To.
      later.push({ field: name, raw });
    } else if (name === "subject" && subject === null) {
      const value = decode(raw);
      if (value !== null) subject = cut(oneLine(value), MAILTO_MAX_SUBJECT);
    } else if (name === "body" && body === null) {
      const value = decode(raw);
      if (value !== null) body = plainBodyMarkdown(cut(value, MAILTO_MAX_BODY));
    }
  }
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const entry of later) if (entry.field === field) add(field, entry.raw);
  }
  return {
    to: lists.to,
    cc: lists.cc,
    bcc: lists.bcc,
    subject: subject ?? "",
    body: body ?? "",
  };
}
