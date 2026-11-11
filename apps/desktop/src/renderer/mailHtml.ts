import DOMPurify from "dompurify";
import { type MailTheme, mailTheme } from "./mailTheme.ts";

// Everything a page could use to act, ask or fetch beyond images. The frame's sandbox and policy
// stop these again (ADR 0024); this is the first of the two walls.
const FORBID_TAGS = [
  "script",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "audio",
  "video",
  "source",
  "track",
  "svg",
  "math",
  "marquee",
  "dialog",
];

const REMOTE =
  /(?:\b(?:src|srcset|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\/)|(?:url\(\s*["']?\s*(?:https?:)?\/\/)/i;

/**
 * Page basics; the sender's own styles come after and can override them. The dark ground and ink
 * are the app's (`--bg`, `--ink`): they apply when the frame shows a message in dark (ADR 0085).
 */
const BASE_STYLE =
  "<style>html{background:#fff;color:#1d1d1f}body{margin:0;padding:16px;font:14px/1.5 -apple-system,system-ui,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}a{color:#1a56c4}pre{white-space:pre-wrap}@media (prefers-color-scheme:dark){html{background:#1e1e20;color:#f5f5f7}a{color:#8ab4f8}}</style>";

export interface CleanMail {
  readonly html: string;
  /** It asks for images from the network (declared pixels excluded): the reader decides whether they load. */
  readonly hasRemoteContent: boolean;
  /** What the message says about themes: its own dark variant, light only, or nothing (ADR 0085). */
  readonly theme: MailTheme;
}

/** One side of an image as declared: `style` wins over the attribute, as it does in a page. */
function declaredSize(img: Element, side: "width" | "height"): number | null {
  const px = /^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/;
  let found: number | null = null;
  const style = (img.getAttribute("style") ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() !== side) continue;
    const value = declaration
      .slice(colon + 1)
      .replace(/!important\s*$/i, "")
      .trim()
      .toLowerCase();
    // The last valid declaration counts; one that is not a length in px is not a size.
    const m = px.exec(value);
    found = m?.[1] === undefined ? found : Number(m[1]);
  }
  if (found !== null) return found;
  const attribute = px.exec((img.getAttribute(side) ?? "").trim().toLowerCase());
  return attribute?.[1] === undefined ? null : Number(attribute[1]);
}

/** Declared as at most 1×1 in both dimensions: a tracking pixel, whatever the reader decided (ADR 0037). */
function isPixel(img: Element): boolean {
  const width = declaredSize(img, "width");
  const height = declaredSize(img, "height");
  return width !== null && height !== null && width <= 1 && height <= 1;
}

/**
 * Runs before the attributes of each element are sanitized, so it reads the sizes as sent: the
 * policy for URIs below also strips plain values such as `width="1"`, which would hide a pixel.
 */
function dropPixels(node: Node): void {
  if (node.nodeName === "IMG" && isPixel(node as Element)) node.parentNode?.removeChild(node);
}

export function sanitizeMail(html: string): CleanMail {
  // The hook lives for this call only: the sanitizer is shared with the rest of the page.
  DOMPurify.addHook("beforeSanitizeAttributes", dropPixels);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS,
      FORBID_ATTR: ["srcdoc", "action", "formaction", "ping", "target"],
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp);|#)/i,
    });
  } finally {
    DOMPurify.removeHook("beforeSanitizeAttributes", dropPixels);
  }
  return {
    html: `${BASE_STYLE}${clean}`,
    hasRemoteContent: REMOTE.test(clean),
    theme: mailTheme(html, clean),
  };
}
