import type { Participant } from "./entities.ts";

const SPACE = /\s/;

/**
 * Looks like `name@host.tld`; the server has the last word. No white space and none of
 * `forbidden`, exactly one `@` with something before it, and a dot in the domain that is neither
 * its first nor its last character. Read by hand, so the time it takes grows with the length only.
 */
export function hasAddressShape(text: string, forbidden = ""): boolean {
  let at = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (SPACE.test(ch) || forbidden.includes(ch)) return false;
    if (ch === "@") {
      if (at !== -1) return false;
      at = i;
    }
  }
  if (at <= 0) return false;
  const dot = text.indexOf(".", at + 2);
  return dot !== -1 && dot < text.length - 1;
}

/** What may not stand in an address in a recipient field: it separates or quotes one there. */
const FIELD_SPECIALS = '<>,;"';
const isFieldAddress = (text: string) => hasAddressShape(text, FIELD_SPECIALS);

export interface ParsedRecipients {
  readonly participants: readonly Participant[];
  /** Pieces that are not an address, as typed. */
  readonly invalid: readonly string[];
}

/**
 * Splits at commas and semicolons that are not inside quotes or angle brackets. Inside quotes a
 * backslash takes the next character as it is, so `\"` does not end the quote.
 */
function pieces(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) escaped = false;
    else if (quoted && ch === "\\") escaped = true;
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angled = true;
    else if (!quoted && ch === ">") angled = false;
    if (!quoted && !angled && (ch === "," || ch === ";" || ch === "\n")) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((p) => p.trim()).filter((p) => p !== "");
}

/** A quoted name without its quotes, and with each `\x` read as `x`; any other name as it is. */
function unquote(name: string): string {
  const quoted = /^"(.*)"$/.exec(name);
  return quoted ? (quoted[1] ?? "").replace(/\\([\s\S])/g, "$1") : name;
}

/** `Anna <anna@x.pl>, "Kowalski, Jan" <jan@x.pl>, b@x.pl` -> participants. */
export function parseRecipients(text: string): ParsedRecipients {
  const participants: Participant[] = [];
  const invalid: string[] = [];
  for (const piece of pieces(text)) {
    const angle = /^(.*)<([^<>]*)>\s*$/.exec(piece);
    const address = (angle ? (angle[2] ?? "") : piece).trim();
    if (!isFieldAddress(address)) {
      invalid.push(piece);
      continue;
    }
    const name = unquote((angle ? (angle[1] ?? "") : "").trim());
    participants.push(name === "" ? { address } : { name, address });
  }
  return { participants, invalid };
}

export function isValidAddress(address: string): boolean {
  return isFieldAddress(address.trim());
}

/**
 * The inverse of `parseRecipients`: a name with specials is quoted, with a backslash in front of
 * each `"` and `\` in it.
 */
export function formatRecipients(list: readonly Participant[]): string {
  return list
    .map((p) => {
      if (!p.name) return p.address;
      const name = /[",;<>@]/.test(p.name) ? `"${p.name.replace(/["\\]/g, "\\$&")}"` : p.name;
      return `${name} <${p.address}>`;
    })
    .join(", ");
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
