/**
 * Mail in the app's dark theme (ADR 0085). A sender's own theme comes first: a message that has a
 * dark variant gets it, and one that asks to stay light stays light. Only a message that says
 * nothing is recolored, here, as text: no layout, no styles computed by the browser.
 */

/** What a message says about themes. */
export type MailTheme = "dark" | "light-only" | "none";

/**
 * The ground and ink under a message in dark: the theme's `bg` and `ink` (ADR 0134, rule 10), or
 * the default's. Opaque `#rrggbb`, as the theme check leaves them.
 */
export interface MailGround {
  readonly bg: string;
  readonly ink: string;
}

/** The default theme's dark ground and ink (`styles.css`, ADR 0085). */
export const DEFAULT_MAIL_GROUND: MailGround = { bg: "#1e1e20", ink: "#f5f5f7" };

/**
 * Page basics; the sender's own styles come after and can override them. In light a message is
 * shown as sent, on white; in dark the ground and ink are the app's (ADR 0085, amended by ADR 0134,
 * rule 10: the theme's). Only hex from the theme check is put in, so nothing else can reach CSS.
 */
export function mailBaseStyle(ground: MailGround = DEFAULT_MAIL_GROUND): string {
  return `<style>html{background:#fff;color:#1d1d1f}body{margin:0;padding:16px;font:14px/1.5 -apple-system,system-ui,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}a{color:#1a56c4}pre{white-space:pre-wrap}@media (prefers-color-scheme:dark){html{background:${ground.bg};color:${ground.ink}}a{color:#8ab4f8}}</style>`;
}

const DEFAULT_BASE = mailBaseStyle();
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const isDefaultGround = (g: MailGround) =>
  g.bg === DEFAULT_MAIL_GROUND.bg && g.ink === DEFAULT_MAIL_GROUND.ink;

/** How the frame shows a message: which page markup, and the scheme its media queries see. */
export interface MailView {
  readonly html: string;
  readonly scheme: "light" | "dark";
}

const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const META = /<meta\b[^>]*>/gi;

/** The CSS a message carries, from `<style>` elements and `style` attributes, without the rest. */
function cssOf(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(STYLE_ELEMENT)) out.push(m[1] ?? "");
  for (const m of html.matchAll(STYLE_ATTRIBUTE)) out.push(m[1] ?? m[2] ?? "");
  return out.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The words of a `color-scheme` value or meta content: "light dark", "only light". */
function schemeWords(value: string): { dark: boolean; lightOnly: boolean } {
  const words = value.toLowerCase().split(/[\s,]+/);
  const dark = words.includes("dark");
  return { dark, lightOnly: !dark && words.includes("only") && words.includes("light") };
}

/**
 * Reads what a message says about themes. `raw` is the message as sent: the sanitizer drops
 * `<meta>`, so its `color-scheme` and `supported-color-schemes` are read there. `clean` is the
 * sanitized markup, whose CSS is read: text of the message never counts.
 */
