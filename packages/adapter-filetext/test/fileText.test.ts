import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePdf } from "@matters/testkit";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { extractFileText } from "../src/index.ts";

// ADR 0087, rule 3 to 5: the text of a PDF, a Word file and plain text, on invented files.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(name: string, bytes: Uint8Array | string): string {
  const dir = mkdtempSync(join(tmpdir(), "matters-filetext-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const docx = (body: string, extra: Record<string, Uint8Array> = {}) =>
  zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
    ...extra,
  });

describe("PDF", () => {
  it("reads the text layer of every page, in order, and says how many pages", async () => {
    const pdf = makePdf([
      ["Employment terms", "Salary: 12 000 EUR"],
      ["Page two says notice period 3 months"],
    ]);
    const out = await extractFileText(file("contract.pdf", pdf), "pdf");
    expect(out.state).toBe("ok");
    expect(out.pages).toBe(2);
    expect(out.text).toContain("Employment terms");
    expect(out.text).toContain("Salary: 12 000 EUR");
    expect(out.text.indexOf("Salary")).toBeLessThan(out.text.indexOf("notice period"));
  });

  it("reads Polish letters of a WinAnsi string", async () => {
    // WinAnsi (cp1250 is not WinAnsi): only the letters it has; the Latin-1 ones here.
    const out = await extractFileText(
      file("a.pdf", makePdf([["Umowa o prace, zaliczka 500 \xe9"]])),
      "pdf",
    );
    expect(out.state).toBe("ok");
    expect(out.text).toContain("Umowa o prace");
    expect(out.text).toContain("é");
  });

  it("answers no text for a page with no text layer, as a scan has", async () => {
    const out = await extractFileText(file("scan.pdf", makePdf([[], []])), "pdf");
    expect(out).toMatchObject({ state: "no_text", text: "", pages: 2 });
  });

  // ADR 0090, rule 1: a Word export whose body became pictures keeps only its header and footer.
  it("answers no text when the text layer is only a header and page numbers", async () => {
    const pages = [[], ...[2, 3, 4, 5, 6].map((n) => ["Confidential", `Page ${n} from 6`])];
    const out = await extractFileText(file("contract.pdf", makePdf(pages)), "pdf");
    expect(out).toMatchObject({ state: "no_text", text: "", pages: 6 });
  });

  it("still reads a short body under a repeated footer", async () => {
    const pages = [
      ["Invoice 12/2026, total 1 230,00 PLN", "Page 1 of 2"],
      ["Due 2026-12-01 to account of Matters", "Page 2 of 2"],
    ];
    const out = await extractFileText(file("invoice.pdf", makePdf(pages)), "pdf");
    expect(out.state).toBe("ok");
    expect(out.text).toContain("Page 1 of 2");
  });

  it("reads a one-page note, which has nothing to repeat", async () => {
    const out = await extractFileText(
      file("note.pdf", makePdf([["Meeting moved to 10:00, room B"]])),
      "pdf",
    );
    expect(out.state).toBe("ok");
  });

  it("stops at the page cap and says so", async () => {
    // Each page has a body of its own, so the repeated "Page number" line is not all there is.
    const pages = Array.from({ length: 6 }, (_, i) => [
      `Page number ${i + 1}`,
      `Clause ${"ABCDEF"[i]} of the agreement`,
    ]);
    const out = await extractFileText(file("long.pdf", makePdf(pages)), "pdf", { maxPages: 3 });
    expect(out.state).toBe("ok");
    expect(out.pages).toBe(6);
    expect(out.text).toContain("Page number 3");
    expect(out.text).not.toContain("Page number 4");
    expect(out.text).toContain("only 3 of 6 pages read");
  });

  it("cuts the text at 20 000 characters with a line that says how much was left out", async () => {
    const page = (p: number) =>
      Array.from({ length: 40 }, (_, i) => `Line ${p}.${i} of a very long agreement text`);
    const out = await extractFileText(
      file("big.pdf", makePdf(Array.from({ length: 30 }, (_, p) => page(p)))),
      "pdf",
    );
    expect(out.state).toBe("ok");
    expect(out.text.length).toBeLessThan(20_200);
    expect(out.text).toMatch(/\[\.\.\. \d+ more characters of this file left out \.\.\.\]/);
  });

  it("fails, not crashes, on a file that is not a PDF", async () => {
    const out = await extractFileText(file("fake.pdf", "this is not a pdf at all"), "pdf");
    expect(out.state).toBe("failed");
  });

  it("gives up when it takes longer than its time", async () => {
    const out = await extractFileText(file("slow.pdf", makePdf([["x"]])), "pdf", { timeMs: 0 });
    expect(out.state).toBe("failed");
  });
});

