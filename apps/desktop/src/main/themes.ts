// A theme is data (ADR 0134, rules 4 to 6): a name and colours for some tokens, in light, dark or
// both. This module is the only reader of a theme's text and the only judge of whether it may be
// applied. Pure, with no Electron and no DOM: main hands it text from a file, from the page or
// from the agent, and a window only ever gets what it returned as checked. The tables it checks
// against are in `@matters/contracts`, so the format the agent is told is the one checked here.
import type {
  ThemeColors,
  ThemeProblem,
  ThemeScheme,
  ThemeSets,
  ThemeSwatch,
  ThemeToken,
} from "@matters/contracts";
import {
  CONTRAST_NEEDED,
  CONTRAST_PAIRS,
  DEFAULT_THEME_COLORS,
  THEME_FILE_LIMIT,
  THEME_NAME_LIMIT,
  THEME_SCHEMES,
  THEME_TOKEN_LABELS,
  THEME_TOKENS,
} from "@matters/contracts";

export { CONTRAST_NEEDED, CONTRAST_PAIRS, THEME_NAME_LIMIT, THEME_SCHEMES, THEME_TOKENS };

/** The default theme's values (ADR 0134, rule 3), as the check fills a set with them. */
export const DEFAULT_COLORS = DEFAULT_THEME_COLORS;

/**
 * Text the app draws on these surfaces although the default's own values are under 4.5:1 there
 * (a date on a selected row, a pill's key, a hovered button's hint, a late date on a selected row).
 * Checking them would refuse every theme that leaves these tokens out, the default included, so
 * they are left out of the check (`CONTRAST_PAIRS`), and named here rather than dropped without a
 * word. The ratios are the default's, pinned by a test, so a change to the defaults shows up there.
 */
export const SHORT_IN_DEFAULT: readonly {
  readonly mode: ThemeScheme;
  readonly ink: ThemeToken;
  readonly surface: ThemeToken;
}[] = [
  { mode: "light", ink: "secondary", surface: "selected" },
  { mode: "light", ink: "secondary", surface: "button" },
  { mode: "light", ink: "secondary", surface: "pill" },
  { mode: "light", ink: "late", surface: "selected" },
  { mode: "light", ink: "late", surface: "button" },
  { mode: "dark", ink: "secondary", surface: "selected" },
  { mode: "dark", ink: "secondary", surface: "button" },
  { mode: "dark", ink: "secondary", surface: "pill" },
];

/** Tokens the check reads, as ink or surface. Their values must be opaque. */
const CHECKED: ReadonlySet<ThemeToken> = new Set(
  Object.entries(CONTRAST_PAIRS).flatMap(([ink, surfaces]) => [
    ink as ThemeToken,
    ...(surfaces ?? []),
  ]),
);

const LABELS = THEME_TOKEN_LABELS;

export interface Theme {
  readonly name: string;
  readonly sets: ThemeSets;
}

export type ThemeResult =
  | { readonly ok: true; readonly theme: Theme }
  | { readonly ok: false; readonly problems: readonly ThemeProblem[] };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const isToken = (key: string): key is ThemeToken =>
  (THEME_TOKENS as readonly string[]).includes(key);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `#rgb`, `#rrggbb` and `#rrggbbaa` as lower-case `#rrggbb`, with `aa` only when not opaque. */
export function normaliseHex(value: string): string {
  const h = value.slice(1).toLowerCase();
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return full.length === 8 && full.endsWith("ff") ? `#${full.slice(0, 6)}` : `#${full}`;
}

function format(
  reason: Extract<ThemeProblem, { kind: "format" }>["reason"],
  message: string,
  at?: string,
): ThemeProblem {
  return at === undefined
    ? { kind: "format", reason, message }
    : { kind: "format", reason, at, message };
}

/** WCAG 2.1 relative luminance of an opaque `#rrggbb`. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2.1 contrast ratio of two opaque colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** A set with the default's values for every token it leaves out (ADR 0134, rule 5). */
export function filledSet(
  mode: ThemeScheme,
  colors: ThemeColors | undefined,
): Record<ThemeToken, string> {
  return { ...DEFAULT_COLORS[mode], ...colors };
}

/** Every pair of the table under 4.5:1 in this set, filled with the default. */
export function contrastProblems(
  mode: ThemeScheme,
  colors: ThemeColors | undefined,
): ThemeProblem[] {
  const full = filledSet(mode, colors);
  const out: ThemeProblem[] = [];
  for (const [ink, surfaces] of Object.entries(CONTRAST_PAIRS) as [ThemeToken, ThemeToken[]][]) {
    for (const surface of surfaces) {
      const exact = contrastRatio(full[ink], full[surface]);
      if (exact >= CONTRAST_NEEDED) continue;
      // Rounded down, so the message never shows a failing pair as 4.50.
      const ratio = Math.floor(exact * 100) / 100;
      // Which way to move: away from the surface, darker ink on a light one, lighter on a dark one.
      const lightSurface = luminance(full[surface]) > 0.18;
      out.push({
        kind: "contrast",
        mode,
        ink,
        surface,
        ratio,
        needed: CONTRAST_NEEDED,
        message:
          `In ${mode}, ${LABELS[ink]} on ${LABELS[surface]} is ${ratio.toFixed(2)}:1; it needs ` +
          `${CONTRAST_NEEDED}:1. Make ${ink} ${lightSurface ? "darker" : "lighter"}, or ${surface} ` +
          `${lightSurface ? "lighter" : "darker"}.`,
      });
    }
  }
  return out;
}

