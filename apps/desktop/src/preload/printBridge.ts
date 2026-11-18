// Printing the open thread, or saving it as a PDF (ADR 0144). Like the other bridges it exposes
// nothing: the page posts the thread it built and an action, the preload checks their shape and
// asks main, which checks them again, and main's answer is read before the page sees it. The page
// also says whether a single thread is open, for the menu's items, and hears when the menu asks.
import type { PrintAction } from "@matters/contracts";
import {
  CHANNEL_PRINT,
  CHANNEL_PRINT_AVAILABLE,
  isPrintAction,
  readPrintAnswer,
  readPrintDocument,
} from "../main/printShapes.ts";

export interface PrintBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface PrintMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const requestIdOf = (ask: Record<string, unknown>) =>
  typeof ask.requestId === "string" && ask.requestId.length <= 100 ? ask.requestId : null;

export function createPrintBridge(deps: PrintBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: PrintMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      if ("mattersPrintAvailable" in data) {
        deps.send(CHANNEL_PRINT_AVAILABLE, data.mattersPrintAvailable === true);
        return;
      }
      const ask = data.mattersPrint;
      if (!isRecord(ask)) return;
      const requestId = requestIdOf(ask);
      if (requestId === null) return;
      const doc = readPrintDocument(ask.doc);
      if (!isPrintAction(ask.action) || doc === null) {
        deps.post({ mattersPrintAnswer: { requestId, answer: { kind: "failed" } } });
        return;
      }
      deps
        .invoke(CHANNEL_PRINT, ask.action, doc)
        .then(readPrintAnswer, () => readPrintAnswer(null))
        .then((answer) => deps.post({ mattersPrintAnswer: { requestId, answer } }));
    },
    /** Main's push on `CHANNEL_PRINT_ASK`: the menu's Print… or Save as PDF…. */
    ask(action: unknown): void {
      if (isPrintAction(action)) deps.post({ mattersPrintAsk: action satisfies PrintAction });
    },
  };
}
