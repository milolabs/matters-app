import { decodeHTML } from "entities";

// A small, linear-time HTML to plain text conversion for mail that has no text/plain part.
// Not a renderer: it keeps the words and the paragraph breaks, nothing else.
//
// Two entry points share one walk:
// - `htmlToText` keeps every word, hidden or not. It feeds the search index and the snippet, where
//   losing a word is worse than finding a hidden one.
// - `visibleText` leaves out what the reader's page would not show (ADR 0052, rule 8). Text hidden
//   from the person is the cheapest way to talk to a model through their mail (ADR 0047, category
//   `agent`), so what goes to a model is the second one.

const SKIPPED = new Set(["script", "style", "head", "title", "template"]);
const BREAKS = new Set([
  "br",
  "p",
  "div",
  "li",
  "tr",
  "table",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
]);
/** No content and no closing tag: they never open a hidden region. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** A new one of these ends the one before it, as in a browser. */
const ENDS_ITSELF = new Set(["p", "li", "dt", "dd", "option", "tr", "td", "th"]);

// Soft hyphens, zero-width characters and the like: invisible, and they break search too.
const INVISIBLE = /͏|[­؜ᅟᅠ឴឵᠎​-‏⁠-⁯﻿]/g;

/** Index of the next `</name` (any case) at or after `from`, or -1. */
function closingTag(html: string, name: string, from: number): number {
  let at = html.indexOf("</", from);
  while (at !== -1) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at;
    at = html.indexOf("</", at + 2);
  }
  return -1;
}

function tagName(tag: string): { name: string; closing: boolean } {
  let i = 0;
  const closing = tag.startsWith("/");
  if (closing) i = 1;
  let end = i;
  while (end < tag.length && /[A-Za-z0-9]/.test(tag.charAt(end))) end++;
  return { name: tag.slice(i, end).toLowerCase(), closing };
}

// --- Reading a tag the way a browser does (only for `visibleText`) ---

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly attrs: ReadonlyMap<string, string>;
  /** Index just after the `>`, or the length of the input for a tag that never ends. */
  readonly end: number;
  readonly unterminated: boolean;
}

const MAX_ATTRS = 64;
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * A `>` inside a quoted attribute value does not end the tag. Looking for the first `>` would
 * show the rest of such a tag as text, which would let a sender write markup the reader treats as
 * an attribute and this conversion treats as words.
 */
function readTag(html: string, lt: number): Tag {
  const n = html.length;
  let i = lt + 1;
  const closing = html[i] === "/";
  if (closing) i++;
  const nameStart = i;
  while (i < n && !isSpace(html.charAt(i)) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs = new Map<string, string>();
  while (i < n) {
    while (i < n && (isSpace(html.charAt(i)) || html[i] === "/")) i++;
    if (i >= n) break;
    if (html[i] === ">") return { name, closing, attrs, end: i + 1, unterminated: false };
    const start = i;
    i++; // a leading "=" belongs to the name, as in the HTML tokenizer
    while (
      i < n &&
      !isSpace(html.charAt(i)) &&
      html[i] !== "/" &&
      html[i] !== ">" &&
      html[i] !== "="
    ) {
      i++;
    }
    const attr = html.slice(start, i).toLowerCase();
    while (i < n && isSpace(html.charAt(i))) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && isSpace(html.charAt(i))) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return { name, closing, attrs, end: n, unterminated: true };
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const from = i;
        while (i < n && !isSpace(html.charAt(i)) && html[i] !== ">") i++;
        value = html.slice(from, i);
      }
    }
    if (!attrs.has(attr) && attrs.size < MAX_ATTRS) attrs.set(attr, decodeHTML(value));
  }
  return { name, closing, attrs, end: n, unterminated: true };
}

// --- What CSS hides ---

interface Declaration {
  readonly value: string;
  readonly important: boolean;
}
type Declarations = Map<string, Declaration>;

