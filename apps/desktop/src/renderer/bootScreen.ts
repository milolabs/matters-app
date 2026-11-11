import { mark } from "./trace.ts";

/**
 * The loading screen's way out (ADR 0103, rule 3). In a normal start nobody sees it: the window opens
 * with the mail, and the screen goes in the frame the mail arrives. Once it has been seen it stays a
 * moment and leaves with a short cross-fade, so that it never flashes.
 */

/** A loading screen that was seen stays up at least this long. */
export const LOADER_MIN_MS = 300;
/** Its cross-fade into the mail; opacity only, and none for reduced motion. */
export const LOADER_FADE_MS = 140;
/**
 * A seen screen whose first screen never says so leaves this long after the mail is loaded anyway:
 * the mail is there, and an open thread or the starter view comes in its own time.
 */
const LOADED_FALLBACK_MS = 2000;

export interface BootExit {
  /** How long to wait before the screen starts to leave. */
  readonly waitMs: number;
  /** How long its fade takes; 0 removes it at once. */
  readonly fadeMs: number;
}

/**
 * How the loading screen leaves. `shownAtMs` is when the window appeared with it, on the page's
 * clock, or null when it never did: then it goes at once, in the same frame as the mail.
 */
export function bootExit(
  shownAtMs: number | null,
  nowMs: number,
  reducedMotion: boolean,
): BootExit {
  if (shownAtMs === null) return { waitMs: 0, fadeMs: 0 };
  return {
    waitMs: Math.max(0, shownAtMs + LOADER_MIN_MS - nowMs),
    fadeMs: reducedMotion ? 0 : LOADER_FADE_MS,
  };
}

/** The benchmark's page that never says it is ready keeps its loading screen too (dev builds only). */
const held =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("neverReady") === "1";

let leaving = false;
let fallback: ReturnType<typeof setTimeout> | undefined;

/**
 * Lets the loading screen go. `loaded`: accounts and list are rendered (app.tsx); `first-screen`: the
 * whole first screen is in a frame (main.tsx). An unseen screen goes on the first of them; a seen one
 * waits for the second, so that what it fades into is complete.
 */
export function releaseBoot(moment: "loaded" | "first-screen"): void {
  const boot = document.getElementById("boot");
  if (!boot || leaving || held) return;
  const shownAt = document.documentElement.dataset.bootShown;
  const shownAtMs = shownAt === undefined ? null : Number(shownAt);
  if (shownAtMs === null) {
    boot.remove();
    return;
  }
  if (moment === "loaded") {
    fallback ??= setTimeout(() => releaseBoot("first-screen"), LOADED_FALLBACK_MS);
    return;
  }
  leaving = true;
  clearTimeout(fallback);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const exit = bootExit(shownAtMs, performance.now(), reduced);
  setTimeout(() => {
    if (exit.fadeMs === 0) {
      boot.remove();
      mark("boot-hidden");
      return;
    }
    boot.dataset.leaving = "";
    setTimeout(() => {
      boot.remove();
      mark("boot-hidden");
    }, exit.fadeMs);
  }, exit.waitMs);
}
