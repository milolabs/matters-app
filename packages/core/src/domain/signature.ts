/**
 * The person's own signature (ADR 0142). One per account, empty by default, Markdown like the
 * rest of a message. It is text in the draft from the moment a message is started, never something
 * added at send time: what is sent is what the person saw and approved (ADR 0020).
 *
 * In the text it stands under the usual delimiter line, `-- ` (dash, dash, space; RFC 3676, 4.3),
 * so other mail programs and the reader fold it. Above a reply's quote or a forward's part, below
 * the person's own lines. Pure.
 */

import { FORWARD_MARK, isAttribution } from "./appQuote.ts";

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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Which lines are inside a fenced code block, its fence lines included: from a line that opens one
 * (three or more backticks or tildes, indented at most three spaces) to the first line below that
 * closes it (the same character, at least as many, nothing after but white space). A fence that
 * is never closed is text: the app's quote below it is still found.
 */
function codeLines(lines: readonly string[]): boolean[] {
  const code = lines.map(() => false);
  // The shortest fence of each character that found no close below it: none further down will.
  const unclosed = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i] as string)?.[1];
    if (open === undefined) continue;
    const ch = open[0] as string;
    if (open.length >= (unclosed.get(ch) ?? Number.POSITIVE_INFINITY)) continue;
    const close = new RegExp(`^ {0,3}\\${ch}{${open.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j] as string)) j++;
    if (j === lines.length) {
      unclosed.set(ch, open.length);
      continue;
    }
    for (let k = i; k <= j; k++) code[k] = true;
    i = j;
  }
  return code;
}

/** Where a draft's signature and quote start, as line numbers; `quoteAt` is the end when none. */
interface SectionLines {
  readonly lines: readonly string[];
  /** The delimiter line of the signature, or -1. */
  readonly signatureAt: number;
  /** The last line of the signature that is not empty, plus one. */
  readonly signatureEnd: number;
  readonly quoteAt: number;
}

function sectionLines(text: string): SectionLines {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const code = codeLines(lines);
  const quoted = (i: number) => !code[i] && QUOTED.test(lines[i] as string);
  // A quote starts at its first `>` line, with the line just above it when that ends in a colon.
  const introduced = (i: number, floor: number) => {
    const above = lines[i - 1];
    return i - 1 > floor && !code[i - 1] && above !== undefined && /\S.*:\s*$/.test(above)
      ? i - 1
      : i;
  };
  const delimiter = lines.findIndex((l, i) => !code[i] && l === SIGNATURE_DELIMITER);
  let quoteAt = lines.length;
  if (delimiter >= 0) {
    // The app writes its quote under the signature: only a `>` line below the delimiter starts it.
    const below = lines.findIndex((_, i) => i > delimiter && quoted(i));
    if (below >= 0) quoteAt = introduced(below, delimiter);
  } else {
    // No signature: the quote starts at the last line the app opens one with, the attribution
    // of a reply above a `>` line, or the mark of a forward as the first `>` line of its run.
    // Else at the line ending in a colon above the run of `>` and empty lines that ends the
    // draft. A run with no such line above it is the person's.
    let opening = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!quoted(i) || (i > 0 && quoted(i - 1))) continue;
      if (lines[i] === FORWARD_MARK) opening = i;
      else if (i > 0 && !code[i - 1] && isAttribution(lines[i - 1] as string)) opening = i - 1;
    }
    if (opening >= 0) {
      quoteAt = opening;
    } else {
      let k = lines.length;
      while (k > 0 && ((lines[k - 1] as string).trim() === "" || quoted(k - 1))) k--;
      while (k < lines.length && !quoted(k)) k++;
      if (k < lines.length && introduced(k, -1) < k) quoteAt = k - 1;
    }
  }
  const signatureAt = delimiter;
  let signatureEnd = quoteAt;
  if (signatureAt >= 0) {
    while (signatureEnd > signatureAt + 1 && (lines[signatureEnd - 1] as string).trim() === "") {
      signatureEnd--;
    }
  }
  return { lines, signatureAt, signatureEnd, quoteAt };
}

/**
 * Splits a draft's text (ADR 0142, rule 4). The quote is the app's own: what it wrote under the
 * signature, at the end of the draft, a reply's "On 3 Nov 2026, 10:29, Anna wrote:" and its `>`
 * lines, or a forward's part from `> Forwarded message` on. A `>` line the person wrote above the
 * signature, or anywhere inside a fenced code block, is their own text.
 *
 * - Lines inside a fenced code block are never a quote and never a delimiter (`codeLines`).
 * - The delimiter is the first `-- ` line. With one, the quote starts at the first `>` line below
 *   it, with the line just above that when it is below the delimiter, not empty, and ends in a
 *   colon; with no `>` line below it there is no quote. Nothing above the delimiter is quote.
 * - With no delimiter, the quote starts at the last opening the app writes: a line "On … wrote:" right above a `>` line that does not follow another `>`
 *   line, or a `> Forwarded message` line that does not. Without one, at the line that ends in a
 *   colon right above the run of `>` lines and empty lines that ends the draft (a reply whose
 *   attribution the person reworded). Without that either, there is no quote: a `>` line with
 *   nothing of the app's around it is the person's.
 * - The signature is the delimiter and what follows it up to the last line before the quote that
 *   is not empty. A `-- ` inside the quote (`> -- `) is the other side's.
 * - Everything above the signature, or above the quote when there is no signature, is the
 *   person's own. Below the start of the quote everything is the quote, words the person wrote
 *   between its lines included.
 */
export function draftSections(text: string): DraftSections {
  const { lines, signatureAt, signatureEnd, quoteAt } = sectionLines(text);
  return {
    own: lines.slice(0, signatureAt < 0 ? quoteAt : signatureAt).join("\n"),
    signature: signatureAt < 0 ? "" : lines.slice(signatureAt, signatureEnd).join("\n"),
    quote: lines.slice(quoteAt).join("\n"),
  };
}

/**
 * Where the signature and the quote of a draft start, as offsets into the text (which has `\n`
 * line ends, as the editor's has); null for one there is not. The same parts as `draftSections`.
 */
export function sectionStarts(text: string): {
  readonly signature: number | null;
  readonly quote: number | null;
} {
  const { lines, signatureAt, quoteAt } = sectionLines(text);
  const offset = (n: number) => {
    let at = 0;
    for (let i = 0; i < n; i++) at += (lines[i] as string).length + 1;
    return at;
  };
  return {
    signature: signatureAt < 0 ? null : offset(signatureAt),
    quote: quoteAt === lines.length ? null : offset(quoteAt),
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
 * - The person's blocks still not matched after that (the model was told to write no sign-off, so
 *   it often drops the person's too) are put back after the last kept block, or after the body
 *   when none is kept, in the person's order. The answer is never refused for a block: the
 *   person's own blocks are always there, each once.
 *
 * The kept text is the body without white space at its end and then each kept block, the person's
 * as they wrote it, one empty line between each. An answer with no block, and none in `before`, is
 * kept as it is. The checks of an answer (`keepsGaps` and the others) run on the kept text: a gap
 * in a block of the person's that is put back is theirs and kept; a gap the model moved into a
 * block of its own is cut with that block, and lost.
 */
export function keepOwnBlocks(before: string, answer: string): string {
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
  let next = 0;
  const kept = whose.flatMap((j) => {
    if (j >= 0) return [j];
    const restored = missing[next++];
    return restored === undefined ? [] : [restored];
  });
  // What the model's blocks did not stand in for comes after them, in the person's order.
  kept.push(...missing.slice(next));
  return [got.body.join("\n").trimEnd(), ...kept.map((j) => raws[j] as string)]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Text that is all a model's, without a signature block: from its first delimiter line on,
 * everything goes (`keepOwnBlocks` with no text of the person's).
 */
export function withoutSignature(text: string): string {
  return keepOwnBlocks("", text);
}
