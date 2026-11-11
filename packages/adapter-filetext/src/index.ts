// Reading the text of a file that arrived by mail (ADR 0087, rule 3). This runs on the attachment
// worker thread only, never on the main process and never inside a sync batch (the caller sees to
// that; this package knows no threads). Nothing here
// renders a page or runs anything a file carries: a PDF gives its text layer (pdf.js, with fonts
// and eval switched off), a Word file gives the paragraphs of `word/document.xml` (the ZIP is read
// with caps against bombs), and text is text.
import { readFile, stat } from "node:fs/promises";
import {
  capFileText,
  docxXmlToText,
  type ExtractedText,
  FILE_READ_TIME_MS,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_INFLATED_BYTES,
  MAX_FILE_READ_BYTES,
  MAX_FILE_READ_PAGES,
  type ReadableKind,
} from "@matters/core";
import { Unzip, UnzipInflate } from "fflate";

export interface ExtractOptions {
  /**
   * HTML to the words a page would show; the mime adapter's `visibleText`, brought in by the
   * caller (adapters do not depend on each other). Without it an HTML file is not read.
   */
  readonly htmlToText?: (html: string) => string;
  /** Defaults to the limits of ADR 0087; tests lower them. */
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly timeMs?: number;
  readonly maxDocxEntries?: number;
  readonly maxInflatedBytes?: number;
}

const failed = (reason: string): ExtractedText => ({
  state: "failed",
  text: "",
  pages: null,
  reason,
});

/** The text of the file at `path`, or why there is none. Never throws. */
export async function extractFileText(
  path: string,
  kind: ReadableKind,
  options: ExtractOptions = {},
): Promise<ExtractedText> {
  const maxBytes = options.maxBytes ?? MAX_FILE_READ_BYTES;
  try {
    // The row's size is an estimate from the encoded size: the real file is looked at again.
    const info = await stat(path);
    if (!info.isFile()) return failed("The file is not there.");
    if (info.size > maxBytes) {
      return {
        state: "too_big",
        text: "",
        pages: null,
        reason: "The file is over 10 MB, so it is not read.",
      };
    }
    const bytes = new Uint8Array(await readFile(path));
    switch (kind) {
      case "pdf":
        return await pdfText(bytes, options);
      case "docx":
        return docxText(bytes, options);
      case "text":
        return plain(new TextDecoder("utf-8").decode(bytes), null);
      case "html":
        return options.htmlToText === undefined
          ? failed("HTML files are not read here.")
          : plain(options.htmlToText(new TextDecoder("utf-8").decode(bytes)), null);
    }
  } catch {
    return failed("The file could not be read.");
  }
}

function plain(text: string, pages: number | null): ExtractedText {
  const capped = capFileText(text.replace(/\r\n?/g, "\n"));
  return capped === ""
    ? { state: "no_text", text: "", pages, reason: "" }
    : { state: "ok", text: capped, pages, reason: "" };
}

// --- PDF ---

async function pdfText(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractedText> {
  const maxPages = options.maxPages ?? MAX_FILE_READ_PAGES;
  const timeMs = options.timeMs ?? FILE_READ_TIME_MS;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const started = Date.now();
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // Nothing a file asks for over the network, and no standard font files: text only.
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), timeMs);
  });
  try {
    const opened = await Promise.race([task.promise, expired]);
    if (opened === "expired") return failed("Reading the file took too long.");
    const total = opened.numPages;
    const last = Math.min(total, maxPages);
    const pages: string[] = [];
    let read = 0;
    let stopped = false;
    for (let n = 1; n <= last; n++) {
      if (Date.now() - started >= timeMs) {
        stopped = true;
        break;
      }
      const page = await opened.getPage(n);
      const content = await Promise.race([page.getTextContent(), expired]);
      page.cleanup();
      if (content === "expired") {
        stopped = true;
        break;
      }
      pages.push(textOfItems(content.items));
      read = n;
    }
    const joined = pages.join("\n\n").trim();
    if (read === 0 && stopped) return failed("Reading the file took too long.");
    if (joined === "" || onlyPageFurniture(pages)) {
      return { state: "no_text", text: "", pages: total, reason: "" };
    }
    const note =
      read < total
        ? `\n[... ${stopped ? "stopped after" : "only"} ${read} of ${total} pages read ...]`
        : "";
    return {
      state: "ok",
      text: capFileText(joined) + note,
      pages: total,
      reason: "",
    };
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}

