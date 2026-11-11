/**
 * How wide the agent's column is, and whether it is shown (ADR 0069). The person chooses a width;
 * in a window too narrow for that choice the column gives way, and the choice stays, so the
 * column comes back to it when the window does. A preference of this computer only.
 */

export const PANE_MIN = 300;
export const PANE_DEFAULT = 360;
export const PANE_MAX = 640;
/** The list keeps 300 and the reading column keeps 400 when the person drags the column wider. */
const ROOM_AROUND = 700;
/** A drag this close to the default lands on it, as it does for the list. */
const SNAP = 6;
const KEY_STEP = 8;
const KEY_STEP_LARGE = 40;

const KEY = "matters.ai.paneWidth";

/** Under this window width the column lies over the reader (ADR 0064, rule 14). */
export const OVERLAY_BELOW = 1060;

/** The widest the column can be in a window this wide. It is never narrower than the default. */
export function paneMax(windowWidth: number): number {
  return Math.max(PANE_DEFAULT, Math.min(PANE_MAX, windowWidth - ROOM_AROUND));
}

/** The width the column actually has: the one wanted, as far as the window allows. */
export function fitPaneWidth(wanted: number, windowWidth: number): number {
  return Math.max(PANE_MIN, Math.min(paneMax(windowWidth), Math.round(wanted)));
}

/** Where a drag that has reached `raw` puts the column. */
export function draggedPaneWidth(raw: number, windowWidth: number): number {
  const near = Math.abs(raw - PANE_DEFAULT) <= SNAP;
  return fitPaneWidth(near ? PANE_DEFAULT : raw, windowWidth);
}

/**
 * What a key does to a column of width `current`, or null when the key means nothing here. The
 * column grows to the left, so ArrowLeft widens it and ArrowRight narrows it.
 */
export function keyedPaneWidth(
  key: string,
  large: boolean,
  current: number,
  windowWidth: number,
): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return fitPaneWidth(current + step, windowWidth);
    case "ArrowRight":
      return fitPaneWidth(current - step, windowWidth);
    case "Home":
      return PANE_MIN;
    case "End":
      return paneMax(windowWidth);
    case "Enter":
      return PANE_DEFAULT;
    default:
      return null;
  }
}

/** Anything but a whole width in range means the default. */
export function parsePaneWidth(stored: string | null): number {
  const width = Number(stored);
  return Number.isInteger(width) && width >= PANE_MIN && width <= PANE_MAX ? width : PANE_DEFAULT;
}

export function readPaneWidth(): number {
  try {
    return parsePaneWidth(localStorage.getItem(KEY));
  } catch {
    return PANE_DEFAULT;
  }
}

export function writePaneWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // Storage absent or refused: the width lasts as long as this window is open.
  }
}

/**
 * Whether the column is shown. At or above `OVERLAY_BELOW` it follows the person's stored choice.
 * Under it the column would cover the mail, so it shows only once the person asked for it there.
 */
export function paneShown(preferred: boolean, askedHere: boolean, windowWidth: number): boolean {
  return windowWidth < OVERLAY_BELOW ? askedHere : preferred;
}

/** Whether the stored choice is open: unless the person hid the column. Anything else is open. */
export function parsePaneOpen(stored: string | null): boolean {
  return stored !== "0";
}

const WIDE_KEY = "matters.ai.paneWide";

/** Whether the person left the column widened over the window. A preference of this computer. */
export function parsePaneWide(raw: string | null): boolean {
  return raw === "1";
}

export function readPaneWide(): boolean {
  try {
    return parsePaneWide(localStorage.getItem(WIDE_KEY));
  } catch {
    return false;
  }
}

export function writePaneWide(wide: boolean): void {
  try {
    localStorage.setItem(WIDE_KEY, wide ? "1" : "0");
  } catch {
    // Storage absent or refused: the choice lasts as long as this window is open.
  }
}

/** How much of the list stays beside the widened column: the avatars, a way back to the mail. */
export const WIDE_STRIP = 54;
/** The talk's text stops at this width in the widened column, so lines stay readable. */
export const WIDE_TEXT = 760;
