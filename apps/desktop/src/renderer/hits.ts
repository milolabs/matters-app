import { foldText, tokenize } from "@matters/core";

/**
 * ADR 0076. Which parts of a text the typed words matched, so that rows can show them. Pure: it
 * reads no layout and builds no markup. Comparing is done the way the search does it: folded
 * (`foldText`: no diacritics, no case, `ł` is `l`), and a word matches where a word of the text
 * starts with it. It never builds a pattern from what was typed, so no input can break it.
 */
export interface HitSegment {
  readonly text: string;
  readonly hit: boolean;
}

/** Tokens (folded words) of what the person typed, longest first, each once. */
export function hitWords(typed: string | readonly string[]): string[] {
  const all = typeof typed === "string" ? tokenize(typed) : typed.flatMap((t) => tokenize(t));
  return [...new Set(all)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** A folded copy of `text` and, for each folded UTF-16 unit, where its original character spans. */
function folded(text: string): { folded: string; from: number[]; to: number[] } {
  let out = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const next = at + ch.length;
    const f = foldText(ch);
    if (f === "") {
      // A mark standing alone (decomposed text) belongs to the letter before it.
      const last = to.length - 1;
      if (last >= 0) {
        for (let i = last; i >= 0 && to[i] === at; i--) to[i] = next;
      }
    } else {
      for (let i = 0; i < f.length; i++) {
        out += f.charAt(i);
        from.push(at);
        to.push(next);
      }
    }
    at = next;
  }
  return { folded: out, from, to };
}

/**
 * `text` cut into segments, `hit` where a typed word matched. Longer words are placed first, so
 * `faktura` wins over `fak`; a place taken is not taken again. With `anywhere`, a word of three
 * characters or more also matches inside a word (file names, ADR 0074).
 */
export function highlight(
  text: string,
  typed: string | readonly string[],
  options: { readonly anywhere?: boolean } = {},
): HitSegment[] {
  if (text === "") return [];
  const words = hitWords(typed);
  if (words.length === 0) return [{ text, hit: false }];
  const f = folded(text);
  const taken: { s: number; e: number }[] = [];
  const free = (s: number, e: number) => taken.every((t) => e <= t.s || s >= t.e);
  for (const word of words) {
    const inside = options.anywhere === true && word.length >= 3;
    for (let at = f.folded.indexOf(word); at !== -1; at = f.folded.indexOf(word, at + 1)) {
      const end = at + word.length;
      const starts = !isWordChar(f.folded[at - 1]);
      if ((inside || starts) && free(at, end)) taken.push({ s: at, e: end });
    }
  }
  if (taken.length === 0) return [{ text, hit: false }];
  taken.sort((a, b) => a.s - b.s);
  // Back to the original text; places that touch become one.
  const spans: { s: number; e: number }[] = [];
  for (const t of taken) {
    const s = f.from[t.s] ?? 0;
    const e = f.to[t.e - 1] ?? text.length;
    const last = spans[spans.length - 1];
    if (last && s <= last.e) last.e = Math.max(last.e, e);
    else spans.push({ s, e });
  }
  const out: HitSegment[] = [];
  let pos = 0;
  for (const span of spans) {
    if (span.s > pos) out.push({ text: text.slice(pos, span.s), hit: false });
    out.push({ text: text.slice(span.s, span.e), hit: true });
    pos = span.e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** How many places of `text` the words mark. */
export function countHits(
  text: string,
  typed: string | readonly string[],
  options: { readonly anywhere?: boolean } = {},
): number {
  let n = 0;
  for (const seg of highlight(text, typed, options)) if (seg.hit) n++;
  return n;
}
