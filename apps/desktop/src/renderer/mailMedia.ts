/**
 * Paper says what the screen said (ADR 0144, rule 3). A sender's CSS can ask what it is drawn on:
 * `@media print` shows or hides text only on paper, `@page` writes in the page's margins, and some
 * media features answer differently for a printer than for the screen (`update`, `resolution`).
 * So the sanitizer rewrites what a message's style sheets ask, as text, to questions whose answer
 * is the screen's wherever the message is drawn:
 *
 * - the media type `print` never matches and `screen` always does, so a print block is dropped
 *   and a screen block applies on paper too; `not` keeps its meaning (`not print` is everything);
 * - a feature of the output device (`update`, `resolution`, `device-pixel-ratio`, `color`,
 *   `color-index`, `monochrome`) is answered once, by the screen the reader is on (`device`), and
 *   written in as a constant;
 * - `@page` rules are dropped.
 *
 * On screen nothing changes: the screen already answered these questions this way. Features that
 * depend on the frame's size (`width`, `orientation`) stay: the print view lays every frame out at
 * the width it is printed at. Pure: the device is asked through `device`, so a test needs no page.
 */

/** Answers one media feature, `(min-resolution: 2dppx)`, for the screen the reader is on. */
export type DeviceQuery = (feature: string) => boolean;

/** A feature that reads the output device rather than the frame. */
const DEVICE_FEATURE =
  /^\s*(?:-webkit-)?(?:min-|max-)?(?:update|resolution|device-pixel-ratio|color|color-index|monochrome)\b|\b(?:update|resolution|device-pixel-ratio|color|color-index|monochrome)\s*[<>=]|[<>=]\s*(?:-webkit-)?(?:update|resolution|device-pixel-ratio|color|color-index|monochrome)\b/i;

/** Always true and always false, for a frame of any size that is drawn at all. */
const TRUE_FEATURE = "(min-width:0px)";
const FALSE_FEATURE = "(max-width:0px)";

/** CSS escapes decoded (`pr\69nt` is `print`), comments removed: what the browser reads. */
function plainCss(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_m, hex: string | undefined, ch?: string) => {
      if (hex === undefined) return ch === "\n" ? "" : (ch ?? "");
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    });
}

/** Splits at the commas that are not inside parentheses. */
function topLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Each innermost `( … )` that names a device feature, answered by the screen. */
function answerDeviceFeatures(condition: string, device: DeviceQuery): string {
  return condition.replace(/\([^()]*\)/g, (group) => {
    const inner = group.slice(1, -1);
    if (!DEVICE_FEATURE.test(inner)) return group;
    let answer = false;
    try {
      answer = device(group);
    } catch {
      answer = false;
    }
    return answer ? TRUE_FEATURE : FALSE_FEATURE;
  });
}

/**
 * One media query as the screen reads it, or null when it never matches on screen. The type is
 * the first word, after an optional `only` or `not`; a query that starts with `(` has none.
 */
function screenQuery(query: string, device: DeviceQuery): string | null {
  const q = query.trim().replace(/\s+/g, " ");
  // An empty query in a list is not valid, so it never matches.
  if (q === "") return null;
  const m = /^(?:(only|not)\s+)?([a-z-]+)(?=\s|$)(.*)$/i.exec(q);
  if (m === null || /^(?:and|not|only|or)$/i.test(m[2] ?? "")) {
    // No type: a condition, `(width > 600px)` or `not (color)`.
    return answerDeviceFeatures(q, device);
  }
  const prefix = (m[1] ?? "").toLowerCase();
  const type = (m[2] ?? "").toLowerCase();
  const rest = answerDeviceFeatures(m[3] ?? "", device);
  if (type === "print") {
    // Never true on screen; `not print …` is true on screen whatever follows.
    return prefix === "not" ? "all" : null;
  }
  if (type === "screen" || type === "all") {
    return `${prefix === "not" ? "not " : prefix === "only" ? "only " : ""}all${rest}`;
  }
  // Another type (`speech`, `tv`, an unknown word) matches neither screen nor paper: as written.
  return `${prefix === "" ? "" : `${prefix} `}${type}${rest}`;
}

/**
 * A media query list (`@media` prelude, a `media` attribute) as the screen reads it, or null when
 * no query of it can match on screen.
 */
