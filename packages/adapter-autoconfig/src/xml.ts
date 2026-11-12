/** The XML subset autoconfig files use: elements, attributes, text, CDATA, comments. */
export interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

export class XmlError extends Error {
  constructor(message: string, position: number) {
    super(`Invalid XML at ${position}: ${message}`);
    this.name = "XmlError";
  }
}

const MAX_DEPTH = 32;
const MAX_NODES = 5000;
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// Names and attributes are read by hand, so the time a tag takes grows with its length only.
const SPACE = /\s/;

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isNameChar = (c: number) =>
  isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 58;

/** Where the name `[A-Za-z_][\w.:-]*` at `at` ends, or -1 when none starts there. */
function nameEnd(s: string, at: number): number {
  if (!isNameStart(s.charCodeAt(at))) return -1;
  let p = at + 1;
  while (p < s.length && isNameChar(s.charCodeAt(p))) p++;
  return p;
}

function skipSpace(s: string, at: number): number {
  let p = at;
  while (p < s.length && SPACE.test(s[p] as string)) p++;
  return p;
}

/** `name="value"` or `name='value'` at `at`, after optional white space; null when there is none. */
function attribute(s: string, at: number): { name: string; value: string; end: number } | null {
  const start = skipSpace(s, at);
  const end = nameEnd(s, start);
  if (end === -1) return null;
  let p = skipSpace(s, end);
  if (s[p] !== "=") return null;
  p = skipSpace(s, p + 1);
  const quote = s[p];
  if (quote !== '"' && quote !== "'") return null;
  const close = s.indexOf(quote, p + 1);
  if (close === -1) return null;
  return { name: s.slice(start, end), value: s.slice(p + 1, close), end: close + 1 };
}

const UNKNOWN_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[\w#]+;/;

function decode(text: string, at: number): string {
  // Entities from a DTD are never defined here; refuse them instead of dropping them silently.
  const unknown = UNKNOWN_ENTITY.exec(text);
  if (unknown) throw new XmlError(`unknown entity ${unknown[0]}`, at);
  return text.replace(ENTITY, (_m, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? "";
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : "";
  });
}

/**
 * Parses a document into a tree. Strict about structure (mismatched or unclosed tags throw
 * `XmlError`) and closed to anything that could expand: DOCTYPE and entity declarations are
 * refused, so a hostile file cannot make it allocate or read anything.
 */
export function parseXml(source: string): XmlNode {
  const s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let i = 0;

  const text = (value: string, at: number) => {
    const top = stack[stack.length - 1];
    if (top) top.text += decode(value, at);
    else if (value.trim() !== "") throw new XmlError("text outside the root element", at);
  };

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      text(s.slice(i), i);
      break;
    }
    if (lt > i) text(s.slice(i, lt), i);
    i = lt;

    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end === -1) throw new XmlError("unterminated comment", i);
      i = end + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      const top = stack[stack.length - 1];
      if (end === -1 || !top) throw new XmlError("misplaced or unterminated CDATA", i);
      top.text += s.slice(i + 9, end);
      i = end + 3;
    } else if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i + 2);
      if (end === -1) throw new XmlError("unterminated processing instruction", i);
      i = end + 2;
    } else if (s.startsWith("<!", i)) {
      throw new XmlError("DOCTYPE and entity declarations are not accepted", i);
    } else if (s.startsWith("</", i)) {
      const nameAt = i + 2;
      const after = nameEnd(s, nameAt);
      const end = after === -1 ? -1 : s.indexOf(">", after);
      const open = stack.pop();
      if (end === -1 || s.slice(after, end).trim() !== "") {
        throw new XmlError("malformed closing tag", i);
      }
      const name = s.slice(nameAt, after);
      if (!open || open.name !== name) {
        throw new XmlError(`closing tag ${name} does not match ${open?.name ?? "anything"}`, i);
      }
      i = end + 1;
    } else {
      const after = nameEnd(s, i + 1);
      if (after === -1) throw new XmlError("malformed tag", i);
      const name = s.slice(i + 1, after);
      if (++nodes > MAX_NODES) throw new XmlError("too many elements", i);
      const attrs: Record<string, string> = {};
      let p = after;
      for (;;) {
        const a = attribute(s, p);
        if (!a) break;
        attrs[a.name] = decode(a.value, p);
        p = a.end;
      }
      p = skipSpace(s, p);
      const selfClosing = s[p] === "/";
      if (selfClosing) p++;
      if (s[p] !== ">") throw new XmlError("malformed tag", i);
      i = p + 1;

      const node: XmlNode = { name, attrs, children: [], text: "" };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) throw new XmlError("more than one root element", lt);
      else root = node;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError("nested too deeply", lt);
        stack.push(node);
      }
    }
  }
  if (stack.length > 0)
    throw new XmlError(`unclosed element ${stack[stack.length - 1]?.name}`, s.length);
  if (!root) throw new XmlError("no root element", 0);
  return root;
}

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((c) => c.name === name);

export const childText = (node: XmlNode, name: string): string | undefined => {
  const found = node.children.find((c) => c.name === name);
  return found ? found.text.trim() : undefined;
};
