// Settings › Appearance asks main for the appearance and changes it (ADR 0134, rules 2, 7, 8, 11
// and 12). Like the other bridges it exposes nothing: the page posts a request, the preload checks
// its shape and asks main, which validates again and applies only what it knows. A theme crosses
// as text the page read from a file, never as a path. Main tells every window when the appearance
// changed; the preload puts the checked colours on the page's root element (rule 9) and passes the
// rest on to the page.
import type { ThemeScheme, ThemeSets } from "@matters/contracts";
import { THEME_FILE_LIMIT } from "@matters/contracts";
import {
  isAppearanceMode,
  isThemeId,
  readAppearanceInfo,
  readThemeAddAnswer,
  readThemeSets,
} from "../main/appearance.ts";
import { THEME_TOKENS } from "../main/themes.ts";

export const CHANNEL_APPEARANCE = "matters:appearance";
/** Main to every window: `{ appearance, colors }` in force after a change. */
export const CHANNEL_APPEARANCE_CHANGED = "matters:appearance-changed";
/**
 * The preload to main, synchronously, as the preload starts: the checked colours in force, so they
 * are on the root element before the page's first paint (ADR 0134, rule 9).
 */
export const CHANNEL_APPEARANCE_COLORS = "matters:appearance-colors";

export type AppearanceAction = "get" | "set" | "reset" | "theme" | "add" | "remove" | "text";
const ACTIONS: readonly string[] = [
  "get",
  "set",
  "reset",
  "theme",
  "add",
  "remove",
  "text",
] satisfies AppearanceAction[];

/**
 * Text longer than this does not cross at all. Main refuses anything over the file limit with a
 * reason; this only stops a page from handing main megabytes to measure.
 */
const TEXT_LIMIT = THEME_FILE_LIMIT * 4;

export interface AppearanceBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface AppearanceMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The arguments main is asked with, or null for an ask that is not well formed. */
function argsOf(ask: Record<string, unknown>): unknown[] | null {
  switch (ask.action) {
    case "get":
    case "reset":
      return [ask.action];
    case "set":
      return isAppearanceMode(ask.mode) ? [ask.action, ask.mode] : null;
    case "theme":
      // null is the default theme.
      return ask.id === null || isThemeId(ask.id) ? [ask.action, ask.id] : null;
    case "remove":
    case "text":
      return isThemeId(ask.id) ? [ask.action, ask.id] : null;
    case "add":
      // `on: false` keeps it without putting it on: the person chose another theme meanwhile.
      if (typeof ask.text !== "string" || ask.text.length > TEXT_LIMIT) return null;
      return ask.on === false ? [ask.action, ask.text, false] : [ask.action, ask.text];
    default:
      return null;
  }
}

/** Main's answer to `text`: a theme's text, within what may cross at all, or null. */
function readThemeText(v: unknown): string | null {
  return isRecord(v) && typeof v.text === "string" && v.text.length <= TEXT_LIMIT ? v.text : null;
}

export function createAppearanceBridge(deps: AppearanceBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: AppearanceMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersAppearance;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      const args =
        typeof ask.action === "string" && ACTIONS.includes(ask.action) ? argsOf(ask) : null;
      if (args === null) {
        deps.post({ mattersAppearanceAnswer: { requestId, answer: null } });
        return;
      }
      const read: (v: unknown) => unknown =
        ask.action === "add"
          ? readThemeAddAnswer
          : ask.action === "text"
            ? readThemeText
            : readAppearanceInfo;
      deps
        .invoke(CHANNEL_APPEARANCE, ...args)
        .then(read, () => null)
        .then((answer) => deps.post({ mattersAppearanceAnswer: { requestId, answer } }));
    },
    /**
     * Main's push on `CHANNEL_APPEARANCE_CHANGED`. The colours go on the root element first, so
     * that a page reading its tokens when it hears of the change reads the new ones.
     */
    changed(data: unknown, apply: (colors: ThemeSets | null) => void): void {
      if (!isRecord(data)) return;
      const appearance = readAppearanceInfo(data.appearance);
      if (!appearance) return;
      apply(readThemeSets(data.colors));
      deps.post({ mattersAppearanceChanged: appearance });
    },
  };
}

/** What the preload writes to: the root element's inline style. */
export interface StyleLike {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): string;
}

/**
 * Puts a theme's checked values for the scheme in force on the root element as custom properties
 * (`--bg`, …), or takes them all off at the default (ADR 0134, rule 9). Inline properties on the
 * root win over `styles.css`'s `:root` and its dark block, and what `styles.css` derives from them
 * (`--agent-line`, `--mark-m`, Tailwind's `--color-*`) follows, because those read the variables
 * where they are used. Only known tokens and only hex reach here (`readThemeSets`).
 */
export function applyThemeColors(
  style: StyleLike,
  colors: ThemeSets | null,
  scheme: ThemeScheme,
): void {
  const set = colors?.[scheme];
  for (const token of THEME_TOKENS) {
    const value = set?.[token];
    if (value === undefined) style.removeProperty(`--${token}`);
    else style.setProperty(`--${token}`, value);
  }
}
