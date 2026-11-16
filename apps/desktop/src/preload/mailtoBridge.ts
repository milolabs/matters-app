// `mailto:` links and the default mail app (ADR 0143). The mail window may take the next link that
// waits, when it can show a composer, and hears when one arrived; Settings › About may read whether
// Matters is the default mail app and ask main to make it so. Like the other bridges it exposes
// nothing: the page posts a request, the preload checks its shape and asks main, which validates
// again, and main's answer is read before the page sees it. No link crosses from the page: main
// alone hears them, from macOS, a second start, or a click in a message it was told of.
import { readDefaultMailInfo, readMailtoPrefill } from "../main/mailtoShapes.ts";

/** Page to main: the next link that waits, or null. */
export const CHANNEL_MAILTO_TAKE = "matters:mailto-take";
/** Main to the mail window: a link waits. */
export const CHANNEL_MAILTO_WAITING = "matters:mailto-waiting";
/** Page to main: `get`, or `make` (the person pressed the button). */
export const CHANNEL_DEFAULT_MAIL = "matters:default-mail";

export interface MailtoBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface MailtoMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const requestIdOf = (ask: Record<string, unknown>) =>
  typeof ask.requestId === "string" && ask.requestId.length <= 100 ? ask.requestId : null;

export function createMailtoBridge(deps: MailtoBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: MailtoMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const take = data.mattersMailtoTake;
      if (isRecord(take)) {
        const requestId = requestIdOf(take);
        if (requestId === null) return;
        deps
          .invoke(CHANNEL_MAILTO_TAKE)
          .then(readMailtoPrefill, () => null)
          .then((answer) => deps.post({ mattersMailtoAnswer: { requestId, answer } }));
        return;
      }
      const ask = data.mattersDefaultMail;
      if (!isRecord(ask)) return;
      const requestId = requestIdOf(ask);
      if (requestId === null) return;
      if (ask.action !== "get" && ask.action !== "make") {
        deps.post({ mattersDefaultMailAnswer: { requestId, answer: null } });
        return;
      }
      deps
        .invoke(CHANNEL_DEFAULT_MAIL, ask.action)
        .then(readDefaultMailInfo, () => null)
        .then((answer) => deps.post({ mattersDefaultMailAnswer: { requestId, answer } }));
    },
    /** Main's push on `CHANNEL_MAILTO_WAITING`. */
    waiting(): void {
      deps.post({ mattersMailtoWaiting: true });
    },
  };
}