/** Fewer letters and digits than this per page, once headers and footers are left out, is no text. */
export const MIN_BODY_CHARS_PER_PAGE = 16;

/**
 * Whether the text layer holds only what repeats on the pages: a header, a footer, a page number
 * (ADR 0090, rule 1). A file whose body is drawn as pictures, a scan with a typed footer, or a
 * Word export that turned its text into images reads like that, and is no text, not a short text.
 * A line is furniture when, with its digits made alike, it is once on each page it is on, and on
 * at least two pages and half of those read. Rows that repeat within a page, as in a table, stay
 * text. One page has nothing to repeat, so only its length counts.
 */
export function onlyPageFurniture(pages: readonly string[]): boolean {
  if (pages.length === 0) return false;
  const shape = (line: string) =>
    line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const linesOf = pages.map((p) =>
    p
      .split("\n")
      .map(shape)
      .filter((l) => l !== ""),
  );
  const onPages = new Map<string, number>();
  const moreThanOnce = new Set<string>();
  for (const lines of linesOf) {
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l)) moreThanOnce.add(l);
      seen.add(l);
    }
    for (const l of seen) onPages.set(l, (onPages.get(l) ?? 0) + 1);
  }
  const furniture = (l: string) => {
    const on = onPages.get(l) ?? 0;
    return !moreThanOnce.has(l) && on >= 2 && on * 2 >= pages.length;
  };
  let body = 0;
  for (const lines of linesOf) {
    for (const l of lines) if (!furniture(l)) body += l.replace(/[^\p{L}\p{N}]/gu, "").length;
  }
  return body < MIN_BODY_CHARS_PER_PAGE * pages.length;
}

interface TextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

function textOfItems(items: readonly unknown[]): string {
  let out = "";
  for (const raw of items) {
    const item = raw as TextItem;
    if (typeof item.str !== "string") continue;
    out += item.str;
    if (item.hasEOL === true) out += "\n";
  }
  return out;
}

// --- DOCX ---

function docxText(bytes: Uint8Array, options: ExtractOptions): ExtractedText {
  const maxEntries = options.maxDocxEntries ?? MAX_DOCX_ENTRIES;
  const maxInflated = options.maxInflatedBytes ?? MAX_DOCX_INFLATED_BYTES;
  let entries = 0;
  let inflated = 0;
  let refused = "";
  const chunks: Uint8Array[] = [];
  let found = false;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    entries++;
    if (entries > maxEntries) {
      refused = "The file holds too many parts.";
      return;
    }
    if (file.name !== "word/document.xml") return;
    found = true;
    file.ondata = (error, chunk) => {
      if (error) {
        refused ||= "The file could not be read.";
        return;
      }
      inflated += chunk.length;
      if (inflated > maxInflated) {
        refused ||= "The file is too large when unpacked.";
        file.terminate();
        return;
      }
      chunks.push(chunk);
    };
    file.start();
  };
  try {
    // Fed in slices, so a bomb is cut off as soon as the cap is passed.
    const slice = 64 * 1024;
    for (let at = 0; at < bytes.length && refused === ""; at += slice) {
      unzip.push(
        bytes.subarray(at, Math.min(bytes.length, at + slice)),
        at + slice >= bytes.length,
      );
    }
  } catch {
    return failed("The file could not be read.");
  }
  if (refused !== "") return failed(refused);
  if (!found) return failed("This is not a Word document.");
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return plain(docxXmlToText(new TextDecoder("utf-8").decode(all)), null);
}
