// What crosses between the mail window and main about printing (ADR 0144). The preload checks the
// shape of the page's ask and main checks it again; the answer is read before the page sees it.
// Nothing here is a rule about mail: only types and lengths, so a page cannot hand main a value
// of another shape or an unbounded one.
import type { PrintAction, PrintAnswer } from "@matters/contracts";

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

// The thread's own shape is read in contracts, so the print page reads it with the same function
// (ADR 0144, rule 4): the page's bundle may not import from here.
export { MAX_PRINT_LETTERS, readPrintDocument } from "@matters/contracts";

export function isPrintAction(v: unknown): v is PrintAction {
  return v === "print" || v === "pdf";
}

/** Main's answer as it crosses to the page; anything else reads as a failure. */
export function readPrintAnswer(v: unknown): PrintAnswer {
  if (!isRecord(v)) return { kind: "failed" };
  return v.kind === "done" || v.kind === "cancelled" || v.kind === "busy"
    ? { kind: v.kind }
    : { kind: "failed" };
}