describe("Word", () => {
  it("reads the paragraphs, decodes entities, and ignores the rest of the file", async () => {
    const body =
      "<w:p><w:r><w:t>Terms &amp; conditions</w:t></w:r></w:p>" +
      '<w:p><w:r><w:t xml:space="preserve">Pay: </w:t></w:r><w:r><w:t>5 000</w:t></w:r></w:p>';
    const out = await extractFileText(file("a.docx", docx(body)), "docx");
    expect(out.state).toBe("ok");
    expect(out.text).toBe("Terms & conditions\nPay: 5 000");
  });

  it("answers no text for an empty document", async () => {
    const out = await extractFileText(file("e.docx", docx("<w:p/>")), "docx");
    expect(out.state).toBe("no_text");
  });

  it("refuses an archive that unpacks past the cap, and one with too many entries", async () => {
    const bomb = docx("<w:p><w:r><w:t>x</w:t></w:r></w:p>", {
      "word/media/huge.bin": new Uint8Array(1_000_000),
    });
    // The cap is on what is inflated of the part that is read.
    const big = zipSync({ "word/document.xml": new Uint8Array(3_000_000).fill(32) });
    const refused = await extractFileText(file("bomb.docx", big), "docx", {
      maxInflatedBytes: 1_000_000,
    });
    expect(refused.state).toBe("failed");
    expect(refused.reason).toMatch(/too large/);
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, strToU8("a")] as const),
    );
    const out = await extractFileText(file("many.docx", docx("<w:p/>", many)), "docx", {
      maxDocxEntries: 10,
    });
    expect(out.state).toBe("failed");
    expect(out.reason).toMatch(/too many/);
    // A big part the reader does not need is never unpacked.
    expect(await extractFileText(file("ok.docx", bomb), "docx")).toMatchObject({
      state: "ok",
      text: "x",
    });
  });

  it("fails on a ZIP that is not a Word document, and on bytes that are not a ZIP", async () => {
    const other = zipSync({ "readme.txt": strToU8("hi") });
    expect((await extractFileText(file("o.docx", other), "docx")).state).toBe("failed");
    expect((await extractFileText(file("n.docx", "not a zip"), "docx")).state).toBe("failed");
  });
});

describe("text and the size cap", () => {
  it("reads text as it is, and HTML as the words a page would show", async () => {
    expect((await extractFileText(file("a.txt", "Line one\r\nLine two"), "text")).text).toBe(
      "Line one\nLine two",
    );
    const html = '<p>Shown</p><p style="display:none">Hidden words</p>';
    const out = await extractFileText(file("a.html", html), "html", {
      htmlToText: (h) =>
        h.replace(/<p style="display:none">.*?<\/p>/g, "").replace(/<[^>]+>/g, " "),
    });
    expect(out.text).toContain("Shown");
    expect(out.text).not.toContain("Hidden");
  });

  it("does not read HTML without a converter", async () => {
    expect((await extractFileText(file("a.html", "<p>x</p>"), "html")).state).toBe("failed");
  });

  it("does not read a file over the cap, whatever its row said", async () => {
    const out = await extractFileText(file("a.txt", "x".repeat(100)), "text", { maxBytes: 50 });
    expect(out.state).toBe("too_big");
  });

  it("fails on a file that is gone", async () => {
    expect((await extractFileText("/no/such/file.pdf", "pdf")).state).toBe("failed");
  });
});
