// The page's way to open, preview and save a received file, as messages (ADR 0043, rules 10 and
// 16). Like the file bridge it exposes nothing: the page posts a request naming a file by message
// key and part id, the preload checks the shape and asks main, and the answer comes back as a
// message. There is no path in either direction.
import type { ReceivedAction, ReceivedAnswer } from "@matters/contracts";

export const CHANNEL_RECEIVED = "matters:received";

const ACTIONS: readonly string[] = [
  "open",
  "preview",
  "save",
  "saveAll",
] satisfies ReceivedAction[];

export interface ReceivedBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface ReceivedMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** What the page is told when main cannot be asked or says nothing it understands. */
const failed: ReceivedAnswer = { kind: "failed" };

export function createReceivedBridge(deps: ReceivedBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: ReceivedMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersReceived;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      if (typeof ask.action !== "string" || !ACTIONS.includes(ask.action)) {
        deps.post({ mattersReceivedAnswer: { requestId, answer: failed } });
        return;
      }
      // Main validates the key, the part and the items again; the page's values go through as given.
      deps
        .invoke(CHANNEL_RECEIVED, ask.action, ask.messageKey, ask.partId, ask.name, ask.items)
        .then(
          (answer) => (isRecord(answer) && typeof answer.kind === "string" ? answer : failed),
          () => failed,
        )
        .then((answer) => deps.post({ mattersReceivedAnswer: { requestId, answer } }));
    },
  };
}
