import { describe, expect, it } from "vitest";
import {
  draggedListWidth,
  fitListWidth,
  keyedListWidth,
  LIST_DEFAULT,
  LIST_MAX,
  LIST_MIN,
  listBesidePane,
  listMax,
  parseListWidth,
} from "../src/renderer/listWidth.ts";

describe("fitListWidth", () => {
  it("gives way to a narrow window and comes back with a wide one", () => {
    expect(fitListWidth(520, 720)).toBe(380);
    expect(fitListWidth(520, 860)).toBe(520);
    expect(fitListWidth(520, 1600)).toBe(520);
  });

  it("keeps the default width at the window's smallest size", () => {
    expect(listMax(720)).toBe(LIST_DEFAULT);
    expect(fitListWidth(LIST_DEFAULT, 720)).toBe(LIST_DEFAULT);
  });

  it("stays in range whatever is asked", () => {
    expect(fitListWidth(10, 1200)).toBe(LIST_MIN);
    expect(fitListWidth(9000, 3000)).toBe(LIST_MAX);
    expect(fitListWidth(400, 100)).toBe(LIST_MIN);
  });
});

describe("draggedListWidth", () => {
  it("lands on the default when close to it, and follows the pointer otherwise", () => {
    expect(draggedListWidth(LIST_DEFAULT + 6, 1200)).toBe(LIST_DEFAULT);
    expect(draggedListWidth(LIST_DEFAULT - 6, 1200)).toBe(LIST_DEFAULT);
    expect(draggedListWidth(LIST_DEFAULT + 7, 1200)).toBe(LIST_DEFAULT + 7);
    expect(draggedListWidth(412.4, 1200)).toBe(412);
  });

  it("stops at the ends", () => {
    expect(draggedListWidth(100, 1200)).toBe(LIST_MIN);
    expect(draggedListWidth(900, 1200)).toBe(LIST_MAX);
    expect(draggedListWidth(900, 800)).toBe(460);
  });
});

describe("keyedListWidth", () => {
  it("steps with the arrows, further with shift, and stops at the ends", () => {
    expect(keyedListWidth("ArrowRight", false, 400, 1200)).toBe(408);
    expect(keyedListWidth("ArrowLeft", true, 400, 1200)).toBe(360);
    expect(keyedListWidth("ArrowLeft", false, LIST_MIN, 1200)).toBe(LIST_MIN);
    expect(keyedListWidth("ArrowRight", false, 380, 720)).toBe(380);
  });

  it("goes to the ends and back to the default", () => {
    expect(keyedListWidth("Home", false, 400, 1200)).toBe(LIST_MIN);
    expect(keyedListWidth("End", false, 400, 1200)).toBe(LIST_MAX);
    expect(keyedListWidth("End", false, 400, 800)).toBe(460);
    expect(keyedListWidth("Enter", false, 400, 1200)).toBe(LIST_DEFAULT);
  });

  it("leaves other keys alone", () => {
    expect(keyedListWidth("j", false, 400, 1200)).toBeNull();
  });
});

describe("parseListWidth", () => {
  it("takes a stored width in range and nothing else", () => {
    expect(parseListWidth("452")).toBe(452);
    for (const stored of [null, "", "abc", "12.5", "100", "9000", "NaN"]) {
      expect(parseListWidth(stored)).toBe(LIST_DEFAULT);
    }
  });
});

describe("the list beside the pane of the agent (ADR 0064, rule 14)", () => {
  it("keeps the chosen width where the window has room for the pane and 520 px of reading", () => {
    expect(listBesidePane(380, 1400)).toBe(380);
    expect(listBesidePane(560, 1440)).toBe(560);
  });

  it("narrows the list in a narrower window, never under 300", () => {
    expect(listBesidePane(380, 1100)).toBe(300);
    expect(listBesidePane(560, 1200)).toBe(320);
    expect(listBesidePane(560, 720)).toBe(300);
  });

  it("gives way further to a wider column, and the default column is the old rule", () => {
    expect(listBesidePane(380, 1400, 360)).toBe(listBesidePane(380, 1400));
    expect(listBesidePane(380, 1400, 640)).toBe(300);
    expect(listBesidePane(380, 1400, 480)).toBe(380);
    expect(listBesidePane(560, 1500, 500)).toBe(480);
    expect(listBesidePane(560, 1000, 640)).toBe(300);
  });

  it("never draws a list wider than the chosen width, and never changes that choice", () => {
    expect(listBesidePane(290, 720)).toBe(290);
    expect(listBesidePane(380, 720)).toBe(300);
    expect(fitListWidth(380, 720)).toBe(380);
  });
});
