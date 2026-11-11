/**
 * Fold text for search: NFD, strip combining marks, `ł→l`, lowercase.
 * SQLite's `remove_diacritics` leaves `ł` alone (no Unicode decomposition),
 * so folding happens here, before indexing and before querying (ADR 0006).
 */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}

/** Folded words (letters and digits only). Everything else separates words. */
export function tokenize(s: string): string[] {
  return foldText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}
