/**
 * Where the mail window opens (ADR 0038): where it was left, as long as that can still be reached.
 * A screen may be gone since then, or smaller, and the window must not open out of sight.
 */

export const WINDOW_MIN_WIDTH = 720;
export const WINDOW_MIN_HEIGHT = 420;
const WINDOW_DEFAULT_WIDTH = 1200;
const WINDOW_DEFAULT_HEIGHT = 760;
/** How much of the window's top must lie on a screen for it to be grabbed: about the toolbar. */
const REACHABLE_WIDTH = 100;
const REACHABLE_HEIGHT = 52;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowPlacement {
  readonly bounds: {
    readonly width: number;
    readonly height: number;
    readonly x?: number;
    readonly y?: number;
  };
  readonly maximized: boolean;
}

export const DEFAULT_PLACEMENT: WindowPlacement = {
  bounds: { width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT },
  maximized: false,
};

function asRect(value: unknown): Rect | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return { x, y, width, height } as Rect;
}

function reachableOn(window: Rect, screen: Rect): boolean {
  const overlap =
    Math.min(window.x + window.width, screen.x + screen.width) - Math.max(window.x, screen.x);
  return (
    overlap >= REACHABLE_WIDTH &&
    window.y >= screen.y &&
    window.y + REACHABLE_HEIGHT <= screen.y + screen.height
  );
}

const fitted = (size: number, room: number, min: number) => Math.max(min, Math.min(size, room));

/** What to open with, given what was saved (anything at all) and the screens' work areas. */
export function restorePlacement(saved: unknown, screens: readonly Rect[]): WindowPlacement {
  if (typeof saved !== "object" || saved === null) return DEFAULT_PLACEMENT;
  const { bounds, maximized } = saved as Record<string, unknown>;
  const rect = asRect(bounds);
  if (!rect) return DEFAULT_PLACEMENT;

  const screen = screens.find((s) => reachableOn(rect, s));
  const room = screen ?? screens[0];
  const width = fitted(rect.width, room?.width ?? rect.width, WINDOW_MIN_WIDTH);
  const height = fitted(rect.height, room?.height ?? rect.height, WINDOW_MIN_HEIGHT);
  return {
    // Out of reach it keeps its size and the system places it.
    bounds: screen ? { width, height, x: rect.x, y: rect.y } : { width, height },
    maximized: maximized === true,
  };
}
