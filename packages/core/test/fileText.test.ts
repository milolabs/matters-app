import { describe, expect, it } from "vitest";
import {
  capFileText,
  createFileReader,
  describeFile,
  docxXmlToText,
  type FetchOutcome,
  type KeptFileText,
  MAX_FILE_READ_BYTES,
  MAX_FILE_TEXT_CHARS,
  type MessageAttachments,
  readableKind,
  threadFiles,
  wholeFilesProblem,
  wholeMediaType,
} from "../src/index.ts";
import { QUICK_MS, timed } from "./support.ts";

// ADR 0087: which files are read, how much of them goes to a model, how Word paragraphs come out,
// how a thread's files are numbered, and how one file is read (kept text, limits, one run).

describe("which files are read (rule 3)", () => {
  it("goes by the type, and by the extension only when the type says nothing", () => {
    expect(readableKind("application/pdf", "x")).toBe("pdf");
    expect(readableKind("Application/PDF; name=a", "x")).toBe("pdf");
    expect(
      readableKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x"),
    ).toBe("docx");
    for (const t of ["text/plain", "text/csv", "text/calendar"]) {
      expect(readableKind(t, "x")).toBe("text");
    }
    expect(readableKind("text/html", "x")).toBe("html");
    expect(readableKind("application/octet-stream", "Contract.PDF")).toBe("pdf");
    expect(readableKind("", "a.docx")).toBe("docx");
    expect(readableKind("application/octet-stream", "a.ics")).toBe("text");
    // The type wins over the name; nothing else is read: old Word, pictures, archives.
    expect(readableKind("image/png", "a.pdf")).toBeNull();
    expect(readableKind("application/msword", "a.doc")).toBeNull();
    expect(readableKind("application/zip", "a.zip")).toBeNull();
    expect(readableKind("application/octet-stream", "a.exe")).toBeNull();
  });
});

