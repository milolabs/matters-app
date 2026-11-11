import { describe, expect, it } from "vitest";
import { initials } from "../src/renderer/initials.ts";

describe("initials", () => {
  it("takes the first letters of the first and last word", () => {
    expect(initials("Anna Kowalska")).toBe("AK");
    expect(initials("Anna Maria Kowalska")).toBe("AK");
    expect(initials("Kowalska, Anna")).toBe("KA");
  });

  it("gives one letter for one word", () => {
    expect(initials("Kalibra")).toBe("K");
    expect(initials("kalibra")).toBe("K");
  });

  it("reads a bare address as a name", () => {
    expect(initials("jan.nowak@x.pl")).toBe("JN");
    expect(initials("jan_nowak-2@x.pl")).toBe("J2");
    expect(initials("billing@x.pl")).toBe("B");
  });

  it("prefers the name over the address in a display form", () => {
    expect(initials("Anna Kowalska <anna@x.pl>")).toBe("AK");
    expect(initials("<jan.nowak@x.pl>")).toBe("JN");
  });

  it("handles Polish diacritics", () => {
    expect(initials("Łukasz Żak")).toBe("ŁŻ");
    expect(initials("źdźbło")).toBe("Ź");
    expect(initials("Ósemka Ąć")).toBe("ÓĄ");
  });

  it("skips quotes and punctuation", () => {
    expect(initials('"Anna" (Acme) Kowalska')).toBe("AK");
    expect(initials("  - ")).toBe("?");
  });

  it("does not split an astral letter", () => {
    expect(initials("𝒜nna")).toBe("𝒜");
  });

  it("gives ? for nothing", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
    expect(initials("<>")).toBe("?");
  });
});