export function screenMediaList(list: string, device: DeviceQuery): string | null {
  const plain = plainCss(list);
  // No query at all is `all`.
  if (plain.trim() === "") return "all";
  const queries = topLevelCommas(plain)
    .map((q) => screenQuery(q, device))
    .filter((q): q is string => q !== null);
  return queries.length === 0 ? null : queries.join(", ");
}

/** The end of a quoted string that starts at `i` (the quote), or the end of the text. */
function stringEnd(css: string, i: number): number {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length) {
    const c = css[j];
    if (c === "\\") j += 2;
    else if (c === quote || c === "\n") return j + 1;
    else j++;
  }
  return css.length;
}

/**
 * Just after the `}` that closes the block opened at `open`, and whether one did: a block left open
 * runs to the end of the sheet, where the browser closes it.
 */
function blockEnd(css: string, open: number): { end: number; closed: boolean } {
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close < 0 ? css.length : close + 2;
    } else if (c === '"' || c === "'") i = stringEnd(css, i);
    else if (c === "\\") i += 2;
    else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return { end: i + 1, closed: true };
      }
      i++;
    }
  }
  return { end: css.length, closed: false };
}

/** The name of the at-keyword at `at` (escapes decoded, lower case) and where the name ends. */
function atName(css: string, at: number): { name: string; end: number } {
  let j = at + 1;
  while (j < css.length) {
    const c = css[j] as string;
    if (c === "\\") {
      // An escape: up to six hex digits and one white space, or one character.
      const hex = /^[0-9a-f]{1,6}\s?/i.exec(css.slice(j + 1, j + 8));
      j += hex ? 1 + hex[0].length : 2;
    } else if (/[a-z0-9_-]/i.test(c) || c.charCodeAt(0) > 0x7f) j++;
    else break;
  }
  return { name: plainCss(css.slice(at + 1, j)).toLowerCase(), end: j };
}

/** Where the prelude of an at-rule ends: at its `{` or `;`, outside strings and parentheses. */
function preludeEnd(css: string, from: number): number {
  let i = from;
  let depth = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close < 0 ? css.length : close + 2;
    } else if (c === '"' || c === "'") i = stringEnd(css, i);
    else if (c === "\\") i += 2;
    else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if ((c === "{" || c === ";") && depth === 0) return i;
    else i++;
  }
  return css.length;
}

/**
 * A style sheet as the screen reads it, wherever it is drawn: `@media` preludes rewritten by
 * `screenMediaList` (a block no query of which matches on screen is dropped whole), `@page` rules
 * dropped, every other block walked for more of them (nesting, `@supports`, `@layer`). Strings,
 * comments and escapes are stepped over, never searched. Text outside at-rules is kept as written.
 */
export function screenMediaCss(css: string, device: DeviceQuery): string {
  let out = "";
  let i = 0;
  let copied = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close < 0 ? css.length : close + 2;
    } else if (c === '"' || c === "'") i = stringEnd(css, i);
    else if (c === "\\") i += 2;
    else if (c === "@") {
      const { name, end: nameEnd } = atName(css, i);
      const stop = preludeEnd(css, nameEnd);
      if (css[stop] !== "{") {
        // A statement (`@import`, `@charset`) or the end of the sheet: kept as written.
        i = stop + 1;
        continue;
      }
      const { end: close, closed } = blockEnd(css, stop);
      const inner = css.slice(stop + 1, closed ? close - 1 : close);
      out += css.slice(copied, i);
      if (name === "page") {
        // Paper only: its margin boxes can write text that no screen shows.
      } else if (name === "media") {
        const list = screenMediaList(css.slice(nameEnd, stop), device);
        if (list !== null) out += `@media ${list}{${screenMediaCss(inner, device)}}`;
      } else {
        out += `${css.slice(i, stop + 1)}${screenMediaCss(inner, device)}${closed ? "}" : ""}`;
      }
      i = close;
      copied = close;
    } else if (c === "{") {
      // A rule's block may hold nested at-rules (CSS nesting).
      const { end: close, closed } = blockEnd(css, i);
      out += css.slice(copied, i + 1);
      out += screenMediaCss(css.slice(i + 1, closed ? close - 1 : close), device);
      if (closed) out += "}";
      i = close;
      copied = close;
    } else i++;
  }
  return out + css.slice(copied);
}

/** The screen the reader is on, when there is one; elsewhere no device feature matches. */
export const screenDevice: DeviceQuery = (feature) =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(feature).matches
    : false;
