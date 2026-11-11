import { describe, expect, it } from "vitest";
import {
  draggedPaneWidth,
  fitPaneWidth,
  keyedPaneWidth,
  OVERLAY_BELOW,
  PANE_DEFAULT,
  PANE_MAX,
  PANE_MIN,
  paneMax,
  paneShown,
  parsePaneOpen,
  parsePaneWide,
  parsePaneWidth,
} from "../src/renderer/paneWidth.ts";

describe("paneMax", () => {
  it("leaves the list 300 and the reader 400, within 360 to 640", () => {
    expect(paneMax(1060)).toBe(360);
    expect(paneMax(1000)).toBe(360);
    expect(paneMax(720)).toBe(360);
    expect(paneMax(1200)).toBe(500);
    expect(paneMax(1340)).toBe(640);
    expect(paneMax(3000)).toBe(PANE_MAX);
  });
});

describe("fitPaneWidth", () => {
  it("gives way to a narrow window and comes back with a wide one", () => {
    expect(fitPaneWidth(600, 1060)).toBe(360);
    expect(fitPaneWidth(600, 1200)).toBe(500);
    expect(fitPaneWidth(600, 1400)).toBe(600);
  });

  it("stays in range whatever is asked", () => {
    expect(fitPaneWidth(10, 1400)).toBe(PANE_MIN);
    expect(fitPaneWidth(9000, 3000)).toBe(PANE_MAX);
    expect(fitPaneWidth(PANE_DEFAULT, 720)).toBe(PANE_DEFAULT);
    expect(fitPaneWidth(300.4, 1400)).toBe(300);
  });
});

describe("draggedPaneWidth", () => {
  it("snaps to the default within 6 px", () => {
    expect(draggedPaneWidth(366, 1400)).toBe(PANE_DEFAULT);
    expect(draggedPaneWidth(354, 1400)).toBe(PANE_DEFAULT);
    expect(draggedPaneWidth(367, 1400)).toBe(367);
  });

  it("stays in what the window allows", () => {
    expect(draggedPaneWidth(900, 1200)).toBe(500);
    expect(draggedPaneWidth(100, 1200)).toBe(PANE_MIN);
  });
});

describe("keyedPaneWidth", () => {
  it("widens to the left: ArrowLeft grows the column and ArrowRight narrows it", () => {
    expect(keyedPaneWidth("ArrowLeft", false, 360, 1400)).toBe(368);
    expect(keyedPaneWidth("ArrowLeft", true, 360, 1400)).toBe(400);
    expect(keyedPaneWidth("ArrowRight", false, 360, 1400)).toBe(352);
    expect(keyedPaneWidth("ArrowRight", true, 320, 1400)).toBe(300);
  });

  it("stops at the ends", () => {
    expect(keyedPaneWidth("ArrowLeft", true, 630, 1400)).toBe(640);
    expect(keyedPaneWidth("ArrowRight", false, PANE_MIN, 1400)).toBe(PANE_MIN);
    expect(keyedPaneWidth("ArrowLeft", false, 360, 1060)).toBe(360);
  });

  it("jumps with Home, End and Enter, and ignores other keys", () => {
    expect(keyedPaneWidth("Home", false, 400, 1400)).toBe(PANE_MIN);
    expect(keyedPaneWidth("End", false, 400, 1400)).toBe(640);
    expect(keyedPaneWidth("End", false, 400, 1100)).toBe(400);
    expect(keyedPaneWidth("Enter", false, 500, 1400)).toBe(PANE_DEFAULT);
    expect(keyedPaneWidth("a", false, 500, 1400)).toBeNull();
  });
});

describe("parsePaneWidth", () => {
  it("takes a whole width in range and falls back to the default", () => {
    expect(parsePaneWidth("452")).toBe(452);
    for (const stored of [null, "", "abc", "12.5", "100", "9000", "NaN", "299", "641"]) {
      expect(parsePaneWidth(stored)).toBe(PANE_DEFAULT);
    }
    expect(parsePaneWidth("300")).toBe(300);
    expect(parsePaneWidth("640")).toBe(640);
  });
});

describe("parsePaneOpen", () => {
  it("is open unless the person hid the column", () => {
    expect(parsePaneOpen(null)).toBe(true);
    expect(parsePaneOpen("1")).toBe(true);
    expect(parsePaneOpen("")).toBe(true);
    expect(parsePaneOpen("0")).toBe(false);
  });
});

describe("paneShown (ADR 0069, rule 5)", () => {
  it("follows the kept choice from 1060 px up", () => {
    expect(paneShown(true, false, OVERLAY_BELOW)).toBe(true);
    expect(paneShown(false, true, OVERLAY_BELOW)).toBe(false);
    expect(paneShown(true, false, 1800)).toBe(true);
  });

  it("shows only on request under 1060 px, whatever was kept", () => {
    expect(paneShown(true, false, OVERLAY_BELOW - 1)).toBe(false);
    expect(paneShown(false, true, 720)).toBe(true);
    expect(paneShown(true, true, 720)).toBe(true);
  });
});

describe("parsePaneWide", () => {
  it("is widened only when the person left it so", () => {
    expect(parsePaneWide("1")).toBe(true);
    expect(parsePaneWide("0")).toBe(false);
    expect(parsePaneWide(null)).toBe(false);
    expect(parsePaneWide("yes")).toBe(false);
  });
});
