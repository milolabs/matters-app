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

/** The numbers of the lines that start a signature block, in order. */
function delimiterLines(lines: readonly string[]): number[] {
  const at: number[] = [];
  lines.forEach((l, i) => {
    if (l === SIGNATURE_DELIMITER || (l === "--" && (lines[i - 1] ?? "").trim() === "")) at.push(i);
  });
  return at;
}

/** A text cut at its delimiter lines: what stands above the first, and each block, as lines. */
interface Blocks {
  readonly body: readonly string[];
  /** Each from its delimiter line to the line before the next one, without empty lines at its end. */
  readonly blocks: readonly (readonly string[])[];
}

function blocksOf(text: string): Blocks {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = delimiterLines(lines);
  const blocks = at.map((start, i) => {
    const block = lines.slice(start, at[i + 1] ?? lines.length);
    let end = block.length;
    while (end > 1 && (block[end - 1] as string).trim() === "") end--;
    return block.slice(0, end);
  });
  return { body: lines.slice(0, at[0] ?? lines.length), blocks };
}

/** What two blocks are compared by: their lines without white space at the end. */
function blockKey(block: readonly string[]): string {
  return block.map((l) => l.replace(/\s+$/, "")).join("\n");
}

/**
 * The blocks of a text (ADR 0142, rule 6), each as it is compared: its delimiter line and the
 * lines under it up to the next delimiter or the end, without white space at the end of a line or
 * empty lines at the end of the block.
 */
export function signatureBlocks(text: string): string[] {
  return blocksOf(text).blocks.map(blockKey);
}

/**
 * A model's answer with only the person's own signature blocks (ADR 0142, rule 6). The model is
 * asked to write none; this makes sure, and keeps the person's.
 *
 * `before` is the person's own text the model was given; empty when the text is all the model's
 * (a new message it offered, a reply it prepared). `answer` is what the model wrote.
 *
 * - A block is a delimiter line and the lines after it up to the next delimiter line or the end. A
 *   delimiter line is `-- ` with its space anywhere, or `--` on the first line or after an empty
 *   line. A `--` right under a line of text underlines a Markdown heading: it is text, never a
 *   delimiter, and starts no block. What stands above the first delimiter is the answer's body.
 * - A block of the answer is the person's when its lines are the same as those of one of the
 *   blocks of `before`, line ends and white space at the end of a line aside. A block the model
 *   reworded is not the person's. Each block of the person's is matched at most once, in whatever
 *   order the answer has them: the first one not matched yet that is written exactly the same,
 *   else the first one not matched yet that is the same but for white space at a line's end.
 * - Every other block of the answer is the model's. The person's blocks the answer did not match
 *   are restored in place of the model's blocks: the first not matched, in the person's order, in
 *   place of the first block of the model's, in the answer's order, and so on, so a sign-off the
 *   model reworded or moved comes back as the person wrote it, where the model put it. The model's
 *   blocks left over are cut.
 * - A block of the person's that the answer has no block of the model's to stand in for is lost
 *   content: the answer is refused (null), as one that loses a gap is. Text that is all the
 *   model's is never refused.
 *
 * The kept text is the body without white space at its end and then each kept block, the person's
 * as they wrote it, one empty line between each. An answer with no block, and none in `before`, is
 * kept as it is. The checks of an answer (`keepsGaps` and the others) run on the kept text.
 */
export function keepOwnBlocks(before: string, answer: string): string | null {
  const mine = before === "" ? [] : blocksOf(before).blocks;
  const got = blocksOf(answer);
  if (got.blocks.length === 0 && mine.length === 0) return answer;
  const raws = mine.map((block) => block.join("\n"));
  const keys = mine.map(blockKey);
  const used = mine.map(() => false);
  // For each block of the answer: the number of the person's block it is, or -1 for the model's.
  // One written exactly as it is goes first, so blocks that differ only in white space at a line's
  // end each keep their own.
  const whose = got.blocks.map((block) => {
    const raw = block.join("\n");
    const key = blockKey(block);
    let j = raws.findIndex((r, i) => !used[i] && r === raw);
    if (j < 0) j = keys.findIndex((k, i) => !used[i] && k === key);
    if (j >= 0) used[j] = true;
    return j;
  });
  const missing = keys.flatMap((_, i) => (used[i] ? [] : [i]));
  if (missing.length > whose.filter((j) => j < 0).length) return null;
  let next = 0;
  const kept = whose.flatMap((j) => {
    if (j >= 0) return [j];
    const restored = missing[next++];
    return restored === undefined ? [] : [restored];
  });
  return [got.body.join("\n").trimEnd(), ...kept.map((j) => raws[j] as string)]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Text that is all a model's, without a signature block: from its first delimiter line on,
 * everything goes (`keepOwnBlocks` with no text of the person's).
 */
export function withoutSignature(text: string): string {
  return keepOwnBlocks("", text) as string;
}
