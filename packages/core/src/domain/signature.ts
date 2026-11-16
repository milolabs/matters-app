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
  if (!plainFences(signature)) {
    return "A code block in a signature opens and closes with the same line of ``` or ~~~, with nothing after it and no such line inside.";
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

/** A line that opens a fenced code block: three or more backticks or tildes, indented 0-3 spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  readonly ch: string;
  readonly length: number;
}

/** The fence a line opens, or null. A backtick fence's info string has no backtick (CommonMark). */
function opens(line: string): Fence | null {
  const m = FENCE.exec(line);
  if (m === null) return null;
  const run = m[1] as string;
  if (run[0] === "`" && (m[2] as string).includes("`")) return null;
  return { ch: run[0] as string, length: run.length };
}

/** Whether a line closes `fence`: its character, at least as many, then only white space. */
function closes(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && (m[1] as string)[0] === fence.ch && (m[1] as string).length >= fence.length;
}

/**
 * Whether every code block of a signature is fenced plainly: a line of backticks or tildes with
 * nothing after them, the same line again below, and no line that looks like a fence between.
 * Such a signature is never read as code (`codeLines`): under a fence the person left open above
 * it, closing theirs at its first fence line would leave its last one open, so theirs is left
 * open instead. One with a fence that has words after it, or one inside a block, could pair up
 * with theirs and be read as their code.
 */
function plainFences(signature: string): boolean {
  let open: string | null = null;
  for (const line of signature.split("\n")) {
    if (!FENCE.test(line)) continue;
    if (open === null) {
      if (!/^ {0,3}(`{3,}|~{3,})$/.test(line)) return false;
      open = line;
    } else if (line === open) open = null;
    else return false;
  }
  return open === null;
}

/**
 * The plain reading of `codeLines` (`placed` false): which lines are code, and the fence left open
 * at the end, or null.
 */
function readPlainly(lines: readonly string[]): {
  readonly code: boolean[];
  readonly open: Fence | null;
} {
  const n = lines.length;
  const code = lines.map(() => false);
  let open: Fence | null = null;
  for (let i = 0; i < n; i++) {
    const fence = opens(lines[i] as string);
    if (fence === null) continue;
    let j = i + 1;
    while (j < n && !closes(lines[j] as string, fence)) j++;
    for (let k = i; k <= Math.min(j, n - 1); k++) code[k] = true;
    if (j === n) open = fence;
    i = j;
  }
  return { code, open };
}

/**
 * Which lines are inside a fenced code block, its fence lines included (ADR 0142, rules 4 and 6).
 * Fences are read from the top, as Markdown reads them: a line that opens one, then the first line
 * below it that closes it. How the text is read depends on whether the app may have placed a
 * signature in it (`placed`).
 *
 * Text in which the app placed no signature (`placed` false: a model's answer, or the person's own
 * text above the signature, which has it split off) is read plainly, as markdown-it reads it: a
 * closed fence is code whatever follows it, and a fence with no line that closes it is code to the
 * end. So a `-- ` or `--` line in a code block, closed or left open, is code, and the model's code
 * is never cut at an SQL comment.
 *
 * A draft that may hold the app's signature (`placed` true) is read so that the signature placed
 * is never code. A fence with no line that closes it is text, and the lines under it are read on.
 * And one case is decided for the signature: a code block that would hold a `-- ` line.
 *
 * - It is closed, and the `-- ` line is code (an SQL comment), when the text under its closing
 *   line, read by this same rule, closes every fence it opens, or has a `-- ` line outside code
 *   (a signature of its own below). So a `-- ` line in a closed code block stays code, with or
 *   without a signature under the block, and with or without a code block in that signature.
 * - Else closing it would leave a fence open further down with no signature outside code: the
 *   signature's own code block, read from its closing line. Then, when the text under one of the
 *   `-- ` lines it would hold closes every fence it opens, its fence is left open, as text, and
 *   that `-- ` line is outside code: the delimiter. A signature the app placed is fenced plainly
 *   (`plainFences`, which `signatureProblem` asks for), so it closes every fence it opens, and
 *   closing a fence above it at its first fence line always leaves its last one open; a quote's
 *   lines all start with `>`. So a fence the person left open is never closed by a fence inside
 *   the signature.
 * - Else it is closed.
 *
 * Two shapes read two ways, and are read for the signature. A `-- ` line in a code block, with a
 * fence left open further down and no other `-- ` line: the block's closing line pairs with that
 * fence, so the block's fence is the one left open and the `-- ` line is the delimiter. A fence
 * left open with a `-- ` line under it, above the signature the app placed: the first `-- ` line
 * is the delimiter, and the signature read from it is not the one placed (it is the person's, as
 * when they change it). Markdown reads a fence left open as code to the end; the renderer renders
 * the parts apart, so that code ends where the person's part ends, and the signature and the
 * quote are never in it.
 */
function codeLines(lines: readonly string[], placed: boolean): boolean[] {
  if (!placed) return readPlainly(lines).code;
  const n = lines.length;
  const fences = lines.map(opens);
  // The `-- ` lines above line k, so whether one stands between two lines is known at once.
  const dashes = [0];
  for (let k = 0; k < n; k++)
    dashes.push((dashes[k] as number) + (lines[k] === SIGNATURE_DELIMITER ? 1 : 0));
  const dashBetween = (from: number, to: number) =>
    (dashes[to] as number) > (dashes[from] as number);
  // What each opening line decides, from the bottom up: everything it depends on is below it.
  // `close`: the line that closes it, or -1 when it is left open. `open`: the fences left open
  // reading from it to the end; `signed`: whether that reading has a `-- ` line outside code.
  const close: number[] = lines.map(() => -1);
  const open: number[] = lines.map(() => 0);
  const signed: boolean[] = lines.map(() => false);
  const next: number[] = new Array(n + 1).fill(n);
  for (let k = n - 1; k >= 0; k--) next[k] = fences[k] === null ? (next[k + 1] as number) : k;
  // The same two, reading from any line.
  const openFrom = (p: number) =>
    p >= n || next[p] === n ? 0 : (open[next[p] as number] as number);
  const signedFrom = (p: number) => {
    if (p >= n) return false;
    const i = next[p] as number;
    return dashBetween(p, i) || (i < n && (signed[i] as boolean));
  };
  for (let i = n - 1; i >= 0; i--) {
    const fence = fences[i];
    if (fence === null || fence === undefined) continue;
    let j = i + 1;
    while (j < n && !closes(lines[j] as string, fence)) j++;
    let closed = j < n;
    if (closed && dashBetween(i + 1, j) && openFrom(j + 1) > 0 && !signedFrom(j + 1)) {
      for (let d = i + 1; d < j; d++) {
        if (lines[d] === SIGNATURE_DELIMITER && openFrom(d + 1) === 0) {
          closed = false;
          break;
        }
      }
    }
    close[i] = closed ? j : -1;
    open[i] = closed ? openFrom(j + 1) : 1 + openFrom(i + 1);
    signed[i] = closed ? signedFrom(j + 1) : signedFrom(i + 1);
  }
  const code = lines.map(() => false);
  for (let p = next[0] as number; p < n; ) {
    const j = close[p] as number;
    if (j < 0) {
      p = next[p + 1] as number;
      continue;
    }
    for (let k = p; k <= j; k++) code[k] = true;
    p = next[j + 1] as number;
  }
  return code;
}

/**
 * What one line of a draft is (ADR 0142, rule 4). `code`: inside a fenced code block, its fence
 * lines included. Outside one: `quoted`, a line that starts with `>`; `delimiter`, a `-- ` line;
 * `dashes`, a `--` line on the first line or after an empty line (a delimiter that lost its
 * space, which only a model's text is cut at: `keepOwnBlocks`); else `text`.
 */
export type DraftLineKind = "text" | "code" | "quoted" | "delimiter" | "dashes";

/**
 * A draft's text read once: its lines, what each is, and where its signature and quote start, as
 * line numbers. Every reading of a draft in the app comes from this one: the split
 * (`draftSections`, `sectionStarts`), the blocks the agent's text is cut at (`keepOwnBlocks`),
 * the agent's quote check, the renderer and the editor.
 *
 * A draft is read as one that may hold the app's signature (`placed`, the default): the split, the
 * agent's quote check, the renderer and the editor. Text in which the app placed no signature is
 * read with `placed: false` (`codeLines`): the blocks of a model's answer and of the person's own
 * text before the turn (`keepOwnBlocks`, `withoutSignature`), both by the same rule, so the
 * person's blocks are found alike in both. Its `signatureAt` is then only the first delimiter line
 * outside every fence.
 */
export interface DraftReading {
  /** The lines, with `\n` line ends. */
  readonly lines: readonly string[];
  readonly kinds: readonly DraftLineKind[];
  /** The delimiter line of the signature, or -1. */
  readonly signatureAt: number;
  /** The last line of the signature that is not empty, plus one. */
  readonly signatureEnd: number;
  /** The first line of the quote; the number of lines when there is none. */
  readonly quoteAt: number;
}

export function readDraft(
  text: string,
  { placed = true }: { readonly placed?: boolean } = {},
): DraftReading {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const code = codeLines(lines, placed);
  const kinds: DraftLineKind[] = lines.map((l, i) => {
    if (code[i]) return "code";
    if (QUOTED.test(l)) return "quoted";
    if (l === SIGNATURE_DELIMITER) return "delimiter";
    if (l === "--" && (lines[i - 1] ?? "").trim() === "") return "dashes";
    return "text";
  });
  const quoted = (i: number) => kinds[i] === "quoted";
  // A quote starts at its first `>` line, with the line just above it when that ends in a colon.
  const introduced = (i: number, floor: number) => {
    const above = lines[i - 1];
    return i - 1 > floor && !code[i - 1] && above !== undefined && /\S.*:\s*$/.test(above)
      ? i - 1
      : i;
  };
  const delimiter = kinds.indexOf("delimiter");
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
  return { lines, kinds, signatureAt, signatureEnd, quoteAt };
}

/**
 * Splits a draft's text (ADR 0142, rule 4), as `readDraft` reads it. The quote is the app's own:
 * what it wrote under the signature, at the end of the draft, a reply's "On 3 Nov 2026, 10:29,
 * Anna wrote:" and its `>` lines, or a forward's part from `> Forwarded message` on. A `>` line the person wrote above the
 * signature, or anywhere inside a fenced code block, is their own text.
 *
 * - Lines inside a fenced code block are never a quote and never a delimiter. The signature the
 *   app placed is never code: a fence still open at a `-- ` line is closed below it only when the
 *   text below that line leaves a fence of its own open (`codeLines`).
 * - The delimiter is the first `-- ` line. With one, the quote starts at the first `>` line below
 *   it, with the line just above that when it is below the delimiter, not empty, and ends in a
 *   colon; with no `>` line below it there is no quote. Nothing above the delimiter is quote.
 * - With no delimiter, the quote starts at the last opening the app writes: a line "On … wrote:"
 *   right above a `>` line that does not follow another `>` line, or a `> Forwarded message` line
 *   that does not. Without one, at the line that ends in a
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
  const { lines, signatureAt, signatureEnd, quoteAt } = readDraft(text);
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
  const { lines, signatureAt, quoteAt } = readDraft(text);
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

/** A text cut at its delimiter lines: what stands above the first, and each block, as lines. */
interface Blocks {
  readonly body: readonly string[];
  /** Each from its delimiter line to the line before the next one, without empty lines at its end. */
  readonly blocks: readonly (readonly string[])[];
}

function blocksOf(text: string): Blocks {
  // A block starts at a delimiter line outside every code block, closed or left open: the text
  // holds no signature the app placed, so it is read plainly (`readDraft`, `placed: false`).
  const { lines, kinds } = readDraft(text, { placed: false });
  const at = kinds.flatMap((k, i) => (k === "delimiter" || k === "dashes" ? [i] : []));
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
 * (a new message it offered, a reply it prepared). `answer` is what the model wrote. Neither holds
 * a signature the app placed (the person's text has it split off, `splitDraft`), so both are read
 * plainly and by the same rule (`readDraft` with `placed: false`).
 *
 * - A block is a delimiter line and the lines after it up to the next delimiter line or the end. A
 *   delimiter line is `-- ` with its space anywhere, or `--` on the first line or after an empty
 *   line, outside every fenced code block as markdown-it reads them: a closed fence is code
 *   whatever follows it, and a fence never closed is code to the end. So a `-- ` in a code sample
 *   is code and the fence closing it stays, and a model that left a code block open keeps all of
 *   it. A `--` right under a line of text underlines a Markdown heading: it is text, never a
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
 * as they wrote it, one empty line between each. When the body leaves a code block open and a
 * block follows it, a line closing that block (its fence character, as many) ends the body, so
 * the person's blocks put back are not code. An answer with no block, and none in `before`, is
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
  let body = got.body.join("\n").trimEnd();
  // A code block the model left open runs to the end: the person's blocks put back under it
  // would be code. It is closed first, so they stand under it as theirs.
  const open = kept.length > 0 ? readPlainly(got.body).open : null;
  if (open !== null) body = `${body}\n${open.ch.repeat(open.length)}`;
  return [body, ...kept.map((j) => raws[j] as string)].filter((part) => part !== "").join("\n\n");
}

/**
 * Text that is all a model's, without a signature block: from its first delimiter line outside
 * every code block on, everything goes (`keepOwnBlocks` with no text of the person's). It is for
 * text the app has put no signature in yet; a draft with the signature placed is split
 * (`draftSections`) instead.
 */
export function withoutSignature(text: string): string {
  return keepOwnBlocks("", text);
}
