// What main keeps of the appearance (ADR 0134, rule 8): `appearance.json` in the data folder, the
// person's themes in `themes/` beside it, and the state that follows from them. Pure, so it can be
// tested without Electron: main reads the files, hands the text here, and applies and writes what
// comes back.
import {
  type AppearanceInfo,
  type AppearanceMode,
  MAX_THEMES,
  type ThemeAddAnswer,
  type ThemeColors,
  type ThemeListing,
  type ThemeProblem,
  type ThemeScheme,
  type ThemeSets,
  type ThemeSwatch,
  type ThemeToken,
} from "@matters/contracts";
import type { BuiltInTheme } from "./builtInThemes.ts";
import {
  DEFAULT_COLORS,
  parseTheme,
  THEME_NAME_LIMIT,
  THEME_SCHEMES,
  THEME_TOKENS,
  type Theme,
  themeSchemes,
  themeSwatches,
} from "./themes.ts";

/** The file's name in the data folder. */
export const APPEARANCE_FILE = "appearance.json";
/** The folder of the person's own themes, beside it (ADR 0134, rule 8). */
export const THEMES_FOLDER = "themes";

export const APPEARANCE_MODES: readonly AppearanceMode[] = ["system", "light", "dark"];

/** What `appearance.json` holds: the mode and the chosen theme, null for the default. */
export interface StoredAppearance {
  readonly mode: AppearanceMode;
  readonly theme: string | null;
}

/** The default (ADR 0134, rule 3): the app follows the system, in the colours of the CSS. */
export const DEFAULT_APPEARANCE: StoredAppearance = { mode: "system", theme: null };

/**
 * A theme's id. Main makes every id: a built-in's is a word in the source, an own theme's is
 * `own-` and twelve random hex digits, which is also its file's name. Nothing the page or a file
 * says becomes a path without matching this.
 */
const THEME_ID = /^(?:own-[0-9a-f]{12}|(?!own-)[a-z][a-z0-9-]{0,31})$/;
const OWN_THEME_ID = /^own-[0-9a-f]{12}$/;

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return typeof value === "string" && (APPEARANCE_MODES as readonly string[]).includes(value);
}

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && THEME_ID.test(value);
}

export function isOwnThemeId(value: unknown): value is string {
  return typeof value === "string" && OWN_THEME_ID.test(value);
}

/** An own theme's id from twelve random hex digits that main drew. */
export function ownThemeId(randomHex: string): string {
  const id = `own-${randomHex.toLowerCase()}`;
  if (!isOwnThemeId(id)) throw new Error("an own theme's id needs twelve hex digits");
  return id;
}

/** An own theme's file name in `themes/`, or null for anything that is not an own id. */
export function ownThemeFile(id: string): string | null {
  return isOwnThemeId(id) ? `${id}.json` : null;
}

/** The id of a file in `themes/`, or null for a file that is not one main wrote. */
export function ownThemeIdOfFile(file: string): string | null {
  const id = file.endsWith(".json") ? file.slice(0, -5) : "";
  return isOwnThemeId(id) ? id : null;
}

/**
 * The file's text as main reads it, or null when there is none. A mode that is not one of the
 * three reads as System and a theme that is not an id reads as none, so a damaged file can never
 * leave the app in a state the person did not choose (ADR 0134, rule 11). Keys it does not know
 * are passed over.
 */
export function parseAppearance(text: string | null): StoredAppearance {
  if (text === null) return DEFAULT_APPEARANCE;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return DEFAULT_APPEARANCE;
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    return DEFAULT_APPEARANCE;
  }
  const { mode, theme } = saved as { mode?: unknown; theme?: unknown };
  return {
    mode: isAppearanceMode(mode) ? mode : "system",
    theme: isThemeId(theme) ? theme : null,
  };
}

/** The file's text: only what this version knows; no theme key at the default theme. */
export function serializeAppearance(stored: StoredAppearance): string {
  return JSON.stringify(
    stored.theme === null ? { mode: stored.mode } : { mode: stored.mode, theme: stored.theme },
  );
}

