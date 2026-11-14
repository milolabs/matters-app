import type { ThemeSwatch } from "@matters/contracts";
import { createMemo, createRoot, createSignal } from "solid-js";
import { DEFAULT_MAIL_GROUND, type MailGround } from "./mailTheme.ts";

/**
 * The default theme's strip in Settings › Appearance: the grounds, inks and accents of
 * `styles.css` (ADR 0134, rule 3). The default is not a theme main lists, so its values are here;
 * `test/themes.test.ts` keeps them in step with the CSS.
 */
export const DEFAULT_SWATCHES: readonly ThemeSwatch[] = [
  { ground: "#ffffff", ink: "#1d1d1f", accent: "#5b45c9" },
  { ground: "#1e1e20", ink: "#f5f5f7", accent: "#b9aef7" },
];

const HEX = /^#[0-9a-f]{6}$/i;

interface Look {
  readonly dark: boolean;
  readonly ground: MailGround;
}

const query =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");

/** The scheme and the ground and ink in force, as the page's own tokens say (ADR 0134, rule 10). */
function readLook(): Look {
  const dark = query?.matches ?? false;
  if (!dark || typeof document === "undefined") return { dark, ground: DEFAULT_MAIL_GROUND };
  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue("--bg").trim().toLowerCase();
  const ink = style.getPropertyValue("--ink").trim().toLowerCase();
  return {
    dark,
    ground: HEX.test(bg) && HEX.test(ink) ? { bg, ink } : DEFAULT_MAIL_GROUND,
  };
}

const [look, setLook] = createSignal<Look>(readLook(), {
  equals: (a, b) =>
    a.dark === b.dark && a.ground.bg === b.ground.bg && a.ground.ink === b.ground.ink,
});
// Read once the change has landed: the preload puts a theme's values on the root element in the
// same turn as its own listener, and a task later both are in.
const refresh = () => setTimeout(() => setLook(readLook()), 0);
query?.addEventListener("change", refresh);
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (event.source === window && typeof data === "object" && data !== null) {
      if ("mattersAppearanceChanged" in data) refresh();
    }
  });
}

const derived = createRoot(() => ({
  dark: createMemo(() => look().dark),
  ground: createMemo(() => look().ground, undefined, {
    equals: (a, b) => a.bg === b.bg && a.ink === b.ink,
  }),
}));

/**
 * The app is in its dark theme, as `styles.css` is: the media query answers the scheme main set
 * (ADR 0134, rules 2 and 7), which is the system's unless the person chose Light or Dark or a
 * theme with one set is on.
 */
export const appDark = derived.dark;

/**
 * The ground and ink under a message in dark (ADR 0134, rule 10): the theme's `bg` and `ink`, or
 * the default's. Changes together with `appDark`, so a message is recolored once per change.
 */
export const mailGround = derived.ground;
