import { describe, expect, it } from "vitest";
import { messageKey, splitMessageKey } from "../src/index.ts";

describe("messageKey", () => {
  it("is dateMs * 1024 + seq", () => {
    expect(messageKey(1000, 5)).toBe(1000 * 1024 + 5);
  });

  it("orders chronologically, then by seq", () => {
    const a = messageKey(1_700_000_000_000, 1023);
    const b = messageKey(1_700_000_000_001, 0);
    const c = messageKey(1_700_000_000_001, 1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("accepts the bounds of seq", () => {
    expect(() => messageKey(1, 0)).not.toThrow();
    expect(() => messageKey(1, 1023)).not.toThrow();
  });

  it.each([-1, 1024, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects seq %s", (seq) => {
    expect(() => messageKey(1, seq)).toThrow(RangeError);
  });

  it("rejects non-integer dates and unsafe results", () => {
    expect(() => messageKey(1.5, 0)).toThrow(RangeError);
    expect(() => messageKey(Number.NaN, 0)).toThrow(RangeError);
    expect(() => messageKey(Number.MAX_SAFE_INTEGER, 0)).toThrow(RangeError);
  });

  it("splits back into date and seq", () => {
    expect(splitMessageKey(messageKey(1_700_000_000_123, 77))).toEqual({
      dateMs: 1_700_000_000_123,
      seq: 77,
    });
  });
});
