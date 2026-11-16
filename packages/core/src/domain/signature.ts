/**
 * The person's own signature (ADR 0142). One per account, empty by default, Markdown like the
 * rest of a message. It is text in the draft from the moment a message is started, never something
 * added at send time: what is sent is what the person saw and approved (ADR 0020).
 *
 * In the text it stands under the usual delimiter line, `-- ` (dash, dash, space; RFC 3676, 4.3),
 * so other mail programs and the reader fold it. Above a reply's quote or a forward's part, below
 * the person's own lines. Pure.
 */

/** The longest signature kept, in characters (UTF-16 code units, as the field counts them). */
export const SIGNATURE_MAX_CHARS = 2000;

/** The line above a signature: dash, dash, space. The space is part of it. */
export const SIGNATURE_DELIMITER = "-- ";

/** A signature that cannot be kept, with words the Settings field shows. */
export class InvalidSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

const QUOTED = /^\s*>/;

/** Without control characters other than the line feed and the tab: nothing typed on purpose. */
function withoutControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t" || (code >= 0x20 && code !== 0x7f)) out += ch;
  }
  return out;
}

/**
 * The signature as kept: line ends as `\n`, no control characters, no white space at the end of a
 * line, no empty lines around it, and without a delimiter line the person typed at its top (the
 * app writes that line itself, so it is never there twice).
 */
export function normalizeSignature(text: string): string {
  const lines = withoutControls(text.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  let start = 0;
  let end = lines.length;
  const blank = (i: number) => (lines[i] as string).trim() === "";
  while (start < end && blank(start)) start++;
  if (start < end && lines[start] === "--") {
    start++;
    while (start < end && blank(start)) start++;
  }
  while (end > start && blank(end - 1)) end--;
  return lines.slice(start, end).join("\n");
}

/** Why a normalized signature cannot be kept; null when it can. */
export function signatureProblem(signature: string): string | null {
  if (signature.length > SIGNATURE_MAX_CHARS) {
    return `A signature can be up to ${SIGNATURE_MAX_CHARS.toLocaleString("en-GB")} characters; this one has ${signature.length.toLocaleString("en-GB")}.`;
  }
  // A line that starts with `>` reads as quoted mail: the reply's fold and the agent's split
  // would take it, and everything under it, for the message answered.
  if (signature.split("\n").some((line) => QUOTED.test(line))) {
    return "A line of a signature can't start with >: it would read as quoted mail.";
  }
  return null;
}

/** The signature with its delimiter line, as it stands in a draft; empty for no signature. */
export function signatureBlock(signature: string): string {
  return signature === "" ? "" : `${SIGNATURE_DELIMITER}\n${signature}`;
}

/** A draft's text in its three parts. Joined again with `joinSections`, it reads the same. */
export interface DraftSections {
  /** The person's own lines, above the signature (or above the quote when there is none). */
  readonly own: string;
  /** From the delimiter line to the last line before the quote that is not empty; or empty. */
  readonly signature: string;
  /** The quote of a reply with the line that introduces it, or a forward's part; or empty. */
  readonly quote: string;
}

/**
 * Splits a draft's text. The quote starts at the first `>` line, with the line just above it when
 * that ends in a colon ("On 3 Nov 2026, 10:29, Anna wrote:"). The signature is the first delimiter
 * line above the quote and what follows it up to the quote. Everything else is the person's own.
 */
export function draftSections(text: string): DraftSections {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => QUOTED.test(l));
  let quoteAt = lines.length;
  if (first >= 0) {
    const above = lines[first - 1];
    quoteAt = above !== undefined && above.trim() !== "" && /:\s*$/.test(above) ? first - 1 : first;
  }
  const head = lines.slice(0, quoteAt);
  const at = head.indexOf(SIGNATURE_DELIMITER);
  let end = head.length;
  if (at >= 0) while (end > at + 1 && (head[end - 1] as string).trim() === "") end--;
  return {
    own: (at < 0 ? head : head.slice(0, at)).join("\n"),
    signature: at < 0 ? "" : head.slice(at, end).join("\n"),
    quote: lines.slice(quoteAt).join("\n"),
  };
}

/**
 * The parts again, one empty line between each. With no own lines the text starts with an empty
 * line to write on and one to keep it apart, as a reply always has (ADR 0020, rule 13).
 */
export function joinSections(own: string, signature: string, quote: string): string {
  let out = own.trimEnd();
  for (const part of [signature, quote]) {
    if (part === "") continue;
    out = out === "" ? `\n\n${part}` : `${out}\n\n${part}`;
  }
  return out;
}

/**
 * The first text of a message with the account's signature in place (ADR 0142, rule 3): under the
 * person's lines, above a quote or a forwarded part. A text that already has a signature is left as
 * it is, so nothing is ever signed twice.
 */
export function placeSignature(body: string, signature: string): string {
  if (signature === "") return body;
  const parts = draftSections(body);
  if (parts.signature !== "") return body;
  return joinSections(parts.own, signatureBlock(signature), parts.quote);
}

/**
 * When the sender changes (ADR 0142, rule 5): the text with the new account's signature in place
 * of the one that was put in, while what stands there is still exactly that one. Null when the
 * text stays as it is: the person changed or deleted the signature, so it is theirs, or the two
 * signatures are the same.
 */
export function followSignature(body: string, inserted: string, next: string): string | null {
  if (inserted === next) return null;
  const parts = draftSections(body);
  if (parts.signature !== signatureBlock(inserted)) return null;
  return joinSections(parts.own, signatureBlock(next), parts.quote);
}

/**
 * Text a model wrote, without a signature block of its own: from a delimiter line on, everything
 * goes. The model is asked to write none (ADR 0142, rule 6); this makes sure.
 */
export function withoutSignature(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^--\s?$/.test(l));
  return at < 0 ? text : lines.slice(0, at).join("\n").trimEnd();
}
