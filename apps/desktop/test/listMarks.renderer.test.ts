import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMarks, noMarks, ranged, stepped, toggled } from "../src/renderer/listMarks.ts";

const ORDER = ["a", "b", "c", "d", "e"];

describe("the arithmetic of chosen rows (ADR 0056, rule 3)", () => {
  it("⌘-click takes the row being read along with the first one", () => {
    expect([...toggled(noMarks<string>(), "c", "a").ids]).toEqual(["a", "c"]);
  });
  it("⌘-click on a chosen row lets it go", () => {
    const one = toggled(noMarks<string>(), "c", "a");
    expect([...toggled(one, "c", "a").ids]).toEqual(["a"]);
  });
  it("a range starts at the row being read, and is measured from the anchor after that", () => {
    const first = ranged(noMarks<string>(), ORDER, "c", "a");
    expect([...first.ids]).toEqual(["a", "b", "c"]);
    expect([...ranged(first, ORDER, "b", "a").ids]).toEqual(["a", "b"]);
  });
  it("a range goes upwards too, and replaces what it replaces", () => {
    const up = ranged(noMarks<string>(), ORDER, "b", "d");
    expect([...up.ids]).toEqual(["b", "c", "d"]);
  });
  it("a row that left the list starts over from itself", () => {
    expect([...ranged(noMarks<string>(), ORDER, "z", "a").ids]).toEqual(["z"]);
  });
  it("Shift with an arrow stops at the ends", () => {
    const at = { ...noMarks<string>(), head: "e" };
    expect(stepped(at, ORDER, 1, "a")).toBe("e");
    expect(stepped(noMarks<string>(), ORDER, -1, "a")).toBe("a");
    expect(stepped(noMarks<string>(), ORDER, 1, "a")).toBe("b");
  });
});

describe("marks over a list that changes", () => {
  const setup = () => {
    const [order, setOrder] = createSignal(ORDER);
    const marks = createMarks(order, () => "a");
    return { marks, setOrder };
  };

  it("are active from two rows, and rows that left no longer count", () =>
    createRoot((dispose) => {
      const { marks, setOrder } = setup();
      expect(marks.active()).toBe(false);
      marks.toggle("c");
      expect(marks.active()).toBe(true);
      setOrder(["a", "b", "d", "e"]);
      expect(marks.active()).toBe(false);
      expect(marks.has("c")).toBe(false);
      dispose();
    }));

  it("toggling down to one row hands it back to be opened, and chooses nothing", () =>
    createRoot((dispose) => {
      const { marks } = setup();
      marks.toggle("c");
      expect(marks.toggle("c")).toBe("a");
      expect(marks.ids().size).toBe(0);
      dispose();
    }));

  it("⌘A takes everything, and clear lets it go", () =>
    createRoot((dispose) => {
      const { marks } = setup();
      marks.all();
      expect(marks.ids().size).toBe(5);
      marks.clear();
      expect(marks.active()).toBe(false);
      dispose();
    }));
});
