import type { MessageAttachments } from "./received.ts";

/**
 * The text of a file that arrived by mail, read for the agent (ADR 0087). Pure rules: which files
 * are readable, how much of their text goes to a model, how the paragraphs of a Word file are
 * found, and how the files of a thread are numbered.
 */

// --- Limits (ADR 0087, rule 4 and 7) ---

/** A file over this is not downloaded for the agent. */
export const MAX_FILE_READ_BYTES = 10_000_000;
/** Extraction stops after this many PDF pages ... */
export const MAX_FILE_READ_PAGES = 200;
/** ... or after this long. */
export const FILE_READ_TIME_MS = 20_000;
/** The most characters of one file that go to a model. */
export const MAX_FILE_TEXT_CHARS = 20_000;
/** A Word file's ZIP: at most this many entries, and at most this many bytes inflated. */
export const MAX_DOCX_ENTRIES = 2_000;
export const MAX_DOCX_INFLATED_BYTES = 30_000_000;
/** Files one question may read (ADR 0087, rule 7). */
export const MAX_LOOP_FILES_READ = 5;

// --- A file with no text, sent whole to the answer (ADR 0090, rules 2 and 4) ---

/** Files sent whole in one question ... */
export const MAX_WHOLE_FILES = 3;
/** ... their pages in all (an image is one) ... */
export const MAX_WHOLE_PAGES = 20;
/** ... and their bytes in all, before encoding. */
export const MAX_WHOLE_BYTES = 10_000_000;
/** One image over this is not sent: the provider refuses larger ones. */
export const MAX_WHOLE_IMAGE_BYTES = 5_000_000;

export type WholeMediaType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

const WHOLE_IMAGE_MIMES: Readonly<Record<string, WholeMediaType>> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};
const WHOLE_IMAGE_EXTENSIONS: Readonly<Record<string, WholeMediaType>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * The type a file is sent whole as, or `null` when it is never sent whole: a PDF, or one of the
 * four image types a model reads. As for `readableKind`, only a type that says nothing falls back
 * to the extension.
 */
export function wholeMediaType(mimeType: string, name: string): WholeMediaType | null {
  const mime = lower(mimeType).split(";")[0]?.trim() ?? "";
  if (mime === "application/pdf") return "application/pdf";
  const image = WHOLE_IMAGE_MIMES[mime];
  if (image !== undefined) return image;
  if (!BLUNT_MIMES.has(mime)) return null;
  const ext = extensionOf(name);
  return ext === "pdf" ? "application/pdf" : (WHOLE_IMAGE_EXTENSIONS[ext] ?? null);
}

/**
 * Whether the bytes start as their type says. A provider refuses the whole turn for a file that is
 * not what its type claims, so a mislabeled attachment is caught here and not sent.
 */
export function bytesMatchType(bytes: Uint8Array, mediaType: WholeMediaType): boolean {
  const starts = (...b: number[]) => b.every((v, i) => bytes[i] === v);
  const ascii = (at: number, s: string) =>
    [...s].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  switch (mediaType) {
    case "application/pdf":
      return ascii(0, "%PDF-");
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
  }
}

/**
 * Whether these files may go in one turn (ADR 0090, rule 4): `null` when they may, else why not.
 * The tool server keeps to the budget as it goes; this is the last check before the bytes leave.
 */
export function wholeFilesProblem(
  files: readonly { readonly mediaType: WholeMediaType; readonly bytes: Uint8Array }[],
): string | null {
  if (files.length > MAX_WHOLE_FILES) return "Too many files for one turn.";
  let total = 0;
  for (const f of files) {
    total += f.bytes.length;
    if (f.bytes.length === 0) return "A file is empty.";
    if (f.mediaType !== "application/pdf" && f.bytes.length > MAX_WHOLE_IMAGE_BYTES) {
      return "An image is too large.";
    }
    if (!bytesMatchType(f.bytes, f.mediaType)) return "A file is not what its type says.";
  }
  return total > MAX_WHOLE_BYTES ? "The files are too large for one turn." : null;
}

/**
 * How a read ended. `ok`: the text is here. `no_text`: a PDF with no text layer, probably a scan.
 * `unsupported`: a kind we do not read. `too_big`: over the cap. `failed`: anything else.
 */
export type FileTextState = "ok" | "no_text" | "unsupported" | "too_big" | "failed";

/** What is kept in `attachment_text`: only what holds for as long as the file does. */
export interface KeptFileText {
  readonly text: string;
  readonly pages: number | null;
  readonly state: "ok" | "no_text";
  readonly extractedMs: number;
}

