import { describe, expect, it } from "vitest";
import { chooseVersion, nextVersion, withVersion } from "./next-version";

describe("the next version (ADR 0124)", () => {
  it("starts with the first alpha", () => {
    expect(nextVersion("0.0.0")).toBe("0.1.0-alpha.1");
  });

  it("counts a suffix on", () => {
    expect(nextVersion("0.1.0-alpha.1")).toBe("0.1.0-alpha.2");
    expect(nextVersion("0.1.0-alpha.9")).toBe("0.1.0-alpha.10");
    expect(nextVersion("0.1.0-beta.3")).toBe("0.1.0-beta.4");
  });

  it("counts the patch on when there is no suffix", () => {
    expect(nextVersion("0.1.0")).toBe("0.1.1");
    expect(nextVersion("1.4.19")).toBe("1.4.20");
  });

  it("does not guess after a suffix without a number", () => {
    expect(() => nextVersion("0.1.0-beta")).toThrow(/name the next version/);
    expect(() => nextVersion("latest")).toThrow(/not a version/);
  });

  it("takes a named version as it is, with or without the v", () => {
    expect(chooseVersion("0.1.0-alpha.4", "0.1.0-beta.1")).toBe("0.1.0-beta.1");
    expect(chooseVersion("0.1.0-beta.2", " v0.1.0 ")).toBe("0.1.0");
    expect(chooseVersion("0.1.0-alpha.4", "")).toBe("0.1.0-alpha.5");
    expect(chooseVersion("0.1.0-alpha.4", undefined)).toBe("0.1.0-alpha.5");
  });

  it("refuses a name that is not a version, or is the version already", () => {
    expect(() => chooseVersion("0.1.0", "1.0")).toThrow(/not a version/);
    expect(() => chooseVersion("0.1.0", "01.0.0")).toThrow(/not a version/);
    expect(() => chooseVersion("0.1.0", "0.1.0; rm -rf /")).toThrow(/not a version/);
    expect(() => chooseVersion("0.1.0", "0.1.0")).toThrow(/already/);
  });

  it("changes only the version of the package it is pointed at", () => {
    const lock = [
      '"packages/core": {',
      '  "name": "@matters/core",',
      '  "version": "0.0.0",',
      "},",
      '"apps/desktop": {',
      '  "name": "@matters/desktop",',
      '  "version": "0.0.0",',
      '  "dependencies": { "x": { "version": "0.0.0" } },',
      "},",
    ].join("\n");
    const out = withVersion(lock, '"name": "@matters/desktop"', "0.1.0-alpha.1");
    expect(out.split("\n")[2]).toBe('  "version": "0.0.0",');
    expect(out.split("\n")[6]).toBe('  "version": "0.1.0-alpha.1",');
    expect(out.split("\n")[7]).toBe('  "dependencies": { "x": { "version": "0.0.0" } },');
    expect(() => withVersion(lock, '"name": "@matters/none"', "1.0.0")).toThrow(/not found/);
  });
});