export function mailTheme(raw: string, clean: string): MailTheme {
  let lightOnly = false;
  for (const tag of raw.matchAll(META)) {
    const t = tag[0];
    if (!/\bname\s*=\s*["']?(?:color-scheme|supported-color-schemes)\b/i.test(t)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(t);
    const words = schemeWords(content?.[1] ?? content?.[2] ?? content?.[3] ?? "");
    if (words.dark) return "dark";
    lightOnly ||= words.lightOnly;
  }
  const css = cssOf(clean);
  if (/@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(css)) return "dark";
  for (const m of css.matchAll(/(?:^|[{;\s])color-scheme\s*:\s*([^;}]+)/gi)) {
    const words = schemeWords((m[1] ?? "").replace(/!important/i, ""));
    if (words.dark) return "dark";
    lightOnly ||= words.lightOnly;
  }
  return lightOnly ? "light-only" : "none";
}

/**
 * The view for the app's theme. `darken` runs only for a message that says nothing, in dark. In
 * dark the base style's ground and ink are the theme's (`ground`), and what is recolored lands on
 * that ground (ADR 0134, rule 10).
 */
export function mailView(
  clean: { readonly html: string; readonly theme: MailTheme },
  appDark: boolean,
  darken?: (html: string) => string,
  ground: MailGround = DEFAULT_MAIL_GROUND,
): MailView {
  if (!appDark || clean.theme === "light-only") return { html: clean.html, scheme: "light" };
  // The default's ground, or one that is not plain hex: the message as `sanitizeMail` made it.
  const plain =
    isDefaultGround(ground) || !HEX_COLOR.test(ground.bg) || !HEX_COLOR.test(ground.ink);
  const html =
    plain || !clean.html.startsWith(DEFAULT_BASE)
      ? clean.html
      : mailBaseStyle(ground) + clean.html.slice(DEFAULT_BASE.length);
  if (clean.theme === "dark") return { html, scheme: "dark" };
  const recolor = darken ?? ((h: string) => darkenMail(h, plain ? undefined : ground));
  return { html: recolor(html), scheme: "dark" };
}

// ---- Colors ---------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/** Named colors senders use; any other name is left as it is. */
const NAMED: Readonly<Record<string, string>> = {
  white: "#ffffff",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  gainsboro: "#dcdcdc",
  whitesmoke: "#f5f5f5",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  snow: "#fffafa",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  linen: "#faf0e6",
  aliceblue: "#f0f8ff",
  ghostwhite: "#f8f8ff",
  azure: "#f0ffff",
  honeydew: "#f0fff0",
  mintcream: "#f5fffa",
  floralwhite: "#fffaf0",
  oldlace: "#fdf5e6",
  seashell: "#fff5ee",
  lavender: "#e6e6fa",
  lightyellow: "#ffffe0",
  lightblue: "#add8e6",
  navy: "#000080",
  blue: "#0000ff",
  darkblue: "#00008b",
  red: "#ff0000",
  darkred: "#8b0000",
  maroon: "#800000",
  green: "#008000",
  darkgreen: "#006400",
  purple: "#800080",
  teal: "#008080",
  olive: "#808000",
};

function hex(value: string): Rgb | null {
  const h = value.slice(1);
  const full =
    h.length === 3 || h.length === 4
      ? [...h.slice(0, 3)].map((c) => c + c).join("")
      : h.length === 6 || h.length === 8
        ? h.slice(0, 6)
        : null;
  if (full === null || !/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

/** The alpha a color token carries, as written, to put back unchanged: "", "80", ", 0.5". */
interface Parsed {
  readonly rgb: Rgb;
  readonly alpha: number | null;
}

function channel(part: string, max: number): number {
  const p = part.trim();
  return p.endsWith("%") ? Number.parseFloat(p) / 100 : Number.parseFloat(p) / max;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function parseColor(token: string): Parsed | null {
  const t = token.toLowerCase();
  if (t.startsWith("#")) {
    const rgb = hex(t);
    if (rgb === null) return null;
    const a = t.length === 5 ? t[4]?.repeat(2) : t.length === 9 ? t.slice(7) : undefined;
    return { rgb, alpha: a === undefined ? null : Number.parseInt(a, 16) / 255 };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(t);
  if (fn) {
    const parts = (fn[2] ?? "").split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const alpha = parts[3] === undefined ? null : channel(parts[3], 1);
    let rgb: Rgb;
    if (fn[1]?.startsWith("rgb")) {
      rgb = [
        channel(parts[0] ?? "", 255),
        channel(parts[1] ?? "", 255),
        channel(parts[2] ?? "", 255),
      ];
    } else {
      const h = Number.parseFloat(parts[0] ?? "");
      rgb = hslToRgb(
        ((h % 360) + 360) % 360,
        channel(parts[1] ?? "", 100),
        channel(parts[2] ?? "", 100),
      );
    }
    if (rgb.some((c) => !Number.isFinite(c)) || (alpha !== null && !Number.isFinite(alpha))) {
      return null;
    }
    return { rgb: rgb.map((c) => Math.min(1, Math.max(0, c))) as unknown as Rgb, alpha };
  }
  const named = NAMED[t];
  return named === undefined ? null : parseColor(named);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB to OKLCH, the space where lightness is what the eye sees. */
function toOklch([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToRgb(L: number, C: number, h: number): Rgb | null {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (rgb.some((c) => c < -1e-4 || c > 1 + 1e-4)) return null;
  return rgb.map((c) => fromLinear(Math.min(1, Math.max(0, c)))) as unknown as Rgb;
}

/** Keeps the lightness and hue and gives up chroma until the color fits in sRGB. */
function inGamut(L: number, C: number, h: number): Rgb {
  let c = C;
  for (let i = 0; i < 24; i++) {
    const rgb = oklchToRgb(L, c, h);
    if (rgb !== null) return rgb;
    c *= 0.85;
  }
  return oklchToRgb(L, 0, h) ?? [L, L, L];
}

/** The app's dark ground (`--bg`, #1e1e20) in OKLCH lightness: where white lands. */
const GROUND = 0.235;
/** Grounds lighter than this are taken for light; darker ones were meant dark and stay. */
const LIGHT_GROUND = 0.6;
/** Ink darker than this is taken for dark ink and lightened; lighter ink stays. */
const DARK_INK = 0.6;

export type Role = "ground" | "ink";

/** Grounds with less chroma than this read as white or grey: they take the theme ground's tint. */
const NEUTRAL = 0.03;

/** The dark ground recolored grounds land on, in OKLCH; the default's has no tint to give. */
type GroundLch = readonly [number, number, number];
const DEFAULT_GROUND_LCH: GroundLch = [GROUND, 0, 0];

/** A theme's ground in OKLCH, once per message (ADR 0134, rule 10). */
export function groundLch(ground: MailGround | undefined): GroundLch {
  const rgb = ground ? hex(ground.bg) : null;
  return rgb ? toOklch(rgb) : DEFAULT_GROUND_LCH;
}

/**
 * One color for the dark theme. A light ground becomes dark (white goes to the app's ground: the
 * theme's `bg`, ADR 0134, rule 10) and dark ink becomes light (black to about #e8e8e8); both keep
 * their hue, so a brand stays recognisable, and a white or grey ground takes the theme ground's
 * tint. Colors already right for dark stay as they are.
 */
export function darkColor(
  rgb: Rgb,
  role: Role,
  ground: GroundLch = DEFAULT_GROUND_LCH,
): Rgb | null {
  const [L, C, h] = toOklch(rgb);
  if (role === "ground") {
    if (L <= LIGHT_GROUND) return null;
    const [gL, gC, gh] = ground;
    return C < NEUTRAL
      ? inGamut(gL + (1 - L) * 0.5, gC, gh)
      : inGamut(gL + (1 - L) * 0.5, C * 0.6, h);
  }
  if (L >= DARK_INK) return null;
  return inGamut(0.93 - L * 0.4, C, h);
}

const byte = (c: number) =>
  Math.round(c * 255)
    .toString(16)
    .padStart(2, "0");

function format(rgb: Rgb, alpha: number | null): string {
  const base = `#${rgb.map(byte).join("")}`;
  return alpha === null || alpha >= 1 ? base : `${base}${byte(alpha)}`;
}

const COLOR_TOKEN = new RegExp(
  `#[0-9a-f]{3,8}\\b|(?:rgba?|hsla?)\\([^)]*\\)|\\b(?:${Object.keys(NAMED).join("|")})\\b`,
  "gi",
);

/** Every color in a CSS value, for its role; what is in `url(…)` is left alone. */
function recolorValue(value: string, role: Role, ground: GroundLch): string {
  return value
    .split(/(url\([^)]*\))/i)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(COLOR_TOKEN, (token) => {
            const parsed = parseColor(token);
            const next = parsed === null ? null : darkColor(parsed.rgb, role, ground);
            return next === null || parsed === null ? token : format(next, parsed.alpha);
          }),
    )
    .join("");
}

/** The role of a CSS property's colors, or null for properties whose colors stay. */
function roleOf(property: string): Role | null {
  const p = property.toLowerCase();
  if (p === "color" || p === "text-decoration-color" || p === "-webkit-text-fill-color") {
    return "ink";
  }
  if (p === "background" || p === "background-color") return "ground";
  if (
    /^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?)$/.test(
      p,
    )
  ) {
    return "ground";
  }
  return null;
}

/** CSS declarations, in a style sheet or a `style` attribute, with their colors for dark. */
export function darkenCss(css: string, ground: GroundLch = DEFAULT_GROUND_LCH): string {
  return css.replace(
    /(^|[{;\s])([a-z-]+)(\s*:\s*)([^;{}]+)/gi,
    (whole, before: string, property: string, colon: string, value: string) => {
      const role = roleOf(property);
      return role === null
        ? whole
        : `${before}${property}${colon}${recolorValue(value, role, ground)}`;
    },
  );
}

/** Old presentational attributes that carry colors. */
const ATTRIBUTE_ROLES: Readonly<Record<string, Role>> = {
  bgcolor: "ground",
  color: "ink",
  text: "ink",
  link: "ink",
  vlink: "ink",
  alink: "ink",
};

const TAG = /<[a-z][a-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/gi;
const ATTRIBUTE = /(\s)([^\s"'>/=]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * Sanitized markup for the dark theme, as text (ADR 0085): the colors of `<style>` sheets,
 * `style` attributes and old color attributes, landing on `ground` (the theme's, ADR 0134,
 * rule 10). Text of the message is not touched, and neither are images.
 */
export function darkenMail(html: string, ground?: MailGround): string {
  const g = groundLch(ground);
  return html
    .split(/(<style\b[^>]*>[\s\S]*?<\/style\s*>)/i)
    .map((part, i) => {
      if (i % 2 === 1) {
        const open = part.indexOf(">") + 1;
        const close = part.lastIndexOf("</");
        return part.slice(0, open) + darkenCss(part.slice(open, close), g) + part.slice(close);
      }
      return part.replace(TAG, (tag) =>
        tag.replace(
          ATTRIBUTE,
          (
            whole,
            space: string,
            name: string,
            eq: string,
            dq?: string,
            sq?: string,
            bare?: string,
          ) => {
            const n = name.toLowerCase();
            const value = dq ?? sq ?? bare ?? "";
            let next: string;
            if (n === "style") next = darkenCss(value, g);
            else {
              const role = ATTRIBUTE_ROLES[n];
              if (role === undefined) return whole;
              next = recolorValue(value, role, g);
            }
            if (next === value) return whole;
            const quote = sq !== undefined ? "'" : '"';
            return `${space}${name}${eq}${quote}${next}${quote}`;
          },
        ),
      );
    })
    .join("");
}
