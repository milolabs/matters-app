// The recipient field's text as chips (ADR 0101). The session keeps To/Cc/Bcc as one text, as the
// draft and the send read it; the field shows each finished address as a chip and edits the rest.
import { formatRecipients, parseRecipients } from "@matters/core";

export interface RecipientText {
  /** Finished pieces, as typed (`Anna <anna@x.pl>` or `b@x.pl`). */
  readonly chips: readonly string[];
  /** What is being typed after the last separator. */
  readonly typing: string;
}

/**
 * Splits at commas, semicolons and line breaks outside quotes and angle brackets, the way the
 * draft reads it. A piece counts as finished when a separator follows it.
 */
export function splitRecipients(text: string): RecipientText {
  const chips: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angled = true;
    else if (!quoted && ch === ">") angled = false;
    if (!quoted && !angled && (ch === "," || ch === ";" || ch === "\n")) {
      if (current.trim() !== "") chips.push(current.trim());
      current = "";
    } else current += ch;
  }
  return { chips, typing: current.replace(/^\s+/, "") };
}

/** The text again: the chips, each followed by a comma, then what is being typed. */
export function joinRecipients(chips: readonly string[], typing: string): string {
  return chips.map((c) => `${c}, `).join("") + typing;
}

/** What a chip shows: the name when there is one, else the address; and whether it is an address. */
export function chipLabel(piece: string): { label: string; address: string; valid: boolean } {
  const parsed = parseRecipients(piece);
  const p = parsed.participants[0];
  if (!p) return { label: piece, address: piece, valid: false };
  return { label: p.name?.trim() || p.address, address: p.address, valid: true };
}

/** A suggestion as a piece of the field's text. */
export function pieceOf(person: { name?: string | undefined; address: string }): string {
  return formatRecipients([
    person.name ? { name: person.name, address: person.address } : { address: person.address },
  ]);
}
