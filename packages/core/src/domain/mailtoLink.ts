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

/** A letter or a digit: an `_` between two of them can neither open nor close emphasis. */
const WORD = /[\p{L}\p{N}]/u;

/**
 * One line's characters that would be read as inline markup, each with a backslash in front; one
 * pass, so a backslash put in is never read again. A backslash that would escape something (one
 * before ASCII punctuation, or at the end of a line, where it is a hard break) is doubled. The
 * line holds no control character but the tab, so an autolink is what stands between `<` and `>`
 * without a space or a tab.
 */
function escapeInline(line: string): string {
  return line.replace(
    /\\(?=[!-/:-@[-`{-~]|$)|[[\]`*]|_+|~{2,}|<(?=[^<> \t]*>)(?=[^<> \t]*[:@])|&(?=[A-Za-z][A-Za-z0-9]{1,31};|#[xX][0-9A-Fa-f]{1,6};|#[0-9]{1,7};)/g,
    (match, offset: number) => {
      if (match[0] === "_") {
        const before = line[offset - 1] ?? "";
        const after = line[offset + match.length] ?? "";
        if (WORD.test(before) && WORD.test(after)) return match;
      }
      return match.replace(/./g, "\\$&");
    },
  );
}

/**
 * Where a line, read from its first character after at most three spaces, would start a block
 * that is not a paragraph: the index of the character to escape, or -1. A heading (`#` to
 * `######` before a space or the end), a list item (`-`, `+`, `1.`, `1)`), a setext underline
 * (`===`, `---`), a thematic break and a table's delimiter row (`-`, `|` and `:` only, with a
 * `-`), which also covers the signature delimiter `-- ` (ADR 0142). A `*` and an `_` are escaped
 * wherever they stand; a fence's backticks and tildes are too.
 */
function blockStart(rest: string): number {
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return 0;
  if (/^[-+](?:[ \t]|$)/.test(rest)) return 0;
  if (/^=+[ \t]*$/.test(rest)) return 0;
  if (/^[-|:][-|: \t]*$/.test(rest) && rest.includes("-")) return 0;
  const ordered = /^\d{1,9}[.)](?:[ \t]|$)/.exec(rest);
  if (ordered) return ordered[0].search(/[.)]/);
  return -1;
}

/**
 * The text of a link's body as Markdown that the app's renderer turns into that same text, in
 * paragraphs and line breaks, with no other element than a link a bare address makes to itself
 * (ADR 0143, rule 3). A link's body is plain text, so it cannot write what the person did not.
 * Escaped, with a backslash, wherever it would be read as markup:
 * - `[` and `]` (a link with other text, a reference, an image);
 * - `` ` `` (a code span or a fence, in which the other escapes would show), `*`, and `_` unless it
 *   stands between two letters or digits (emphasis, a list, a thematic break), a run of two or more
 *   `~` (struck text, a fence);
 * - `<` before what an autolink would take (`<https://…>`, `<a@b.example>`), `&` before what an
 *   entity reference would take (`&amp;`, `&#38;`);
 * - a backslash before ASCII punctuation or at the end of a line, which would cancel an escape or
 *   make a hard break;
 * - at the start of a line: `>` (quoted mail for the reply's fold and the agent's split), a
 *   heading, a list item, a setext underline, a thematic break, a table's delimiter row and the
 *   signature delimiter (see `blockStart`).
 * A line indented by a tab or by four spaces or more would be a code block, in which escapes
 * show; its indent becomes three spaces (the HTML part drops a line's indent either way). Raw HTML
 * needs nothing: the renderer shows it as text (ADR 0020, rule 11). A bare web address still
 * becomes a link, its address the text that is seen, up to the first character escaped in it.
 * Line ends become `\n`, and control characters other than the line feed and the tab go.
 */
export function plainBodyMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\p{Cc}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .split("\n")
    .map((raw) => {
      const indent = /^[ \t]*/.exec(raw)?.[0] ?? "";
      const lead = indent.includes("\t") || indent.length >= 4 ? "   " : indent;
      const rest = raw.slice(indent.length);
      // `>` after any white space at all: that is what the fold and the split read as a quote.
      const quote = /^\s*>/.exec(rest);
      const at = quote ? quote[0].length - 1 : blockStart(rest);
      const out = escapeInline(rest);
      // The character at `at` is never escaped inline, and nothing before it is changed.
      return at < 0 ? lead + out : `${lead}${out.slice(0, at)}\\${out.slice(at)}`;
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