/** A theme that passed the check, with where it came from. */
export interface LoadedTheme {
  readonly id: string;
  readonly source: "built-in" | "own";
  readonly theme: Theme;
}

/** What reading one theme found: its text, no file, or a file that could not be read. */
export type ThemeRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

/** A built-in theme, checked like a file (ADR 0134, rule 12); null when the id is not one. */
export function builtInTheme(builtIns: readonly BuiltInTheme[], id: string): LoadedTheme | null {
  const found = builtIns.find((t) => t.id === id);
  if (!found) return null;
  const result = parseTheme(JSON.stringify(found.file));
  return result.ok ? { id, source: "built-in", theme: result.theme } : null;
}

/** The chosen theme, or the default and the reason the person is told (ADR 0134, rule 11). */
export interface ChosenTheme {
  readonly theme: LoadedTheme | null;
  readonly fallback: string | null;
}

const STARTED = "Matters started in the default.";

/**
 * The chosen theme as main applies it at start. One that is missing, refused or unreadable is
 * not applied: the default is on, and `fallback` says why in words Appearance shows.
 */
export function resolveChosenTheme(
  id: string | null,
  builtIns: readonly BuiltInTheme[],
  readOwn: (file: string) => ThemeRead,
): ChosenTheme {
  if (id === null) return { theme: null, fallback: null };
  if (!isOwnThemeId(id)) {
    const builtIn = builtInTheme(builtIns, id);
    return builtIn
      ? { theme: builtIn, fallback: null }
      : { theme: null, fallback: `The theme you chose is not in this version. ${STARTED}` };
  }
  const read = readOwn(ownThemeFile(id) ?? "");
  if (read.kind === "missing") {
    return { theme: null, fallback: `The theme you chose is no longer there. ${STARTED}` };
  }
  if (read.kind === "unreadable") {
    return { theme: null, fallback: `The theme you chose could not be read. ${STARTED}` };
  }
  const result = parseTheme(read.text);
  if (result.ok) return { theme: { id, source: "own", theme: result.theme }, fallback: null };
  const first = result.problems[0]?.message ?? "";
  return {
    theme: null,
    fallback: `The theme you chose was refused: ${first} ${STARTED}`,
  };
}

const byName = (a: LoadedTheme, b: LoadedTheme) =>
  a.theme.name.localeCompare(b.theme.name, "en", { sensitivity: "base" }) ||
  a.id.localeCompare(b.id);

/**
 * The person's themes from the files in `themes/`; files that fail the check are not listed. At
 * most `room` are, the first by name and id, so a folder that holds more than the list may carry
 * still opens, the same ones each time, and the person can remove some (`MAX_THEMES`).
 */
export function ownThemes(
  files: readonly string[],
  readOwn: (file: string) => ThemeRead,
  room = Number.POSITIVE_INFINITY,
): LoadedTheme[] {
  const out: LoadedTheme[] = [];
  for (const file of files) {
    const id = ownThemeIdOfFile(file);
    if (id === null) continue;
    const read = readOwn(file);
    if (read.kind !== "text") continue;
    const result = parseTheme(read.text);
    if (result.ok) out.push({ id, source: "own", theme: result.theme });
  }
  return out.sort(byName).slice(0, Math.max(0, room));
}

/** The list with a theme just saved in it, once, in the list's order. */
export function withOwnTheme(list: readonly LoadedTheme[], added: LoadedTheme): LoadedTheme[] {
  return [...list.filter((t) => t.id !== added.id), added].sort(byName);
}

/** How many own themes the list has room for beside the built-ins (`MAX_THEMES`). */
export function ownThemeRoom(builtIns: number): number {
  return Math.max(0, MAX_THEMES - builtIns);
}

/** A theme with one set fixes the scheme while it is on (ADR 0134, rule 7); both leave it free. */
export function fixedSchemeOf(theme: LoadedTheme | null): ThemeScheme | null {
  if (theme === null) return null;
  const schemes = themeSchemes(theme.theme.sets);
  return schemes.length === 1 ? (schemes[0] ?? null) : null;
}

