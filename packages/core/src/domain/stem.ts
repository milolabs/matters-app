/**
 * A light stemmer for the agent's search words (ADR 0081): Polish and English suffixes cut off,
 * so that a word written in one form finds the others (`umowa` finds `umowy`, `umowę`;
 * `contracts` finds `contract`; `agreement` finds `agreed`). The result is only used as a prefix,
 * never shown, and it need not be a word: it must be shared by the forms of a word, and it must
 * not be so short that it matches unrelated words. Pure.
 */
import { foldText } from "./text.ts";

/** The shortest stem kept: a shorter one would match too many unrelated words. */
export const MIN_STEM_CHARS = 4;
/** Words shorter than this are left alone: their suffix is most of the word. */
const MIN_STEMMED_WORD = 5;

/**
 * Endings in folded letters (no diacritics: `ę` and `ą` are `e` and `a`), Polish then English.
 * Matched longest first; one ending is cut, never several.
 */
const SUFFIXES: readonly string[] = [
  // Polish nouns, by case and number
  "owaniem",
  "owaniu",
  "owanie",
  "owania",
  "owaniom",
  "owaniami",
  "owaniach",
  "eniem",
  "eniom",
  "eniami",
  "eniach",
  "enie",
  "eniu",
  "enia",
  "aniem",
  "aniom",
  "aniami",
  "aniach",
  "anie",
  "aniu",
  "ania",
  "ciami",
  "ciach",
  "osci",
  "oscia",
  "oscią",
  // Polish adjectives
  "owych",
  "owego",
  "owemu",
  "owym",
  "owymi",
  "owej",
  "owa",
  "owe",
  "owy",
  "owo",
  "ego",
  "emu",
  "ymi",
  "imi",
  "ych",
  "ich",
  "ej",
  // Polish verbs
  "ujemy",
  "ujecie",
  "ujesz",
  "ujac",
  "uje",
  "uja",
  "alem",
  "elem",
  "ilem",
  "ylem",
  "alam",
  "elam",
  "ilam",
  "ylam",
  "ali",
  "eli",
  "ili",
  "yli",
  "ala",
  "ela",
  "ila",
  "yla",
  "al",
  "el",
  "il",
  "yl",
  "owac",
  "owal",
  "ac",
  "ic",
  "ec",
  // Polish plain endings
  "ami",
  "ach",
  "iem",
  "om",
  "ow",
  "em",
  "ym",
  "im",
  "ie",
  "ia",
  "iu",
  // English
  "ations",
  "ation",
  "ments",
  "ment",
  "ings",
  "ing",
  "ness",
  "ities",
  "ity",
  "ions",
  "ion",
  "ers",
  "er",
  "ies",
  "ed",
  "es",
  "ly",
  "al",
  "ive",
  "able",
  "ful",
  // One letter (Polish and English)
  "a",
  "e",
  "i",
  "o",
  "u",
  "y",
  "s",
];

/** Endings that make a noun from a verb in English: the stem left must be a word (`agree`, not `docu`). */
const LONG_STEM_ENDINGS: ReadonlySet<string> = new Set(
  ["ations", "ation", "ments", "ment", "ions", "ion", "ities", "ity"].map(foldText),
);

const BY_LENGTH = [...new Set(SUFFIXES.map(foldText))].sort((a, b) => b.length - a.length);

/** The stem of one word: folded, and cut by the longest ending that leaves 4 characters or more. */
export function stemWord(word: string): string {
  const w = foldText(word.trim());
  // Numbers, codes and short words stand for themselves.
  if (w.length < MIN_STEMMED_WORD || /\d/.test(w)) return w;
  for (const suffix of BY_LENGTH) {
    const least = LONG_STEM_ENDINGS.has(suffix) ? MIN_STEM_CHARS + 1 : MIN_STEM_CHARS;
    if (w.length - suffix.length >= least && w.endsWith(suffix)) {
      return w.slice(0, w.length - suffix.length);
    }
  }
  return w;
}
