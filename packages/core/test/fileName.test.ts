import { describe, expect, it } from "vitest";
import { isRunnableFile, MAX_FILE_NAME_BYTES, nameFromType, safeFileName } from "../src/index.ts";
import { QUICK_MS, timed } from "./support.ts";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const char = (code: number) => String.fromCodePoint(code);
/** No lone surrogate: `encodeURIComponent` throws on one. */
const wellFormed = (text: string) => {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
};
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => char(from + i));

describe("safeFileName (ADR 0043, rule 5)", () => {
  it("leaves an ordinary name alone, whatever it is written in", () => {
    expect(safeFileName("report.pdf")).toBe("report.pdf");
    expect(safeFileName("Zażółć gęślą jaźń — notatki.docx")).toBe(
      "Zażółć gęślą jaźń — notatki.docx",
    );
    expect(safeFileName("日本語のファイル.txt")).toBe("日本語のファイル.txt");
    expect(safeFileName("a b (1).tar.gz")).toBe("a b (1).tar.gz");
  });

  describe("path traversal and separators", () => {
    it("removes slashes and backslashes so a name cannot be a path", () => {
      expect(safeFileName("a/b.txt")).toBe("ab.txt");
      expect(safeFileName("a\\b.txt")).toBe("ab.txt");
      expect(safeFileName("/etc/passwd")).toBe("etcpasswd");
      expect(safeFileName("C:\\Windows\\system32\\evil.exe")).toBe("C:Windowssystem32evil.exe");
    });

    it("turns ../../.zshrc into a plain file name", () => {
      const name = safeFileName("../../.zshrc");
      expect(name).toBe("zshrc");
      expect(name).not.toContain("/");
      expect(name.startsWith(".")).toBe(false);
    });

    it("never returns . or .. or anything containing a separator", () => {
      for (const evil of [".", "..", "...", "../", "..\\", "a/../../b", "%2e%2e/x"]) {
        const name = safeFileName(evil);
        expect(name).not.toMatch(/[/\\]/);
        expect(name).not.toBe(".");
        expect(name).not.toBe("..");
      }
    });
  });

  describe("control characters", () => {
    it("removes C0 controls, DEL and C1 controls", () => {
      for (const code of [...range(0, 0x1f).map((c) => c.codePointAt(0) as number), 0x7f]) {
        expect(safeFileName(`a${char(code)}b.txt`)).toBe("ab.txt");
      }
      for (const c of range(0x80, 0x9f)) expect(safeFileName(`a${c}b.txt`)).toBe("ab.txt");
    });

    it("removes line and paragraph separators and newlines", () => {
      expect(safeFileName(`a${char(0x2028)}b${char(0x2029)}c\nd\re.txt`)).toBe("abcde.txt");
    });

    it("removes a NUL that would cut the name short in C code", () => {
      expect(safeFileName(`safe.txt${char(0)}.exe`)).toBe("safe.txt.exe");
    });
  });

  describe("bidirectional controls", () => {
    it("removes every override, embedding and isolate (U+202A to U+202E, U+2066 to U+2069)", () => {
      for (const c of [...range(0x202a, 0x202e), ...range(0x2066, 0x2069)]) {
        expect(safeFileName(`invoice${c}.pdf`)).toBe("invoice.pdf");
      }
    });

    it("removes the implicit marks too (U+200E, U+200F, U+061C)", () => {
      for (const code of [0x200e, 0x200f, 0x061c]) {
        expect(safeFileName(`a${char(code)}b.txt`)).toBe("ab.txt");
      }
    });

    it("shows invoice.pdf + RLO + exe as what it is, not as a PDF", () => {
      const tricky = `invoice.pdf${char(0x202e)}exe`;
      const name = safeFileName(tricky);
      expect(name).toBe("invoice.pdfexe");
      // Nothing is left to reorder the display.
      expect(name).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    });

    it("keeps right-to-left letters themselves: only the controls go", () => {
      expect(safeFileName("مستند.pdf")).toBe("مستند.pdf");
      expect(safeFileName("מסמך.docx")).toBe("מסמך.docx");
    });
  });

  describe("dots and spaces at the edges", () => {
    it("strips leading dots, so there is no hidden file", () => {
      expect(safeFileName(".bashrc")).toBe("bashrc");
      expect(safeFileName("...hidden.txt")).toBe("hidden.txt");
      expect(safeFileName(". . .x")).toBe("x");
    });

    it("strips trailing dots and spaces, which Windows ignores", () => {
      expect(safeFileName("a.exe.")).toBe("a.exe");
      expect(safeFileName("a.exe . .")).toBe("a.exe");
      expect(safeFileName("a.txt   ")).toBe("a.txt");
      expect(safeFileName("   a.txt")).toBe("a.txt");
    });

    it("keeps dots and spaces inside the name", () => {
      expect(safeFileName("a.b.c d.txt")).toBe("a.b.c d.txt");
    });
  });

  describe("Windows device names", () => {
    it("puts an underscore in front, with or without an extension, in any case", () => {
      for (const device of ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
        expect(safeFileName(device)).toBe(`_${device}`);
        expect(safeFileName(`${device}.txt`)).toBe(`_${device}.txt`);
      }
    });

    it("leaves names that only start like a device alone", () => {
      for (const fine of [
        "console.txt",
        "com10.txt",
        "com0",
        "auxiliary.pdf",
        "lpt.txt",
        "nulls",
      ]) {
        expect(safeFileName(fine)).toBe(fine);
      }
    });
  });

  describe("length in bytes", () => {
    it("allows exactly 200 bytes and cuts at 201", () => {
      const exact = `${"a".repeat(196)}.pdf`;
      expect(bytes(exact)).toBe(200);
      expect(safeFileName(exact)).toBe(exact);
      const over = `${"a".repeat(197)}.pdf`;
      const cut = safeFileName(over);
      expect(bytes(cut)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
      expect(cut.endsWith(".pdf")).toBe(true);
    });

    it("counts bytes, not characters: 100 two-byte letters fit, 101 do not", () => {
      const fits = `${"ż".repeat(98)}.txt`;
      expect(bytes(fits)).toBe(200);
      expect(safeFileName(fits)).toBe(fits);
      const cut = safeFileName(`${"ż".repeat(150)}.txt`);
      expect(bytes(cut)).toBeLessThanOrEqual(200);
      expect(cut.endsWith(".txt")).toBe(true);
      expect(cut).toMatch(/^ż+\.txt$/);
    });

    it("never cuts through a multi-byte character", () => {
      for (const unit of ["ż", "日", "😀", "e\u0301"]) {
        const cut = safeFileName(`${unit.repeat(300)}.pdf`);
        expect(bytes(cut)).toBeLessThanOrEqual(200);
        expect(cut.endsWith(".pdf")).toBe(true);
        // A cut in the middle of a character would leave U+FFFD or a lone surrogate.
        expect(cut).not.toContain("\ufffd");
        expect(wellFormed(cut)).toBe(true);
      }
    });

    it("keeps the extension of a long name", () => {
      const name = `${"Zestawienie kosztów ".repeat(20)}.xlsx`;
      const cut = safeFileName(name);
      expect(bytes(cut)).toBeLessThanOrEqual(200);
      expect(cut.endsWith(".xlsx")).toBe(true);
    });

    it("does not call a very long tail an extension", () => {
      const name = `a.${"x".repeat(400)}`;
      const cut = safeFileName(name);
      expect(bytes(cut)).toBeLessThanOrEqual(200);
      expect(cut.startsWith("a.")).toBe(true);
    });

    it("leaves no dot or space at the end of a stem that was cut", () => {
      const cut = safeFileName(`${"a".repeat(190)}. . . . . . . . . . .pdf`);
      expect(cut).not.toMatch(/[. ]\.pdf$/);
      expect(bytes(cut)).toBeLessThanOrEqual(200);
    });

    it("cuts a name with no extension too", () => {
      const cut = safeFileName("n".repeat(500));
      expect(bytes(cut)).toBe(200);
    });
  });

  describe("nothing left", () => {
    it("falls back to the name made from the type when the name is empty", () => {
      expect(safeFileName("", "invite.ics")).toBe("invite.ics");
      expect(safeFileName("   ", "message.eml")).toBe("message.eml");
    });

    it("falls back when only dots remain", () => {
      expect(safeFileName("....", "attachment.pdf")).toBe("attachment.pdf");
      expect(safeFileName(". . .", "attachment.pdf")).toBe("attachment.pdf");
    });

    it("falls back when only separators and controls remain", () => {
      expect(safeFileName(`//${char(0)}\\${char(0x202e)}`, "attachment.zip")).toBe(
        "attachment.zip",
      );
    });

    it("has a name even when the fallback is itself nothing", () => {
      expect(safeFileName("")).toBe("attachment");
      expect(safeFileName("", "...")).toBe("attachment");
      expect(safeFileName("", "")).toBe("attachment");
    });

    it("cleans the fallback like any other name", () => {
      expect(safeFileName("", `con`)).toBe("_con");
    });
  });

  it("replaces a lone surrogate instead of writing an invalid name", () => {
    const name = safeFileName(`a${char(0xd800)}b.txt`);
    expect(name).toBe("a\ufffdb.txt");
    expect(wellFormed(name)).toBe(true);
  });

  it("gives the same answer when applied to its own result", () => {
    const names = [
      "report.pdf",
      "../../.zshrc",
      `invoice.pdf${char(0x202e)}exe`,
      "CON.txt",
      "a.exe . .",
      `${"ż".repeat(300)}.txt`,
      "",
      "....",
      `x${char(0xd800)}`,
    ];
    for (const n of names) {
      const once = safeFileName(n);
      expect(safeFileName(once)).toBe(once);
    }
  });
});

describe("nameFromType (ADR 0043, rule 3)", () => {
  it("names a forwarded message, an invitation and files by their type", () => {
    expect(nameFromType("message/rfc822")).toBe("message.eml");
    expect(nameFromType("text/calendar")).toBe("invite.ics");
    expect(nameFromType("application/pdf")).toBe("attachment.pdf");
    expect(nameFromType("image/jpeg")).toBe("attachment.jpg");
    expect(nameFromType("APPLICATION/PDF")).toBe("attachment.pdf");
  });

  it("has a plain name for a type it does not know", () => {
    expect(nameFromType("application/x-whatever")).toBe("attachment");
    expect(nameFromType("")).toBe("attachment");
  });
});

describe("isRunnableFile (ADR 0043, rule 12)", () => {
  it("says yes to what runs or installs, on macOS, Windows and Linux", () => {
    for (const name of [
      "Installer.app",
      "run.command",
      "setup.sh",
      "setup.exe",
      "setup.msi",
      "tool.jar",
      "script.js",
      "disk.dmg",
      "pkg.pkg",
      "macro.scpt",
      "short.lnk",
      "link.webloc",
      "a.bat",
      "a.cmd",
      "a.ps1",
      "a.vbs",
      "a.scr",
      "a.com",
      "a.py",
      "a.desktop",
      "a.apk",
      "a.deb",
      "a.rpm",
    ]) {
      expect(isRunnableFile(name), name).toBe(true);
    }
  });

  it("says no to documents, pictures and archives", () => {
    for (const name of [
      "report.pdf",
      "photo.jpg",
      "notes.txt",
      "sheet.xlsx",
      "movie.mp4",
      "bundle.zip",
      "invite.ics",
      "message.eml",
      "data.json",
      "style.css",
    ]) {
      expect(isRunnableFile(name), name).toBe(false);
    }
  });

  it("ignores case", () => {
    expect(isRunnableFile("SETUP.EXE")).toBe(true);
    expect(isRunnableFile("Run.Command")).toBe(true);
    expect(isRunnableFile("a.JaR")).toBe(true);
    expect(isRunnableFile("REPORT.PDF")).toBe(false);
  });

  it("goes by the last extension: a.pdf.exe runs and a.exe.pdf does not", () => {
    expect(isRunnableFile("a.pdf.exe")).toBe(true);
    expect(isRunnableFile("invoice.pdf.command")).toBe(true);
    expect(isRunnableFile("a.exe.pdf")).toBe(false);
    expect(isRunnableFile("archive.tar.gz")).toBe(false);
  });

  it("does not take a name with no extension for one that runs", () => {
    expect(isRunnableFile("README")).toBe(false);
    expect(isRunnableFile("exe")).toBe(false);
    expect(isRunnableFile("")).toBe(false);
  });

  it("ignores trailing dots and spaces, as Windows does", () => {
    expect(isRunnableFile("a.exe.")).toBe(true);
    expect(isRunnableFile("a.exe...")).toBe(true);
    expect(isRunnableFile("a.exe . ")).toBe(true);
    expect(isRunnableFile("a.")).toBe(false);
    expect(isRunnableFile("a.pdf.")).toBe(false);
  });

  it("is not fooled by the extension being the whole name", () => {
    expect(isRunnableFile(".exe")).toBe(true);
    expect(isRunnableFile(".pdf")).toBe(false);
  });

  it("agrees with safeFileName: what it cleans keeps its verdict", () => {
    const tricky = `invoice.pdf${char(0x202e)}exe`;
    expect(isRunnableFile(safeFileName(tricky))).toBe(false);
    expect(isRunnableFile(safeFileName(`setup.exe${char(0)}.pdf`))).toBe(false);
    expect(isRunnableFile(safeFileName("run.command ..."))).toBe(true);
  });
});

describe("what review found (ADR 0043, rules 5 and 12)", () => {
  it.each([
    ["zero-width space", "invoice.pd​f", "invoice.pdf"],
    ["zero-width joiner", "invoice.pd‍f", "invoice.pdf"],
    ["word joiner", "invoice.pd⁠f", "invoice.pdf"],
    ["byte order mark", "﻿invoice.pdf", "invoice.pdf"],
    ["soft hyphen", "invoice.pd­f", "invoice.pdf"],
  ])("removes characters that draw nothing: %s", (_label, name, safe) => {
    expect(safeFileName(name)).toBe(safe);
  });

  it("does not let a hidden character keep a program's extension out of the check", () => {
    expect(isRunnableFile(safeFileName("setup.e​xe"))).toBe(true);
  });

  it("does not let spaces push the real extension out of sight", () => {
    expect(safeFileName(`report.pdf${" ".repeat(80)}.exe`)).toBe("report.pdf .exe");
    expect(safeFileName("a   b.pdf")).toBe("a b.pdf");
    expect(isRunnableFile(safeFileName(`report.pdf${" ".repeat(80)}.exe`))).toBe(true);
  });

  it("stays the same when applied twice to these names", () => {
    for (const name of ["a​.pdf", `x${" ".repeat(9)}y.pdf`, "­​"]) {
      expect(safeFileName(safeFileName(name))).toBe(safeFileName(name));
    }
  });

  it.each([
    "page.html",
    "page.HTM",
    "page.xhtml",
    "drawing.svg",
    "archive.mhtml",
    "saved.webarchive",
    "profile.mobileconfig",
    "pane.prefPane",
    "saver.saver",
    "disk.iso",
    "disk.img",
    "budget.xlsm",
    "letter.docm",
    "slides.pptm",
    "console.msc",
    "setup.inf",
  ])("%s is not opened", (name) => {
    expect(isRunnableFile(name)).toBe(true);
  });

  it.each(["a.pdf", "a.docx", "a.xlsx", "a.pptx", "a.png", "a.mp3", "a.zip", "a.ics", "a.eml"])(
    "%s still opens, or the list has become useless",
    (name) => {
      expect(isRunnableFile(name)).toBe(false);
    },
  );
});

describe("long runs of dots and white space", () => {
  it("are stripped from both edges in linear time", () => {
    const run = ". \t".repeat(20_000);
    const { result, ms } = timed(() => safeFileName(`${run}a${run}b${run}`));
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("b")).toBe(true);
    expect(ms).toBeLessThan(QUICK_MS);
  });

  it("do not slow down the runnable check when they do not reach the end", () => {
    const name = `a.exe${"\t".repeat(50_000)}x`;
    const { result, ms } = timed(() => isRunnableFile(name));
    expect(result).toBe(false);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(isRunnableFile(`a.exe${". \t".repeat(1000)}`)).toBe(true);
  });
});