/** What `nativeTheme.themeSource` is set to: the fixed scheme, else the person's mode. */
export function themeSourceFor(mode: AppearanceMode, theme: LoadedTheme | null): AppearanceMode {
  return fixedSchemeOf(theme) ?? mode;
}

/** A window's own colour before its page paints (ADR 0134, rule 9): the theme's `bg`. */
export function windowGround(theme: LoadedTheme | null, dark: boolean): string {
  const scheme: ThemeScheme = dark ? "dark" : "light";
  const own = theme?.theme.sets[scheme]?.bg;
  // The window's colour is opaque: `bg` is checked, so it never carries alpha.
  return own ?? DEFAULT_COLORS[scheme].bg;
}

/** The checked values a window puts on its root element; null at the default. */
export function windowColors(theme: LoadedTheme | null): ThemeSets | null {
  return theme === null ? null : theme.theme.sets;
}

export function themeListing(loaded: LoadedTheme): ThemeListing {
  return {
    id: loaded.id,
    name: loaded.theme.name,
    source: loaded.source,
    schemes: themeSchemes(loaded.theme.sets),
    swatches: themeSwatches(loaded.theme.sets),
  };
}

/** Everything Appearance shows, from main's state. */
export function appearanceInfo(
  stored: StoredAppearance,
  applied: LoadedTheme | null,
  fallback: string | null,
  themes: readonly LoadedTheme[],
): AppearanceInfo {
  return {
    mode: stored.mode,
    fixedScheme: fixedSchemeOf(applied),
    theme: applied?.id ?? null,
    themeChosen: stored.theme !== null,
    themes: themes.map(themeListing),
    fallback,
  };
}

/** *Use default* and *Reset Appearance* have something to undo (ADR 0134, rule 11). */
export function differsFromDefault(stored: StoredAppearance): boolean {
  return stored.mode !== "system" || stored.theme !== null;
}

/**
 * The keys of the way back (ADR 0134, rule 11), in every window and on every platform: Cmd or Ctrl
 * with Option/Alt and Shift and 0. Cmd+0 is Actual Size, so 0 reads as "back to how it was"; with
 * Alt and Shift added it is taken by nothing in the app, the View menu or the systems it runs on.
 * The key is read by its place (`Digit0`), so a layout that puts 0 under Shift still has it.
 */
export const RESET_APPEARANCE_ACCELERATOR = "CmdOrCtrl+Alt+Shift+0";

/** What main reads of a key press (`Electron.Input`). */
export interface KeyInput {
  readonly type: string;
  readonly code: string;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly control: boolean;
}

export function isResetAppearanceChord(input: KeyInput, platform: string): boolean {
  const mod = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  return input.type === "keyDown" && input.code === "Digit0" && input.alt && input.shift && mod;
}

// ---- What crosses to a page ----------------------------------------------------------------
// The preload reads main's answers through these before a page sees them, as every bridge does:
// a page gets only the shapes below, rebuilt, never more than main meant to send.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;
const isScheme = (v: unknown): v is ThemeScheme => v === "light" || v === "dark";
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Checked colours for one set: known tokens and normalised hex only. */
function readColors(v: unknown): ThemeColors | null {
  if (!isRecord(v)) return null;
  const out: Partial<Record<ThemeToken, string>> = {};
  for (const token of THEME_TOKENS) {
    const value = v[token];
    if (value === undefined) continue;
    if (typeof value !== "string" || !HEX.test(value)) return null;
    out[token] = value;
  }
  return out;
}

/** A theme's sets as a window applies them; null for the default or anything malformed. */
export function readThemeSets(v: unknown): ThemeSets | null {
  if (!isRecord(v)) return null;
  const out: { light?: ThemeColors; dark?: ThemeColors } = {};
  for (const scheme of THEME_SCHEMES) {
    if (v[scheme] === undefined) continue;
    const colors = readColors(v[scheme]);
    if (colors === null) return null;
    out[scheme] = colors;
  }
  return out.light || out.dark ? out : null;
}

