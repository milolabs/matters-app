import type { Participant } from "./entities.ts";

/** Looks like `name@host.tld`; the server has the last word. */
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export interface ParsedRecipients {
  readonly participants: readonly Participant[];
  /** Pieces that are not an address, as typed. */
  readonly invalid: readonly string[];
}

/** Splits at commas and semicolons that are not inside quotes or angle brackets. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
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

/** `Anna <anna@x.pl>, "Kowalski, Jan" <jan@x.pl>, b@x.pl` -> participants. */
export function parseRecipients(text: string): ParsedRecipients {
  const participants: Participant[] = [];
  const invalid: string[] = [];
  for (const piece of pieces(text)) {
    const angle = /^(.*)<([^<>]*)>\s*$/.exec(piece);
    const address = (angle ? (angle[2] ?? "") : piece).trim();
    if (!ADDRESS.test(address)) {
      invalid.push(piece);
      continue;
    }
    const name = (angle ? (angle[1] ?? "") : "").trim().replace(/^"(.*)"$/, "$1");
    participants.push(name === "" ? { address } : { name, address });
  }
  return { participants, invalid };
}

export function isValidAddress(address: string): boolean {
  return ADDRESS.test(address.trim());
}

/** The inverse of `parseRecipients`: a name with specials is quoted. */
export function formatRecipients(list: readonly Participant[]): string {
  return list
    .map((p) => {
      if (!p.name) return p.address;
      const name = /[",;<>@]/.test(p.name) ? `"${p.name.replace(/"/g, '\\"')}"` : p.name;
      return `${name} <${p.address}>`;
    })
    .join(", ");
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