const WATCHED = new Set([
  "display",
  "visibility",
  "font-size",
  "opacity",
  "mso-hide",
  "height",
  "max-height",
  "width",
  "max-width",
  "overflow",
  "overflow-x",
  "overflow-y",
  "text-indent",
  "position",
  "left",
  "top",
]);

/** Removes `/* ... *\/` without a pattern that could rescan the rest of the input per comment. */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("/*", i);
    if (open === -1) return out + css.slice(i);
    out += css.slice(i, open);
    const close = css.indexOf("*/", open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
  return out;
}

/** CSS escapes (`di\73play`, `\:`) are honoured by a browser, so a sender can hide a property in one. */
function unescapeCss(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([^\n]))/g, (_m, hex?: string, any?: string) => {
    if (hex === undefined) return any ?? "";
    const code = Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function parseDeclarations(text: string, into: Declarations): void {
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const name = unescapeCss(part.slice(0, colon)).trim().toLowerCase();
    if (!WATCHED.has(name)) continue;
    let value = unescapeCss(part.slice(colon + 1))
      .trim()
      .toLowerCase();
    const important = /!\s*important$/.test(value);
    if (important) value = value.replace(/!\s*important$/, "").trim();
    const before = into.get(name);
    if (before?.important === true && !important) continue;
    into.set(name, { value, important });
  }
}

function isZero(value: string | undefined): boolean {
  if (value === undefined) return false;
  const m = /^[+-]?(\d*\.?\d+|\d+\.)([a-z%]*)$/.exec(value);
  return m !== null && Number.parseFloat(m[1] ?? "1") === 0;
}

function pixels(value: string | undefined): number {
  if (value === undefined) return 0;
  const m = /^([+-]?(?:\d*\.\d+|\d+))([a-z%]*)$/.exec(value);
  return m === null ? 0 : Number.parseFloat(m[1] ?? "0");
}

/**
 * Whether the page would not show an element with these declarations. Hidden means: not
 * displayed, `visibility` hidden or collapsed, nothing visible at `font-size: 0` or `opacity: 0`,
 * Outlook's `mso-hide`, a box of zero size that clips its content, and text pushed far off the
 * page. `color` against `background` is not looked at: that cannot be decided without a renderer.
 */
function hides(d: Declarations): boolean {
  const v = (name: string) => d.get(name)?.value;
  if (v("display") === "none") return true;
  const visibility = v("visibility");
  if (visibility === "hidden" || visibility === "collapse") return true;
  if (isZero(v("font-size")) || isZero(v("opacity"))) return true;
  if (v("mso-hide") === "all") return true;
  const clips = [v("overflow"), v("overflow-x"), v("overflow-y")].some((x) => x === "hidden");
  if (
    clips &&
    (isZero(v("height")) || isZero(v("max-height")) || isZero(v("width")) || isZero(v("max-width")))
  ) {
    return true;
  }
  if (pixels(v("text-indent")) <= -999) return true;
  const position = v("position");
  if (
    (position === "absolute" || position === "fixed") &&
    (pixels(v("left")) <= -999 || pixels(v("top")) <= -999)
  ) {
    return true;
  }
  return false;
}

interface Rule {
  readonly specificity: 0 | 1 | 2;
  readonly order: number;
  readonly declarations: Declarations;
}

/** Rules with one simple selector, found in the message's own `<style>` blocks. */
interface Sheet {
  readonly tags: Map<string, Rule[]>;
  readonly classes: Map<string, Rule[]>;
  readonly ids: Map<string, Rule[]>;
  count: number;
}

const MAX_SHEET_CHARS = 256 * 1024;
const MAX_RULES = 2000;
const MAX_AT_DEPTH = 3;

function addRule(map: Map<string, Rule[]>, name: string, rule: Rule): void {
  const list = map.get(name);
  if (list) list.push(rule);
  else map.set(name, [rule]);
}

/**
 * One selector reduced to what can be matched without a tree: `.class`, `#id`, `tag`, or any of
 * those as the last part of a descendant chain when it is a class or an id. Anything with a
 * pseudo-class or an attribute test is left out. Matching more elements than the browser would is
 * the safe side: the text of one is lost, never shown.
 */
