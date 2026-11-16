// The mail window's side of printing (ADR 0144): the thread open in the reader made into a print
// document, from the same sanitized HTML and the same image decisions the reader uses, and handed
// to main; the print page sanitizes each letter again before it shows it (rule 4). What the reader
// decided while a letter is open (Show images, the Text view) is kept here by message key, so a
// print made from the menu prints what is on screen.
import type { PrintAction, PrintAnswer, PrintDocument, ThreadMessage } from "@matters/contracts";
import type { Backend } from "./client.ts";
import { askPrint } from "./files.ts";
import { printDocument, printLetter } from "./printDocument.ts";

const imagesShown = new Set<number>();
const textViews = new Set<number>();

/** The reader pressed Show images for this message, or the choice went with the letter. */
export function noteImagesShown(key: number, shown: boolean): void {
  if (shown) imagesShown.add(key);
  else imagesShown.delete(key);
}

/** The reader shows this message's Text view instead of the original. */
export function noteTextView(key: number, text: boolean): void {
  if (text) textViews.add(key);
  else textViews.delete(key);
}

/** The letters of the thread, every one, in the reader's order (ADR 0144, rule 2). */
export async function buildPrintDocument(
  subject: string,
  messages: readonly ThreadMessage[],
  own: ReadonlySet<string>,
  backend: Pick<Backend, "getMessageHtml">,
): Promise<PrintDocument> {
  const { sanitizeMail } = await import("./mailHtml.ts");
  const letters = await Promise.all(
    messages.map(async (m) => {
      if (m.htmlKind === undefined || textViews.has(m.key)) return printLetter(m, own, null);
      const { html, images } = await backend.getMessageHtml(m.key);
      if (html === null) return printLetter(m, own, null);
      // Sanitized here first, on the reader's screen: a style sheet's questions about the screen
      // (its resolution, its colors) are answered by the one the reader is on (rule 3), which the
      // hidden print window is not.
      return printLetter(m, own, {
        html: sanitizeMail(html).html,
        images: imagesShown.has(m.key) || images?.show === true,
        choice: images,
      });
    }),
  );
  return printDocument(subject, messages, letters);
}

let inFlight: Promise<PrintAnswer> | null = null;

/** The print or save in progress, for the corpus run (ADR 0047); null when none is. */
export const printInFlight = () => inFlight;

/** Builds the document and asks main; a failure to build is a failure to print. */
export function printThread(
  action: PrintAction,
  subject: string,
  messages: readonly ThreadMessage[],
  own: ReadonlySet<string>,
  backend: Pick<Backend, "getMessageHtml">,
): Promise<PrintAnswer> {
  if (inFlight) return Promise.resolve({ kind: "busy" });
  const run = buildPrintDocument(subject, messages, own, backend)
    .then((doc) => askPrint(action, doc))
    .catch((): PrintAnswer => ({ kind: "failed" }))
    .finally(() => {
      inFlight = null;
    });
  inFlight = run;
  return run;
}

/** The one phrase a failure says (ADR 0144, rule 6); nothing for done, cancelled or busy. */
export function printFailureText(action: PrintAction, answer: PrintAnswer): string {
  if (answer.kind !== "failed") return "";
  return action === "pdf" ? "The PDF could not be saved." : "The thread could not be printed.";
}