/** One set as written: only known tokens, each a hex colour, opaque where the check reads it. */
function readSet(mode: ThemeScheme, raw: unknown, problems: ThemeProblem[]): ThemeColors {
  if (!isRecord(raw)) {
    problems.push(
      format("not-object", `"${mode}" has to be a set of colours, like {"bg": "#ffffff"}.`, mode),
    );
    return {};
  }
  const out: Partial<Record<ThemeToken, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const at = `${mode}.${key}`;
    if (!isToken(key)) {
      problems.push(
        format(
          "unknown-key",
          `"${key}" in ${mode} is not a colour a theme can set. It can set ${THEME_TOKENS.join(", ")}.`,
          at,
        ),
      );
      continue;
    }
    if (typeof value !== "string" || !HEX.test(value)) {
      problems.push(
        format(
          "not-hex",
          `${at} has to be a hex colour (#rgb, #rrggbb or #rrggbbaa), not ${JSON.stringify(value)?.slice(0, 40) ?? String(value)}.`,
          at,
        ),
      );
      continue;
    }
    const hex = normaliseHex(value);
    // The check compares opaque colours; a see-through ground or ink would be judged on a colour
    // that is not the one on screen. Lines may be see-through: nothing is read on them.
    if (hex.length === 9 && CHECKED.has(key)) {
      problems.push(
        format(
          "alpha",
          `${at} has to be opaque: text is drawn on it or with it. Leave out the last two digits.`,
          at,
        ),
      );
      continue;
    }
    out[key] = hex;
  }
  return out;
}

/**
 * Reads and checks a theme's text (ADR 0134, rules 4 and 6). Either the theme, with only known
 * tokens in normalised hex, or every problem found: the format first; contrast only once the
 * format is right, so the person is not told about a ratio of a colour that was refused anyway.
 */
export function parseTheme(text: string): ThemeResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > THEME_FILE_LIMIT) {
    return {
      ok: false,
      problems: [
        format(
          "too-big",
          `The theme is ${Math.ceil(bytes / 1024)} KB; it can be at most ${THEME_FILE_LIMIT / 1024} KB.`,
        ),
      ],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problems: [
        format(
          "not-json",
          "The theme is not JSON. A theme is a JSON object with a name and colours.",
        ),
      ],
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      problems: [
        format(
          "not-object",
          'A theme is a JSON object, like {"name": "Paper", "light": {"bg": "#fbf9f4"}}.',
        ),
      ],
    };
  }
  const problems: ThemeProblem[] = [];
  for (const key of Object.keys(raw)) {
    if (key !== "name" && key !== "light" && key !== "dark") {
      problems.push(
        format(
          "unknown-key",
          `"${key}" is not part of a theme. A theme has "name", "light" and "dark".`,
          key,
        ),
      );
    }
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (name === "" || name.length > THEME_NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) {
    problems.push(
      format(
        "name",
        `A theme needs a name of 1 to ${THEME_NAME_LIMIT} characters on one line.`,
        "name",
      ),
    );
  }
  const sets: { light?: ThemeColors; dark?: ThemeColors } = {};
  for (const mode of THEME_SCHEMES) {
    if (raw[mode] !== undefined) sets[mode] = readSet(mode, raw[mode], problems);
  }
  if (sets.light === undefined && sets.dark === undefined) {
    problems.push(format("no-set", 'A theme needs colours for "light", "dark" or both.'));
  }
  if (problems.length > 0) return { ok: false, problems };
  for (const mode of THEME_SCHEMES) {
    if (sets[mode] !== undefined) problems.push(...contrastProblems(mode, sets[mode]));
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, theme: { name, sets } };
}

/** The schemes a theme has, light first. */
export function themeSchemes(sets: ThemeSets): ThemeScheme[] {
  return THEME_SCHEMES.filter((mode) => sets[mode] !== undefined);
}

/** The strip a row of Appearance shows for each set: ground, ink and accent, filled. */
export function themeSwatches(sets: ThemeSets): ThemeSwatch[] {
  return themeSchemes(sets).map((mode) => {
    const full = filledSet(mode, sets[mode]);
    return { ground: full.bg, ink: full.ink, accent: full.agent };
  });
}

/** A theme as a file: what `parseTheme` reads back to the same theme. */
export function serializeTheme(theme: Theme): string {
  return `${JSON.stringify({ name: theme.name, ...theme.sets }, null, 2)}\n`;
}
