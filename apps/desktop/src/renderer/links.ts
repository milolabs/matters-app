const LOOKS_LIKE_ADDRESS = /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?:[/?#]\S*)?$/iu;

/** The links we hand to the system; anything else (javascript:, file:) goes nowhere. */
export function isOpenable(href: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(href.trim());
}

/**
 * Characters that draw nothing: format characters (zero-width space and joiners, the word joiner,
 * the soft hyphen, bidirectional controls), controls other than ordinary white space, line and
 * paragraph separators, and the blank letters of Hangul and Braille. A reader sees the text
 * without them, so the comparison must too (ADR 0048).
 */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Cc}⠀ㅤᅟᅠﾠ]/gu;

export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, (c) => (/[\t\n\v\f\r]/.test(c) ? c : ""));
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * When a link's text is itself an address and the link goes elsewhere, the host in that text: the
 * classic phishing shape. Null for ordinary links, and for a subdomain of the same site.
 */
export function misleadingHost(text: string, href: string): string | null {
  const shown = LOOKS_LIKE_ADDRESS.exec(withoutInvisible(text).trim())?.[1];
  if (!shown) return null;
  let target: string;
  try {
    target = bare(new URL(href).hostname);
  } catch {
    return shown;
  }
  const claimed = bare(shown);
  return target === claimed || target.endsWith(`.${claimed}`) || claimed.endsWith(`.${target}`)
    ? null
    : shown;
}

/** Hands a link to the system browser, through the preload script. */
export function openExternally(href: string): void {
  window.postMessage({ mattersOpenLink: href }, "*");
}

/**
 * The text of a CSS `content` value, when it is only quoted strings (`"a"`, `"a" "b"`); empty for
 * `none`, `normal`, and anything else (`counter()`, `attr()`, `url()`, an alternative text after
 * a slash, an unterminated string). Escapes are decoded as CSS does: `\\41 ` and `\\"`.
 */
export function cssStringContent(value: string): string {
  const v = value.trim();
  let out = "";
  let i = 0;
  while (i < v.length) {
    const quote = v.charAt(i);
    if (quote === " " || quote === "\t" || quote === "\n") {
      i++;
      continue;
    }
    if (quote !== '"' && quote !== "'") return "";
    i++;
    let closed = false;
    while (i < v.length) {
      const c = v.charAt(i);
      if (c === quote) {
        closed = true;
        i++;
        break;
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const hex = /^[0-9a-fA-F]{1,6}/.exec(v.slice(i + 1))?.[0];
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        const ok = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
        out += ok ? String.fromCodePoint(code) : "\uFFFD";
        i += 1 + hex.length;
        if (/[ \t\n]/.test(v.charAt(i))) i++;
      } else if (v.charAt(i + 1) === "\n") {
        i += 2;
      } else {
        out += v.charAt(i + 1);
        i += 2;
      }
    }
    if (!closed) return "";
  }
  return out;
}

/** The part of a DOM node that `visibleLinkText` reads; the real DOM fits it, and so does a fake. */
export interface TextNode {
  readonly nodeType: number;
  readonly data?: string;
  readonly childNodes: ArrayLike<TextNode>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * What a reader sees in a link: its text, in order, with the text CSS draws before and after the
 * link and each element inside it. `pseudo` returns the decoded `content` of one pseudo-element
 * (empty when it has none or the caller is out of budget). Walks with a stack, not recursion, so
 * deep markup cannot overflow it; each node is visited once.
 */
export function visibleLinkText(
  link: TextNode,
  pseudo: (el: TextNode, which: "::before" | "::after") => string,
): string {
  type Step = TextNode | { readonly after: TextNode };
  let out = pseudo(link, "::before");
  const stack: Step[] = [{ after: link }];
  const pushChildren = (el: TextNode) => {
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const child = el.childNodes[i];
      if (child) stack.push(child);
    }
  };
  pushChildren(link);
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    if ("after" in step) {
      out += pseudo(step.after, "::after");
    } else if (step.nodeType === TEXT_NODE) {
      out += step.data ?? "";
    } else if (step.nodeType === ELEMENT_NODE) {
      out += pseudo(step, "::before");
      stack.push({ after: step });
      pushChildren(step);
    }
  }
  return out;
}
