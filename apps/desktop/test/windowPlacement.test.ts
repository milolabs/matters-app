import { describe, expect, it } from "vitest";
import { DEFAULT_PLACEMENT, restorePlacement } from "../src/main/windowPlacement.ts";

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const monitor = { x: 1512, y: 0, width: 2560, height: 1440 };
const saved = (x: number, y: number, width: number, height: number, maximized = false) => ({
  bounds: { x, y, width, height },
  maximized,
});

describe("restorePlacement", () => {
  it("opens where the window was left, on any screen", () => {
    expect(restorePlacement(saved(100, 80, 1000, 700), [laptop])).toEqual({
      bounds: { x: 100, y: 80, width: 1000, height: 700 },
      maximized: false,
    });
    expect(restorePlacement(saved(1700, 40, 1800, 1000, true), [laptop, monitor])).toEqual({
      bounds: { x: 1700, y: 40, width: 1800, height: 1000 },
      maximized: true,
    });
  });

  it("forgets the position on a screen that is gone, and fits the size to what is left", () => {
    expect(restorePlacement(saved(1700, 40, 1800, 1000), [laptop])).toEqual({
      bounds: { width: 1512, height: 920 },
      maximized: false,
    });
  });

  it("does not trust a window that only just touches a screen", () => {
    expect(restorePlacement(saved(1450, 80, 1000, 700), [laptop]).bounds.x).toBeUndefined();
    expect(restorePlacement(saved(100, 900, 1000, 700), [laptop]).bounds.x).toBeUndefined();
    expect(restorePlacement(saved(100, 0, 1000, 700), [laptop]).bounds.x).toBeUndefined();
  });

  it("never opens below the window's minimum", () => {
    const { bounds } = restorePlacement(saved(100, 80, 200, 100), [laptop]);
    expect(bounds).toMatchObject({ width: 720, height: 420 });
  });

  it("uses the default for anything it cannot read", () => {
    for (const junk of [
      undefined,
      null,
      "x",
      {},
      { bounds: {} },
      { bounds: { x: 1, y: 2, width: "3", height: 4 } },
      saved(Number.NaN, 0, 800, 600),
    ]) {
      expect(restorePlacement(junk, [laptop])).toBe(DEFAULT_PLACEMENT);
    }
  });
});