function simpleSelector(selector: string): { kind: "tag" | "class" | "id"; name: string } | null {
  const text = unescapeCss(selector).trim().toLowerCase();
  if (text === "" || /[:[*]/.test(text)) return null;
  const last = text.split(/[\s>+~]+/).pop() ?? "";
  const chain = last !== text;
  let m = /^([a-z][a-z0-9]*)?\.([a-z_][\w-]*)$/.exec(last);
  if (m?.[2] !== undefined) return { kind: "class", name: m[2] };
  m = /^([a-z][a-z0-9]*)?#([a-z_][\w-]*)$/.exec(last);
  if (m?.[2] !== undefined) return { kind: "id", name: m[2] };
  if (!chain && /^[a-z][a-z0-9]*$/.test(last)) return { kind: "tag", name: last };
  return null;
}

function mediaApplies(query: string): boolean {
  const q = query.toLowerCase();
  return !(q.includes("print") || q.includes("max-") || q.includes("speech"));
}

function parseSheet(css: string, sheet: Sheet, depth: number): void {
  let i = 0;
  while (i < css.length && sheet.count < MAX_RULES) {
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (open === -1) return;
    if (semi !== -1 && semi < open && css.slice(i, semi).trimStart().startsWith("@")) {
      i = semi + 1; // @import, @charset
      continue;
    }
    // The block runs to its matching "}".
    let level = 1;
    let j = open + 1;
    while (j < css.length && level > 0) {
      const c = css.charAt(j);
      if (c === "{") level++;
      else if (c === "}") level--;
      j++;
    }
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, level === 0 ? j - 1 : j);
    i = j;
    if (prelude.startsWith("@")) {
      if (/^@media\b/i.test(prelude) && depth < MAX_AT_DEPTH && mediaApplies(prelude.slice(6))) {
        parseSheet(body, sheet, depth + 1);
      }
      continue;
    }
    const declarations: Declarations = new Map();
    parseDeclarations(body, declarations);
    if (declarations.size === 0) continue;
    for (const selector of prelude.split(",")) {
      const simple = simpleSelector(selector);
      if (simple === null) continue;
      const specificity = simple.kind === "id" ? 2 : simple.kind === "class" ? 1 : 0;
      const rule: Rule = { specificity, order: sheet.count++, declarations };
      addRule(
        simple.kind === "id" ? sheet.ids : simple.kind === "class" ? sheet.classes : sheet.tags,
        simple.name,
        rule,
      );
    }
  }
}

function readSheet(html: string): Sheet {
  const sheet: Sheet = { tags: new Map(), classes: new Map(), ids: new Map(), count: 0 };
  const lower = html.toLowerCase();
  let css = "";
  let at = 0;
  while (css.length < MAX_SHEET_CHARS) {
    at = lower.indexOf("<style", at);
    if (at === -1) break;
    const next = lower.charAt(at + 6);
    const gt = lower.indexOf(">", at);
    if (gt === -1) break;
    if (next !== ">" && !isSpace(next) && next !== "/") {
      at = gt;
      continue;
    }
    const close = lower.indexOf("</style", gt);
    const end = close === -1 ? html.length : close;
    css += `${html.slice(gt + 1, end)}\n`;
    if (close === -1) break;
    at = close + 7;
  }
  parseSheet(stripComments(css), sheet, 0);
  return sheet;
}

function elementHidden(tag: Tag, sheet: Sheet): boolean {
  const merged: Declarations = new Map();
  if (tag.attrs.has("hidden")) merged.set("display", { value: "none", important: false });
  const rules: Rule[] = [];
  const byTag = sheet.tags.get(tag.name);
  if (byTag) rules.push(...byTag);
  const id = tag.attrs.get("id")?.trim().toLowerCase();
  const byId = id === undefined ? undefined : sheet.ids.get(id);
  if (byId) rules.push(...byId);
  const classes = (tag.attrs.get("class") ?? "").toLowerCase().split(/\s+/, 20);
  for (const c of classes) {
    const byClass = sheet.classes.get(c);
    if (byClass) rules.push(...byClass);
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const rule of rules) {
    for (const [name, d] of rule.declarations) {
      if (merged.get(name)?.important === true && !d.important) continue;
      merged.set(name, d);
    }
  }
  const style = tag.attrs.get("style");
  if (style !== undefined) parseDeclarations(stripComments(style), merged);
  return merged.size > 0 && hides(merged);
}

