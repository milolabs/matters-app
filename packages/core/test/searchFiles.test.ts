import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FILE_HITS,
  type FileHit,
  type FilesPort,
  fileNameMatches,
  foldFileName,
  MAX_FILE_HITS,
  searchFiles,
} from "../src/index.ts";

function setup() {
  const searchFilesOnPort = vi.fn(async (): Promise<readonly FileHit[]> => []);
  const files: FilesPort = { searchFiles: searchFilesOnPort };
  return { deps: { files }, port: searchFilesOnPort };
}

describe("searchFiles", () => {
  it("asks for nothing when the text is blank or the limit is zero", async () => {
    const s = setup();
    for (const text of ["", "   ", "\n\t"]) expect(await searchFiles(s.deps, { text })).toEqual([]);
    expect(await searchFiles(s.deps, { text: "a", limit: 0 })).toEqual([]);
    expect(await searchFiles(s.deps, { text: "a", limit: -3 })).toEqual([]);
    expect(await searchFiles(s.deps, { text: "a", limit: Number.NaN })).toEqual([]);
    expect(s.port).not.toHaveBeenCalled();
  });

  it("trims the text and defaults the limit to five", async () => {
    const s = setup();
    await searchFiles(s.deps, { text: "  aneks " });
    expect(s.port).toHaveBeenCalledWith("aneks", DEFAULT_FILE_HITS, undefined);
    expect(DEFAULT_FILE_HITS).toBe(5);
  });

  it("caps the limit and passes the account on", async () => {
    const s = setup();
    await searchFiles(s.deps, { text: "x", limit: 10_000, accountId: "acc2" });
    expect(s.port).toHaveBeenCalledWith("x", MAX_FILE_HITS, "acc2");
    await searchFiles(s.deps, { text: "x", limit: 3.9 });
    expect(s.port).toHaveBeenLastCalledWith("x", 3, undefined);
  });

  it("returns what the port found, in its order", async () => {
    const s = setup();
    const hit = { fileName: "a.pdf" } as FileHit;
    s.port.mockResolvedValueOnce([hit]);
    expect(await searchFiles(s.deps, { text: "a" })).toEqual([hit]);
  });
});

describe("file names (ADR 0074)", () => {
  it("folds case, diacritics and white space", () => {
    expect(foldFileName("  Załącznik\t ŁÓDŹ  nr 1.PDF ")).toBe("zalacznik lodz nr 1.pdf");
  });

  it("matches three characters or more anywhere, fewer only at the start of a word", () => {
    const name = foldFileName("Aneks_651_2026.pdf");
    expect(fileNameMatches(name, "651")).toBe(true);
    expect(fileNameMatches(name, "ks_6")).toBe(true);
    expect(fileNameMatches(name, "an")).toBe(true);
    expect(fileNameMatches(name, "pd")).toBe(true);
    expect(fileNameMatches(name, "ek")).toBe(false);
    expect(fileNameMatches(name, "_6")).toBe(false);
    expect(fileNameMatches(name, "")).toBe(false);
  });
});
