import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAccountColors,
  watchAccountColors,
  writeAccountColors,
} from "../src/renderer/accountColors.ts";

describe("account colour persistence", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips palette ids and hex colours", () => {
    writeAccountColors({ a: "blue", b: "#12ab34" });
    expect(readAccountColors()).toEqual({ a: "blue", b: "#12ab34" });
  });

  it("drops invalid values", () => {
    data.set(
      "matters.accountColors",
      JSON.stringify({ a: "red", b: "#abc", c: 5, d: null, e: "teal" }),
    );
    expect(readAccountColors()).toEqual({ e: "teal" });
  });

  it("lower-cases uppercase hex", () => {
    data.set("matters.accountColors", JSON.stringify({ a: "#AABBCC" }));
    expect(readAccountColors()).toEqual({ a: "#aabbcc" });
  });

  it("returns nothing for malformed storage", () => {
    data.set("matters.accountColors", "[1]");
    expect(readAccountColors()).toEqual({});
    data.set("matters.accountColors", "{oops");
    expect(readAccountColors()).toEqual({});
  });

  it("hears colours changed in another window, and nothing else", () => {
    const listeners: ((event: { key: string | null }) => void)[] = [];
    vi.stubGlobal("window", { addEventListener: (_: string, l: never) => listeners.push(l) });
    const onChange = vi.fn();
    watchAccountColors(onChange);
    listeners[0]?.({ key: "matters.imagesFrom" });
    expect(onChange).not.toHaveBeenCalled();
    listeners[0]?.({ key: "matters.accountColors" });
    listeners[0]?.({ key: null }); // the whole storage was cleared
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
