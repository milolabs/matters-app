/**
 * Quoted text out of a thread (ADR 0084). A reply carries the whole history of the conversation
 * below its own words, so a long thread is mostly the same lines again and again. For the model
 * each line is worth reading once: this takes the lines out that only repeat earlier messages of
 * the same thread. It knows no language and no "On ... wrote:" pattern: words are folded as the
 * index folds them, and a line goes when most of its words sit in runs of words that an earlier
 * message already had. Quote marks, re-wrapped lines and HTML quotes without marks all fall out
 * the same way. Pure.
 */
import { tokenize } from "./text.ts";

/** How many words in a row make one shingle. */
const SHINGLE_WORDS = 8;
/** A line with fewer words than this is never dropped: "Thanks", "OK, will do". */
const MIN_LINE_WORDS = 3;
/** The share of a line's words that must be covered by earlier shingles for it to go. */
const COVERED_SHARE = 0.8;
/** The line that stands where quoted text was left out. */
export const REPEATS_LEFT_OUT = "[earlier messages quoted here are left out]";

/** A line made of nothing but quote marks and white space, such as `>` or `> >`. */
const MARKS_ONLY = /^[>|\s]+$/;

function shingles(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let s = 0; s + SHINGLE_WORDS <= tokens.length; s++) {
    out.push(tokens.slice(s, s + SHINGLE_WORDS).join(" "));
  }
  return out;
}

/**
 * `messages` are the texts of one thread, oldest first. Returns each text with the lines left out
 * that only repeat earlier messages. The first message is never changed, and a line that has words
 * no earlier message had is never lost. Where the first dropped block was, one line says so.
 */
export function withoutRepeats(messages: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, text] of messages.entries()) {
    const lines = text.split("\n");
    const perLine = lines.map((l) => tokenize(l));
    const all = perLine.flat();
    const grams = shingles(all);
    out.push(index === 0 || seen.size === 0 ? text : drop(lines, perLine, all, seen));
    for (const g of grams) seen.add(g);
  }
  return out;
}

function drop(
  lines: readonly string[],
  perLine: readonly (readonly string[])[],
  all: readonly string[],
  seen: ReadonlySet<string>,
): string {
  // A word is covered when any run of words that holds it was in an earlier message.
  const covered = new Array<boolean>(all.length).fill(false);
  for (let s = 0; s + SHINGLE_WORDS <= all.length; s++) {
    if (!seen.has(all.slice(s, s + SHINGLE_WORDS).join(" "))) continue;
    for (let t = s; t < s + SHINGLE_WORDS; t++) covered[t] = true;
  }
  const gone = lines.map(() => false);
  let at = 0;
  for (const [i, words] of perLine.entries()) {
    let n = 0;
    for (let t = at; t < at + words.length; t++) if (covered[t]) n++;
    at += words.length;
    gone[i] = words.length >= MIN_LINE_WORDS && n >= COVERED_SHARE * words.length;
  }
  if (!gone.includes(true)) return lines.join("\n");
  const bare = (i: number) =>
    (lines[i] as string).trim() === "" || MARKS_ONLY.test(lines[i] as string);
  const words = (i: number) => (perLine[i] as readonly string[]).length > 0;
  // The nearest line with words on each side, to tell what a line without words sits next to.
  const near = (from: number, step: 1 | -1): boolean | undefined => {
    for (let i = from + step; i >= 0 && i < lines.length; i += step) if (words(i)) return gone[i];
    return undefined;
  };
  const kept: string[] = [];
  let marked = false;
  for (const [i, line] of lines.entries()) {
    let out = gone[i] === true;
    if (!out && !words(i) && bare(i)) {
      const before = near(i, -1);
      const after = near(i, 1);
      const blank = line.trim() === "";
      out = blank ? before === true && after === true : before === true || after === true;
    }
    if (!out) {
      kept.push(line);
      continue;
    }
    if (!marked) {
      kept.push(REPEATS_LEFT_OUT);
      marked = true;
    }
  }
  // Three blank lines or more in a row become one.
  const tidy: string[] = [];
  let blanks = 0;
  const flush = () => {
    if (blanks >= 3) tidy.push("");
    else for (let b = 0; b < blanks; b++) tidy.push("");
    blanks = 0;
  };
  for (const line of kept) {
    if (line.trim() === "") blanks++;
    else {
      flush();
      tidy.push(line);
    }
  }
  flush();
  return tidy.join("\n");
}
