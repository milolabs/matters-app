export interface BodySegment {
  readonly quoted: boolean;
  /** Plain segments keep their lines as written; quoted ones lose one `>` level. */
  readonly text: string;
  readonly lines: number;
}

const QUOTE_PREFIX = /^\s*> ?/;

/**
 * Splits a plain-text body into runs of ordinary and `>`-quoted lines. Pure, so it is cheap
 * to test and to run on every opened message.
 */
export function splitBody(text: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let run: string[] = [];
  let quoted = false;

  const flush = () => {
    if (run.length > 0) {
      // Blank lines around a run are separators, not content.
      const lines = quoted ? run : trimBlankEdges(run);
      if (lines.length > 0) segments.push({ quoted, text: lines.join("\n"), lines: lines.length });
    }
    run = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const isQuote = line.trimStart().startsWith(">");
    if (isQuote !== quoted) {
      flush();
      quoted = isQuote;
    }
    run.push(isQuote ? line.replace(QUOTE_PREFIX, "") : line);
  }
  flush();
  return segments;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start++;
  while (end > start && lines[end - 1]?.trim() === "") end--;
  return lines.slice(start, end);
}

export interface TextPart {
  readonly text: string;
  /** Set when this part is a link. */
  readonly href?: string;
}

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// Punctuation after a link belongs to the sentence, unless the link opened that bracket.
const TRAILING = /[.,;:!?'"»”’]+$/;

function trimUrl(url: string): string {
  let out = url.replace(TRAILING, "");
  while (out.endsWith(")") && !out.includes("(")) out = out.slice(0, -1).replace(TRAILING, "");
  return out;
}

/** Text split around the addresses in it. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: url, href: url.toLowerCase().startsWith("www.") ? `https://${url}` : url });
    at = match.index + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** A plain segment cut at its signature delimiter (`-- `); the last one counts. */
export function splitSignature(text: string): { body: string; signature?: string; lines: number } {
  const lines = text.split("\n");
  const at = lines.findLastIndex((l) => l === "-- " || l === "--");
  if (at < 0 || at === lines.length - 1) return { body: text, lines: 0 };
  const signature = lines.slice(at + 1);
  return {
    body: trimBlankEdges(lines.slice(0, at)).join("\n"),
    signature: signature.join("\n"),
    lines: signature.length,
  };
}

/** A signature of this many lines or fewer sits under the words; a longer one folds away. */
export const SHORT_SIGNATURE_LINES = 4;

/**
 * The pieces of a plain body that are on screen before anything is unfolded: the words of each
 * unquoted run and its short signature. Quoted replies and long signatures are not in it. The
 * reader renders exactly these, so counting words in them counts what the person can see.
 */
export function readablePieces(text: string): string[] {
  const pieces: string[] = [];
  for (const segment of splitBody(text)) {
    if (segment.quoted) continue;
    const split = splitSignature(segment.text);
    pieces.push(split.body);
    if (split.signature !== undefined && split.lines <= SHORT_SIGNATURE_LINES) {
      pieces.push(split.signature);
    }
  }
  return pieces;
}