describe("the cap on one file's text (rule 4)", () => {
  it("leaves short text alone and cuts long text with a line that says how much was left", () => {
    expect(capFileText("  short  ")).toBe("short");
    const out = capFileText("a".repeat(MAX_FILE_TEXT_CHARS + 1234));
    expect(out.startsWith("a".repeat(MAX_FILE_TEXT_CHARS))).toBe(true);
    expect(out).toContain("[... 1234 more characters of this file left out ...]");
    expect(capFileText("a".repeat(MAX_FILE_TEXT_CHARS))).toBe("a".repeat(MAX_FILE_TEXT_CHARS));
  });

  it("does not cut a surrogate pair in two", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(5)}`;
    expect(capFileText(text, 10)).toMatch(/^a{9}\n\[\.\.\. 7 more/);
  });
});

describe("Word paragraphs (rule 3)", () => {
  it("takes the text of runs, a line per paragraph, tabs and breaks, and decodes entities", () => {
    const xml =
      '<w:p><w:pPr><w:pStyle w:val="x"/></w:pPr><w:r><w:t>Fish &amp; chips &lt;3 &#65;&#x42;</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>' +
      "<w:p/><w:p/><w:p/><w:p><w:r><w:t>End</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("Fish & chips <3 AB\nA \tB\nC\nEnd");
  });

  it("leaves an unknown entity as it is and never expands a bad code point", () => {
    expect(docxXmlToText("<w:p><w:r><w:t>&bogus; &#0; &#xD800;</w:t></w:r></w:p>")).toBe(
      "&bogus; &#0; &#xD800;",
    );
  });

  it("does not take text of other elements", () => {
    expect(
      docxXmlToText("<w:p><w:instrText>HYPERLINK</w:instrText><w:r><w:t>x</w:t></w:r></w:p>"),
    ).toBe("x");
  });
});

const attachments = (
  items: readonly {
    partId: string;
    name: string;
    inline?: boolean;
    size?: number;
    mimeType?: string;
  }[],
): MessageAttachments => ({
  known: true,
  hasInline: items.some((i) => i.inline === true),
  items: items.map((i) => ({
    partId: i.partId,
    name: i.name,
    mimeType: i.mimeType ?? "application/pdf",
    size: i.size ?? 1000,
    inline: i.inline ?? false,
  })),
});

describe("the files of a thread, numbered (rule 1)", () => {
  it("counts non-inline files across the messages, oldest first, from 1", () => {
    const files = threadFiles({
      messages: [{ key: 5 }, { key: 9 }, { key: 12 }],
      attachments: new Map([
        [
          5,
          attachments([
            { partId: "2", name: "a.pdf" },
            { partId: "3", name: "logo.png", inline: true },
          ]),
        ],
        [9, attachments([])],
        [
          12,
          attachments([
            { partId: "2", name: "b.pdf" },
            { partId: "4", name: "c.docx" },
          ]),
        ],
      ]),
    });
    expect(files.map((f) => [f.position, f.messageKey, f.partId, f.name])).toEqual([
      [1, 5, "2", "a.pdf"],
      [2, 12, "2", "b.pdf"],
      [3, 12, "4", "c.docx"],
    ]);
  });

  it("names the type in words and the size", () => {
    expect(describeFile({ mimeType: "application/pdf", name: "a", size: 1_234_567 })).toBe(
      "PDF, 1.2 MB",
    );
    expect(describeFile({ mimeType: "image/png", name: "a", size: 800 })).toBe("image/png, 800 B");
    expect(describeFile({ mimeType: "", name: "a.docx", size: 52_000 })).toBe("Word, 52 KB");
  });
});

describe("reading one file (rules 2 to 6)", () => {
  function rig(
    over: {
      attachment?: { name: string; mimeType: string; size: number } | null;
      fetched?: FetchOutcome;
      extracted?: Awaited<
        ReturnType<NonNullable<Parameters<typeof createFileReader>[0]["extractor"]>["extractText"]>
      >;
      path?: string | null;
      noExtractor?: boolean;
    } = {},
  ) {
    const kept = new Map<string, KeptFileText>();
    const log: string[] = [];
    const release: (() => void) | null = null;
    const reader = createFileReader({
      store: {
        getAttachment: async () =>
          over.attachment === null
            ? null
            : {
                partId: "2",
                name: "contract.pdf",
                mimeType: "application/pdf",
                size: 5000,
                inline: false,
                ...over.attachment,
              },
      },
      texts: {
        get: async (k, p) => kept.get(`${k}/${p}`) ?? null,
        put: async (k, p, v) => void kept.set(`${k}/${p}`, v),
        clear: async () => 0,
        count: async () => kept.size,
      },
      fetch: async () => {
        log.push("fetch");
        return over.fetched ?? { kind: "done" };
      },
      locate: async () => (over.path === undefined ? "/cache/x" : over.path),
      extractor: over.noExtractor
        ? undefined
        : {
            extractText: async () => {
              log.push("extract");
              if (release === null) await Promise.resolve();
              return over.extracted ?? { state: "ok", text: "Salary 100", pages: 3, reason: "" };
            },
          },
      now: () => 777,
    });
    return { reader, kept, log, hold: () => release };
  }

  it("downloads, extracts, keeps, and answers from the kept text the second time", async () => {
    const r = rig();
    const first = await r.reader.read(1, "2");
    expect(first).toEqual({ state: "ok", text: "Salary 100", pages: 3, reason: "" });
    expect(r.kept.get("1/2")).toEqual({
      text: "Salary 100",
      pages: 3,
      state: "ok",
      extractedMs: 777,
    });
    expect(r.log).toEqual(["fetch", "extract"]);
    const second = await r.reader.read(1, "2");
    expect(second.text).toBe("Salary 100");
    expect(r.log).toEqual(["fetch", "extract"]);
  });

  it("keeps no_text and answers it as a probable scan, without reading again", async () => {
    const r = rig({ extracted: { state: "no_text", text: "", pages: 2, reason: "" } });
    const a = await r.reader.read(1, "2");
    expect(a.state).toBe("no_text");
    expect(a.reason).toMatch(/probably a scan/);
    expect((await r.reader.read(1, "2")).state).toBe("no_text");
    expect(r.log).toEqual(["fetch", "extract"]);
  });

  it("refuses a kind it does not read, and a file over 10 MB, before any download", async () => {
    const odd = rig({ attachment: { name: "a.png", mimeType: "image/png", size: 10 } });
    expect((await odd.reader.read(1, "2")).state).toBe("unsupported");
    const big = rig({
      attachment: { name: "a.pdf", mimeType: "application/pdf", size: MAX_FILE_READ_BYTES + 1 },
    });
    expect((await big.reader.read(1, "2")).state).toBe("too_big");
    expect(odd.log).toEqual([]);
    expect(big.log).toEqual([]);
    expect(big.kept.size).toBe(0);
  });

  it("says why a file could not be fetched, and keeps nothing for a failure", async () => {
    const offline = rig({ fetched: { kind: "offline", message: "x" } });
    const a = await offline.reader.read(1, "2");
    expect(a).toMatchObject({ state: "failed", reason: "The mail server could not be reached." });
    expect(offline.kept.size).toBe(0);
    const gone = rig({ fetched: { kind: "gone" } });
    expect((await gone.reader.read(1, "2")).reason).toMatch(/no longer on the server/);
    const failedRead = rig({
      extracted: {
        state: "failed",
        text: "",
        pages: null,
        reason: "Reading the file took too long.",
      },
    });
    expect(await failedRead.reader.read(1, "2")).toMatchObject({
      state: "failed",
      reason: "Reading the file took too long.",
    });
    expect(failedRead.kept.size).toBe(0);
    expect((await rig({ attachment: null }).reader.read(1, "2")).state).toBe("failed");
    expect((await rig({ path: null }).reader.read(1, "2")).state).toBe("failed");
    expect((await rig({ noExtractor: true }).reader.read(1, "2")).state).toBe("failed");
  });

  it("joins asks for the same part into one run", async () => {
    const r = rig();
    const [a, b, c] = await Promise.all([
      r.reader.read(1, "2"),
      r.reader.read(1, "2"),
      r.reader.read(1, "2"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(r.log).toEqual(["fetch", "extract"]);
  });
});

// ADR 0090, rules 2, 4 and 8: which files go whole, the last check on them, and how one is read.

const enc = (s: string) => new TextEncoder().encode(s);
const PDF_BYTES = enc("%PDF-1.7 body");
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe("which files go whole (rule 2)", () => {
  it("takes a PDF and four image types, by type, and by extension only when the type says nothing", () => {
    expect(wholeMediaType("application/pdf", "x")).toBe("application/pdf");
    expect(wholeMediaType("image/JPG; name=a", "x")).toBe("image/jpeg");
    expect(wholeMediaType("image/png", "x")).toBe("image/png");
    expect(wholeMediaType("image/webp", "x")).toBe("image/webp");
    expect(wholeMediaType("application/octet-stream", "Scan.JPEG")).toBe("image/jpeg");
    expect(wholeMediaType("", "a.pdf")).toBe("application/pdf");
    expect(wholeMediaType("image/heic", "a.heic")).toBeNull();
    expect(wholeMediaType("image/svg+xml", "a.svg")).toBeNull();
    expect(wholeMediaType("text/plain", "a.pdf")).toBeNull();
  });
});

describe("the last check before files leave (rule 4)", () => {
  const pdf = { mediaType: "application/pdf" as const, bytes: PDF_BYTES };
  it("lets up to three real files through", () => {
    expect(wholeFilesProblem([])).toBeNull();
    expect(
      wholeFilesProblem([pdf, pdf, { mediaType: "image/jpeg", bytes: JPEG_BYTES }]),
    ).toBeNull();
  });
  it("refuses a fourth, an empty one, a mislabeled one, a large image and too many bytes", () => {
    expect(wholeFilesProblem([pdf, pdf, pdf, pdf])).toMatch(/Too many/);
    expect(wholeFilesProblem([{ mediaType: "application/pdf", bytes: new Uint8Array() }])).toMatch(
      /empty/,
    );
    expect(wholeFilesProblem([{ mediaType: "image/png", bytes: JPEG_BYTES }])).toMatch(/type says/);
    const big = new Uint8Array(5_000_001);
    big.set(JPEG_BYTES);
    expect(wholeFilesProblem([{ mediaType: "image/jpeg", bytes: big }])).toMatch(/image is too/);
    const huge = new Uint8Array(6_000_000);
    huge.set(PDF_BYTES);
    expect(
      wholeFilesProblem([
        { mediaType: "application/pdf", bytes: huge },
        { mediaType: "application/pdf", bytes: huge },
      ]),
    ).toMatch(/too large/);
  });
});

describe("reading a file whole (rule 8)", () => {
  function rig(
    over: {
      attachment?: { name: string; mimeType: string; size: number } | null;
      bytes?: Uint8Array | null;
      noBytes?: boolean;
      fetched?: FetchOutcome;
    } = {},
  ) {
    const log: string[] = [];
    const reader = createFileReader({
      store: {
        getAttachment: async () =>
          over.attachment === null
            ? null
            : {
                partId: "2",
                name: "contract.pdf",
                mimeType: "application/pdf",
                size: 5000,
                inline: false,
                ...over.attachment,
              },
      },
      texts: {
        get: async () => null,
        put: async () => {},
        clear: async () => 0,
        count: async () => 0,
      },
      fetch: async () => {
        log.push("fetch");
        return over.fetched ?? { kind: "done" };
      },
      locate: async () => "/cache/x",
      extractor: undefined,
      ...(over.noBytes
        ? {}
        : {
            readBytes: async (path: string, max: number) => {
              log.push(`bytes ${path} ${max}`);
              return over.bytes === undefined ? PDF_BYTES : over.bytes;
            },
          }),
      now: () => 1,
    });
    return { reader, log };
  }

  it("gets the bytes through the cache, with the cap, and the type it goes as", async () => {
    const r = rig();
    const out = await r.reader.whole(1, "2");
    expect(out).toEqual({
      kind: "ok",
      file: { name: "contract.pdf", mediaType: "application/pdf", bytes: PDF_BYTES },
    });
    expect(r.log).toEqual(["fetch", "bytes /cache/x 10000000"]);
  });

  it("sends an image, which has no text to read", async () => {
    const r = rig({
      attachment: { name: "scan.jpg", mimeType: "image/jpeg", size: 7 },
      bytes: JPEG_BYTES,
    });
    const out = await r.reader.whole(1, "2");
    expect(out.kind === "ok" && out.file.mediaType).toBe("image/jpeg");
  });

  it("says why not, without a download, for a kind never sent or a file over 10 MB", async () => {
    const kind = rig({ attachment: { name: "a.zip", mimeType: "application/zip", size: 9 } });
    expect(await kind.reader.whole(1, "2")).toMatchObject({ kind: "not" });
    const big = rig({
      attachment: { name: "a.pdf", mimeType: "application/pdf", size: 10_000_001 },
    });
    expect(await big.reader.whole(1, "2")).toMatchObject({ kind: "not" });
    expect([...kind.log, ...big.log]).toEqual([]);
  });

  it("refuses bytes that are not what the type says, a failed download, and no way to read bytes", async () => {
    expect(await rig({ bytes: enc("MZ") }).reader.whole(1, "2")).toEqual({
      kind: "not",
      reason: "The file is not what its type says.",
    });
    expect(
      await rig({ fetched: { kind: "offline", message: "x" } }).reader.whole(1, "2"),
    ).toMatchObject({
      kind: "not",
    });
    expect(await rig({ bytes: null }).reader.whole(1, "2")).toMatchObject({ kind: "not" });
    expect(await rig({ noBytes: true }).reader.whole(1, "2")).toMatchObject({ kind: "not" });
  });
});

describe("docxXmlToText and unclosed runs", () => {
  it("takes linear time on many `<w:t` tags that never close", () => {
    const xml = `<w:p>${"<w:t\t".repeat(50_000)}<w:t>end</w:t></w:p>`;
    const { result, ms } = timed(() => docxXmlToText(xml));
    expect(result).toBe("end");
    expect(ms).toBeLessThan(QUICK_MS);
  });

  it("still reads a run with attributes", () => {
    expect(docxXmlToText('<w:p><w:t xml:space="preserve"> a </w:t><w:t\n>b</w:t></w:p>')).toBe(
      "a b",
    );
  });
});