function readSwatch(v: unknown): ThemeSwatch | null {
  if (!isRecord(v)) return null;
  const { ground, ink, accent } = v;
  if (![ground, ink, accent].every((c) => typeof c === "string" && HEX.test(c))) return null;
  return { ground: ground as string, ink: ink as string, accent: accent as string };
}

function readListing(v: unknown): ThemeListing | null {
  if (!isRecord(v) || !isThemeId(v.id) || !isText(v.name, THEME_NAME_LIMIT)) return null;
  if (v.source !== "built-in" && v.source !== "own") return null;
  if (!Array.isArray(v.schemes) || !Array.isArray(v.swatches)) return null;
  const schemes = v.schemes.filter(isScheme);
  const swatches = v.swatches.map(readSwatch);
  if (schemes.length !== v.schemes.length || schemes.length === 0) return null;
  if (swatches.length !== schemes.length || swatches.some((s) => s === null)) return null;
  return {
    id: v.id,
    name: v.name,
    source: v.source,
    schemes,
    swatches: swatches as ThemeSwatch[],
  };
}

/** The appearance as a page may see it, or null when main's answer is not one. */
export function readAppearanceInfo(v: unknown): AppearanceInfo | null {
  if (!isRecord(v) || !isAppearanceMode(v.mode)) return null;
  const fixedScheme =
    v.fixedScheme === null ? null : isScheme(v.fixedScheme) ? v.fixedScheme : undefined;
  const theme = v.theme === null ? null : isThemeId(v.theme) ? v.theme : undefined;
  const fallback = v.fallback === null ? null : isText(v.fallback, 1000) ? v.fallback : undefined;
  if (fixedScheme === undefined || theme === undefined || fallback === undefined) return null;
  if (
    typeof v.themeChosen !== "boolean" ||
    !Array.isArray(v.themes) ||
    v.themes.length > MAX_THEMES
  ) {
    return null;
  }
  const themes = v.themes.map(readListing);
  if (themes.some((t) => t === null)) return null;
  return {
    mode: v.mode,
    fixedScheme,
    theme,
    themeChosen: v.themeChosen,
    themes: themes as ThemeListing[],
    fallback,
  };
}

const FORMAT_REASONS: readonly string[] = [
  "too-big",
  "not-json",
  "not-object",
  "name",
  "no-set",
  "unknown-key",
  "not-hex",
  "alpha",
];
const isToken = (v: unknown): v is ThemeToken =>
  typeof v === "string" && (THEME_TOKENS as readonly string[]).includes(v);

function readProblem(v: unknown): ThemeProblem | null {
  if (!isRecord(v) || !isText(v.message, 1000)) return null;
  if (v.kind === "contrast") {
    const { mode, ink, surface, ratio, needed } = v;
    if (!isScheme(mode) || !isToken(ink) || !isToken(surface)) return null;
    if (typeof ratio !== "number" || typeof needed !== "number") return null;
    return { kind: "contrast", mode, ink, surface, ratio, needed, message: v.message };
  }
  if (v.kind !== "format" || typeof v.reason !== "string" || !FORMAT_REASONS.includes(v.reason)) {
    return null;
  }
  const reason = v.reason as Extract<ThemeProblem, { kind: "format" }>["reason"];
  return isText(v.at, 200)
    ? { kind: "format", reason, at: v.at, message: v.message }
    : { kind: "format", reason, message: v.message };
}

/** The answer to a theme handed in as text, as a page may see it. */
export function readThemeAddAnswer(v: unknown): ThemeAddAnswer | null {
  if (!isRecord(v)) return null;
  if (v.ok === true) {
    const theme = readListing(v.theme);
    const appearance = readAppearanceInfo(v.appearance);
    return theme && appearance ? { ok: true, theme, appearance } : null;
  }
  if (v.ok === false && isText(v.full, 1000) && v.full !== "") return { ok: false, full: v.full };
  if (v.ok !== false || !Array.isArray(v.problems) || v.problems.length > 200) return null;
  const problems = v.problems.map(readProblem);
  if (problems.length === 0 || problems.some((p) => p === null)) return null;
  return { ok: false, problems: problems as ThemeProblem[] };
}
