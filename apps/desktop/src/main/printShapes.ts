// What crosses between the mail window and main about printing (ADR 0144). The preload checks the
// shape of the page's ask and main checks it again; the answer is read before the page sees it.
// Nothing here is a rule about mail: only types and lengths, so a page cannot hand main a value
// of another shape or an unbounded one.
import type {
  PrintAction,
  PrintAnswer,
  PrintBody,
  PrintDocument,
  PrintLetter,
  PrintTextPart,
} from "@matters/contracts";

/** Page to main: print or save the thread the page sends. */
export const CHANNEL_PRINT = "matters:print";
/** Page to main: whether one thread is open in the reader, for the menu's items. */
export const CHANNEL_PRINT_AVAILABLE = "matters:print-available";
/** Main to the mail window: the menu asked to print or to save (`PrintAction`). */
export const CHANNEL_PRINT_ASK = "matters:print-ask";
/** Main to the print view: the thread and the width to lay it out at. */
export const CHANNEL_PRINT_DOCUMENT = "matters:print-document";
/** The print view to main: laid out (`PrintReady`). */
export const CHANNEL_PRINT_READY = "matters:print-ready";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A thread longer than this is not printed: the reader would not show it either. */
export const MAX_PRINT_LETTERS = 500;
/** A line of a header (a long Cc) or a title. */
const MAX_LINE = 20_000;
/** The words of one piece of a letter's text. */
const MAX_TEXT = 1_000_000;
const MAX_PARTS = 5_000;
const MAX_FILES = 1_000;
/** One letter's sanitized HTML: the corpus has a 1.5 MB message (ADR 0047). */
const MAX_HTML = 16_000_000;
/** All letters' HTML together. */
const MAX_TOTAL_HTML = 64_000_000;

const isLine = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_LINE;

export function isPrintAction(v: unknown): v is PrintAction {
  return v === "print" || v === "pdf";
}

function readPart(v: unknown): PrintTextPart | null {
  if (!isRecord(v) || typeof v.text !== "string" || v.text.length > MAX_TEXT) return null;
  if (v.kind !== "text" && v.kind !== "signature" && v.kind !== "folded") return null;
  return { kind: v.kind, text: v.text };
}

function readBody(v: unknown): PrintBody | null {
  if (!isRecord(v)) return null;
  if (v.kind === "html") {
    if (typeof v.html !== "string" || v.html.length > MAX_HTML) return null;
    if (typeof v.images !== "boolean") return null;
    return { kind: "html", html: v.html, images: v.images };
  }
  if (v.kind !== "text" || !Array.isArray(v.parts) || v.parts.length > MAX_PARTS) return null;
  const parts = v.parts.map(readPart);
  return parts.every((p) => p !== null) ? { kind: "text", parts: parts as PrintTextPart[] } : null;
}

function readLetter(v: unknown): PrintLetter | null {
  if (!isRecord(v)) return null;
  const { from, to, cc, date, subject, badge, note, attachments } = v;
  if (![from, to, cc, date, subject, badge, note].every(isLine)) return null;
  if (!Array.isArray(attachments) || attachments.length > MAX_FILES) return null;
  if (!attachments.every(isLine)) return null;
  const body = readBody(v.body);
  if (body === null) return null;
  return {
    from: from as string,
    to: to as string,
    cc: cc as string,
    date: date as string,
    subject: subject as string,
    badge: badge as string,
    note: note as string,
    body,
    attachments: [...(attachments as string[])],
  };
}

/** The thread as it crosses from the page; null for anything of another shape or too large. */
export function readPrintDocument(v: unknown): PrintDocument | null {
  if (!isRecord(v) || !isLine(v.title) || typeof v.day !== "string" || v.day.length > 10) {
    return null;
  }
  if (!Array.isArray(v.letters) || v.letters.length === 0) return null;
  if (v.letters.length > MAX_PRINT_LETTERS) return null;
  const letters = v.letters.map(readLetter);
  if (!letters.every((l) => l !== null)) return null;
  let html = 0;
  for (const l of letters as PrintLetter[]) if (l.body.kind === "html") html += l.body.html.length;
  if (html > MAX_TOTAL_HTML) return null;
  return { title: v.title, day: v.day, letters: letters as PrintLetter[] };
}

/** Main's answer as it crosses to the page; anything else reads as a failure. */
export function readPrintAnswer(v: unknown): PrintAnswer {
  if (!isRecord(v)) return { kind: "failed" };
  return v.kind === "done" || v.kind === "cancelled" || v.kind === "busy"
    ? { kind: v.kind }
    : { kind: "failed" };
}
