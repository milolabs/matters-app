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
const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTR = /\s*([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

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
      NAME.lastIndex = i + 2;
      const m = NAME.exec(s);
      const end = m ? s.indexOf(">", NAME.lastIndex) : -1;
      const open = stack.pop();
      if (!m || end === -1 || s.slice(NAME.lastIndex, end).trim() !== "") {
        throw new XmlError("malformed closing tag", i);
      }
      if (!open || open.name !== m[0]) {
        throw new XmlError(`closing tag ${m[0]} does not match ${open?.name ?? "anything"}`, i);
      }
      i = end + 1;
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(s);
      if (!m) throw new XmlError("malformed tag", i);
      if (++nodes > MAX_NODES) throw new XmlError("too many elements", i);
      const attrs: Record<string, string> = {};
      let p = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = p;
        const a = ATTR.exec(s);
        if (!a) break;
        attrs[a[1] as string] = decode(a[2] ?? a[3] ?? "", p);
        p = ATTR.lastIndex;
      }
      while (/\s/.test(s[p] ?? "")) p++;
      const selfClosing = s[p] === "/";
      if (selfClosing) p++;
      if (s[p] !== ">") throw new XmlError("malformed tag", i);
      i = p + 1;

      const node: XmlNode = { name: m[0], attrs, children: [], text: "" };
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
