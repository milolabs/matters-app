import { initials } from "./initials.ts";

/**
 * One colour per person, everywhere (ADR 0078): the list, the reader's header, the rows of a
 * thread and the people in the search panel all ask here. The hues are the account palette
 * (`--acct-*`), so they already have a light and a dark value; the avatar draws the hue as a 24 %
 * wash with the hue, pulled 30 % toward the ink, as the letters (styles.css, `.avatar[data-tint]`).
 */
export const TINT_COUNT = 8;

/** FNV-1a over the lower-cased text: stable across launches and machines, no allocation. */
export function personTint(address: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) {
    const c = address.charCodeAt(i);
    h ^= c >= 65 && c <= 90 ? c + 32 : c;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % TINT_COUNT;
}

export interface PersonMark {
  readonly initials: string;
  readonly tint: number;
}

const MAX_CACHED = 4000;
const cache = new Map<string, PersonMark>();

/**
 * The letters and the hue of a person, worked out once per address and name. A list row asks on
 * every draw, so this is a Map hit and nothing else. The cache is emptied when it grows past a few
 * thousand people.
 */
export function personMark(address: string, name?: string): PersonMark {
  const key = name ? `${address}\u0000${name}` : address;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= MAX_CACHED) cache.clear();
  const mark = { initials: initials(name || address), tint: personTint(address) };
  cache.set(key, mark);
  return mark;
}
