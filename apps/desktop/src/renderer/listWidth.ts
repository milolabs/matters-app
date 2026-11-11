/**
 * How wide the message list is (ADR 0038). The reader chooses a width and the reading pane takes
 * the rest. In a window too narrow for that choice the list gives way, and the choice stays, so
 * the list comes back when the window does. A preference of this computer only.
 */

import { PANE_DEFAULT } from "./paneWidth.ts";

export const LIST_MIN = 280;
export const LIST_DEFAULT = 380;
export const LIST_MAX = 560;
/** With the default list this is the window's 720 px minimum, so the two always fit. */
const READER_MIN = 340;
/** A drag this close to the default lands on it, which makes the way back easy to find. */
const SNAP = 6;
const KEY_STEP = 8;
const KEY_STEP_LARGE = 40;

const KEY = "matters.listWidth";

/** The widest the list can be in a window this wide. */
export function listMax(windowWidth: number): number {
  return Math.max(LIST_MIN, Math.min(LIST_MAX, windowWidth - READER_MIN));
}

/** The width the list actually has: the one wanted, as far as the window allows. */
export function fitListWidth(wanted: number, windowWidth: number): number {
  return Math.max(LIST_MIN, Math.min(listMax(windowWidth), Math.round(wanted)));
}

/** The room the reading column keeps beside the agent's column. */
const TALK_READER_ROOM = 520;
/** How far the list narrows for the agent's column. */
const TALK_LIST_MIN = 300;

/**
 * The width the list has while the agent's column is shown: the chosen width, as far as the
 * window leaves room for a column of `paneWidth` and the reading column, and never under 300
 * (ADR 0064, rule 14; ADR 0069). The chosen width itself is not changed by this, so it comes back
 * when the column is hidden or narrower.
 */
export function listBesidePane(
  wanted: number,
  windowWidth: number,
  paneWidth: number = PANE_DEFAULT,
): number {
  const room = Math.max(TALK_LIST_MIN, windowWidth - paneWidth - TALK_READER_ROOM);
  return fitListWidth(Math.min(wanted, room), windowWidth);
}

/** Where a drag that has reached `raw` puts the list. */
export function draggedListWidth(raw: number, windowWidth: number): number {
  const near = Math.abs(raw - LIST_DEFAULT) <= SNAP;
  return fitListWidth(near ? LIST_DEFAULT : raw, windowWidth);
}

/** What a key does to a list of width `current`, or null when the key means nothing here. */
export function keyedListWidth(
  key: string,
  large: boolean,
  current: number,
  windowWidth: number,
): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return fitListWidth(current - step, windowWidth);
    case "ArrowRight":
      return fitListWidth(current + step, windowWidth);
    case "Home":
      return LIST_MIN;
    case "End":
      return listMax(windowWidth);
    case "Enter":
      return LIST_DEFAULT;
    default:
      return null;
  }
}

/** Anything but a whole width in range means the default. */
export function parseListWidth(stored: string | null): number {
  const width = Number(stored);
  return Number.isInteger(width) && width >= LIST_MIN && width <= LIST_MAX ? width : LIST_DEFAULT;
}

export function readListWidth(): number {
  try {
    return parseListWidth(localStorage.getItem(KEY));
  } catch {
    return LIST_DEFAULT;
  }
}

export function writeListWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // Storage absent or refused: the width lasts as long as this window is open.
  }
}