// --- The walk ---

function convert(html: string, sheet: Sheet | undefined): string {
  let out = "";
  let i = 0;
  /** While set, text and tags are dropped until the element that hid it closes. */
  let hidden: { name: string; depth: number } | null = null;
  const text = (raw: string) => {
    if (hidden !== null) return;
    out += decodeHTML(raw.replace(/\s+/g, " ")).replace(INVISIBLE, "").replaceAll(" ", " ");
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    let name: string;
    let closing: boolean;
    let tag: Tag | undefined;
    if (sheet === undefined) {
      const gt = html.indexOf(">", lt + 1);
      if (gt === -1) break;
      // <!DOCTYPE ...>, <![if mso]> and <?xml ...?> are markup, not text.
      if (html[lt + 1] === "!" || html[lt + 1] === "?") {
        i = gt + 1;
        continue;
      }
      ({ name, closing } = tagName(html.slice(lt + 1, gt)));
      if (name === "") {
        // "<" in text that is not a tag (e.g. "a < b")
        out += "<";
        i = lt + 1;
        continue;
      }
      i = gt + 1;
    } else {
      if (html[lt + 1] === "!" || html[lt + 1] === "?") {
        const gt = html.indexOf(">", lt + 1);
        if (gt === -1) break;
        i = gt + 1;
        continue;
      }
      const first = html.charAt(lt + 1) === "/" ? html.charAt(lt + 2) : html.charAt(lt + 1);
      if (!/[A-Za-z]/.test(first)) {
        // "<" in text that is not a tag (e.g. "a < b")
        if (hidden === null) out += "<";
        i = lt + 1;
        continue;
      }
      tag = readTag(html, lt);
      if (tag.unterminated) break;
      name = tag.name;
      closing = tag.closing;
      i = tag.end;
    }

    if (!closing && SKIPPED.has(name)) {
      const end = closingTag(html, name, i);
      if (end === -1) break;
      const close = html.indexOf(">", end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (sheet !== undefined && tag !== undefined) {
      if (hidden !== null && hidden.name === name) {
        if (closing) {
          hidden.depth--;
          if (hidden.depth === 0) hidden = null;
          continue;
        }
        if (ENDS_ITSELF.has(name)) hidden = null;
        else {
          hidden.depth++;
          continue;
        }
      }
      if (hidden === null && !closing && !VOID.has(name) && elementHidden(tag, sheet)) {
        hidden = { name, depth: 1 };
        // A hidden block still separates the words on either side of it.
        if (BREAKS.has(name)) out += "\n";
        continue;
      }
      if (hidden !== null) continue;
    }
    if (BREAKS.has(name)) out += "\n";
  }
  return out
    .replace(/ {2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every word of the HTML, hidden ones too. For search and for snippets. */
export function htmlToText(html: string): string {
  return convert(html, undefined);
}

/**
 * What the reader's page shows, as plain text: the words of `htmlToText` minus those inside an
 * element that CSS or the `hidden` attribute hides (`display: none`, `visibility: hidden`,
 * `font-size: 0`, `opacity: 0`, a zero-size box that clips, text pushed off the page, Outlook's
 * `mso-hide`), whether the rule is inline or in the message's own `<style>` (single `.class`,
 * `#id` or tag selectors). An element that never closes hides the rest, as it would on a page.
 * Tags are read as a browser reads them, so a `>` inside a quoted attribute does not end one.
 * What is left out is a limit, not a promise: colour against background, and rules this walk
 * cannot match without a tree, are not looked at.
 */
export function visibleText(html: string): string {
  return convert(html, readSheet(html));
}
