// Printing the open thread, or saving it as a PDF (ADR 0144, rules 4 to 6). Main makes a hidden
// window of the print page only when asked, hands it the thread, waits until the page says it is
// laid out, then shows the system's print dialog or writes the PDF where the person chose, and
// destroys the window in every case. One job at a time. The window, the dialog and the file are
// behind `PrinterDeps`, so a test drives all of it without Electron or a printer.

import type { PrintAction, PrintAnswer, PrintDocument } from "@matters/contracts";
import { pdfFileName } from "@matters/core";

export type Paper = "A4" | "Letter";

/** A paper's width in inches. */
const PAPER_WIDTH_IN: Readonly<Record<Paper, number>> = { A4: 8.2677, Letter: 8.5 };
/** The PDF's margins, in inches, on every side: about 15 mm. */
export const PDF_MARGIN_IN = 0.6;

/**
 * Countries where Letter is the usual paper (the Americas that use it, and the Philippines);
 * everywhere else A4. From the system's region, `app.getLocaleCountryCode()`.
 */
const LETTER_COUNTRIES = new Set([
  "US",
  "CA",
  "MX",
  "CL",
  "CO",
  "CR",
  "DO",
  "GT",
  "PA",
  "PH",
  "PR",
  "SV",
  "VE",
]);

export function paperFor(country: string): Paper {
  return LETTER_COUNTRIES.has(country.toUpperCase()) ? "Letter" : "A4";
}

/**
 * The width the print page lays the thread out at, in CSS pixels: the paper's width less the
 * margins. Every frame keeps this width when printed, so what was measured is what is printed.
 */
export function printWidthPx(paper: Paper): number {
  return Math.floor((PAPER_WIDTH_IN[paper] - 2 * PDF_MARGIN_IN) * 96);
}

/** What the page said once the thread was laid out. */
export interface PrintReady {
  readonly ok: boolean;
  /** Something in a message ran in the print page; only a corpus run's payloads can say so. */
  readonly scriptRan: boolean;
}

/** The hidden window of the print page, as the printer uses it. */
export interface PrintWindow {
  /** Loads the print page and hands it the thread; resolves with what the page said. */
  render(doc: PrintDocument, widthPx: number, timeoutMs: number): Promise<PrintReady>;
  /** The system's print dialog for this window: true once printed, false when cancelled. */
  print(): Promise<boolean>;
  printToPDF(paper: Paper): Promise<Uint8Array>;
  /** Also when it is already gone. */
  destroy(): void;
}

export interface PrinterDeps {
  /** A new hidden window of the print page, with the mail window's walls (ADR 0024). */
  open(): PrintWindow;
  /** The system's save dialog; undefined when cancelled. */
  chooseSavePath(defaultName: string): Promise<string | undefined>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  paper(): Paper;
  /** A corpus run hears what the page said (ADR 0047). */
  onReady?(action: PrintAction, ready: PrintReady, path: string | undefined): void;
  log(message: string, error?: unknown): void;
}

/** A thread that has not been laid out by then has failed. */
export const PRINT_READY_TIMEOUT_MS = 30_000;

export function createPrinter(deps: PrinterDeps) {
  let busy = false;

  async function job(action: PrintAction, doc: PrintDocument): Promise<PrintAnswer> {
    // The file's place first: a cancelled save makes no window at all.
    let path: string | undefined;
    if (action === "pdf") {
      path = await deps.chooseSavePath(pdfFileName(doc.title, doc.day));
      if (path === undefined) return { kind: "cancelled" };
    }
    const paper = deps.paper();
    const win = deps.open();
    try {
      const ready = await win.render(doc, printWidthPx(paper), PRINT_READY_TIMEOUT_MS);
      deps.onReady?.(action, ready, path);
      if (!ready.ok) return { kind: "failed" };
      if (action === "print") return (await win.print()) ? { kind: "done" } : { kind: "cancelled" };
      const bytes = await win.printToPDF(paper);
      // Written only where the person chose; the dialog asked before replacing a file.
      await deps.writeFile(path as string, bytes);
      return { kind: "done" };
    } finally {
      win.destroy();
    }
  }

  return {
    /** Prints or saves `doc`; a second ask while one runs is answered `busy` and does nothing. */
    async run(action: PrintAction, doc: PrintDocument): Promise<PrintAnswer> {
      if (busy) return { kind: "busy" };
      busy = true;
      try {
        return await job(action, doc);
      } catch (error) {
        deps.log(action === "pdf" ? "could not save the PDF" : "could not print", error);
        return { kind: "failed" };
      } finally {
        busy = false;
      }
    },
    busy: () => busy,
  };
}

export type Printer = ReturnType<typeof createPrinter>;
