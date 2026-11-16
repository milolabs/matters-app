// Saving the open thread's letters as files (ADR 0145). Like the other bridges it exposes nothing:
// the page posts the letters (keys, subjects, dates) or a stop, the preload checks their shape and
// asks main, which checks them again and shows the dialog; main's answer and its progress are read
// before the page sees them. No path crosses in either direction.
import { CHANNEL_EML, readEmlAnswer, readEmlLetters, readEmlProgress } from "../main/emlShapes.ts";

export interface EmlBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface EmlMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function createEmlBridge(deps: EmlBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: EmlMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersEml;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      if (ask.action === "stop") {
        void deps.invoke(CHANNEL_EML, "stop").catch(() => {});
        deps.post({ mattersEmlAnswer: { requestId, answer: { kind: "cancelled" } } });
        return;
      }
      const letters = ask.action === "save" ? readEmlLetters(ask.letters) : null;
      if (letters === null) {
        deps.post({ mattersEmlAnswer: { requestId, answer: { kind: "invalid" } } });
        return;
      }
      deps
        .invoke(CHANNEL_EML, "save", letters)
        .then(readEmlAnswer, () => readEmlAnswer(null))
        .then((answer) => deps.post({ mattersEmlAnswer: { requestId, answer } }));
    },
    /** Main's push on `CHANNEL_EML_ASK`: the menu's Save as .eml…. */
    ask(): void {
      deps.post({ mattersEmlAsk: true });
    },
    /** Main's push on `CHANNEL_EML_PROGRESS`. */
    progress(value: unknown): void {
      deps.post({ mattersEmlProgress: value === null ? null : readEmlProgress(value) });
    },
  };
}