/** The answer to a read of one file. `reason` says why when the state is not `ok`. */
export interface FileTextAnswer {
  readonly state: FileTextState;
  readonly text: string;
  readonly pages: number | null;
  readonly reason: string;
}

/** What the file work thread returns: never `unsupported` or `too_big` by type, only by size on disk. */
export interface ExtractedText {
  readonly state: "ok" | "no_text" | "too_big" | "failed";
  readonly text: string;
  readonly pages: number | null;
  readonly reason: string;
}

export type ReadableKind = "pdf" | "docx" | "text" | "html";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_MIMES = new Set(["text/plain", "text/csv", "text/calendar"]);
const BLUNT_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

const lower = (s: string) => s.trim().toLowerCase();
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : lower(name.slice(dot + 1));
};

/**
 * What kind of file this is for reading, or `null` when its text is not read (ADR 0087, rule 3).
 * The type the sender's client wrote decides; only a type that says nothing (a blunt
 * `application/octet-stream`) falls back to the file's extension.
 */
export function readableKind(mimeType: string, name: string): ReadableKind | null {
  const mime = lower(mimeType).split(";")[0]?.trim() ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime === DOCX_MIME) return "docx";
  if (TEXT_MIMES.has(mime)) return "text";
  if (mime === "text/html") return "html";
  if (!BLUNT_MIMES.has(mime)) return null;
  switch (extensionOf(name)) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "txt":
    case "csv":
    case "ics":
      return "text";
    default:
      return null;
  }
}

/** The text as the model gets it: the first `max` characters and a line saying what was left out. */
export function capFileText(text: string, max: number = MAX_FILE_TEXT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let end = max;
  const last = trimmed.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  const left = trimmed.length - end;
  return `${trimmed.slice(0, end).trimEnd()}\n[... ${left} more characters of this file left out ...]`;
}

const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    const lowerBody = body.toLowerCase();
    if (lowerBody[0] !== "#") return NAMED[lowerBody] ?? whole;
    const code =
      lowerBody[1] === "x" ? Number.parseInt(lowerBody.slice(2), 16) : Number(lowerBody.slice(1));
    return Number.isInteger(code) &&
      code > 0 &&
      code <= 0x10ffff &&
      !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : whole;
  });
}

// The attributes of a `<w:t>` stop at a `<` too (well-formed XML has none in a tag), so a run of
// unclosed `<w:t ` tags is read once and not again from each of them.
const RUN = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;

/**
 * The paragraphs of a Word document's `word/document.xml` as lines of text (ADR 0087, rule 3):
 * the words of each `<w:t>` inside a `<w:p>`, a tab for `<w:tab/>`, a line break for `<w:br/>`,
 * with the XML entities decoded. No XML parser runs on the file, so nothing in it is expanded.
 */
export function docxXmlToText(xml: string): string {
  const lines: string[] = [];
  for (const paragraph of xml.split("</w:p>")) {
    let line = "";
    for (const m of paragraph.matchAll(RUN)) {
      if (m[1] !== undefined) line += decodeEntities(m[1]);
      else if (m[0].startsWith("<w:tab")) line += "\t";
      else line += "\n";
    }
    lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- The files of a thread, as the loop numbers them (ADR 0087, rule 1) ---

/** One file of a thread, with the position `read_file` takes. */
export interface ThreadFile {
  /** 1-based among the thread's non-inline attachments, oldest message first. */
  readonly position: number;
  readonly messageKey: number;
  readonly partId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

/** The thread's files in a fixed order: by message, then as the message lists them. Inline parts are never here. */
export function threadFiles(view: {
  readonly messages: readonly { readonly key: number }[];
  readonly attachments: ReadonlyMap<number, MessageAttachments>;
}): ThreadFile[] {
  const files: ThreadFile[] = [];
  for (const m of view.messages) {
    for (const item of view.attachments.get(m.key)?.items ?? []) {
      if (item.inline) continue;
      files.push({
        position: files.length + 1,
        messageKey: m.key,
        partId: item.partId,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
      });
    }
  }
  return files;
}

/** `PDF, 1.2 MB` for a listing; the type is a word, not a MIME string. */
export function describeFile(file: Pick<ThreadFile, "mimeType" | "name" | "size">): string {
  const kind = readableKind(file.mimeType, file.name);
  const mime = lower(file.mimeType).split(";")[0]?.trim() ?? "";
  const word =
    kind === "pdf"
      ? "PDF"
      : kind === "docx"
        ? "Word"
        : kind === "text" || kind === "html"
          ? "text"
          : mime === ""
            ? "file"
            : mime.slice(0, 40);
  return `${word}, ${sizeWord(file.size)}`;
}

function sizeWord(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
