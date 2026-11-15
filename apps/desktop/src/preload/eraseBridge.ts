// The erase window (ADR 0138, rule 11) asks main for the state of the erase and for one of its
// buttons; main tells it each step as it happens. Like the other bridges it exposes nothing: the
// page posts a request, the preload checks its shape and asks main, which answers only that window.

export const CHANNEL_ERASE = "matters:erase";
export const CHANNEL_ERASE_PROGRESS = "matters:erase-progress";

export type EraseAction =
  | "state"
  | "retry"
  | "startAgain"
  | "leave"
  | "quit"
  | "keychain"
  | "show"
  | "microsoftWork"
  | "microsoftPersonal"
  | "pages";
const ACTIONS: readonly string[] = [
  "state",
  "retry",
  "startAgain",
  "leave",
  "quit",
  "keychain",
  "show",
  "microsoftWork",
  "microsoftPersonal",
  "pages",
] satisfies EraseAction[];

export interface EraseBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function createEraseBridge(deps: EraseBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: { readonly source: unknown; readonly data: unknown }): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersErase;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      if (typeof ask.action !== "string" || !ACTIONS.includes(ask.action)) {
        deps.post({ mattersEraseAnswer: { requestId, answer: null } });
        return;
      }
      deps
        .invoke(CHANNEL_ERASE, ask.action)
        .then(
          (answer) => (isRecord(answer) ? answer : null),
          () => null,
        )
        .then((answer) => deps.post({ mattersEraseAnswer: { requestId, answer } }));
    },
    /** A step from main, passed on as it came: kinds and sizes only. */
    progress(data: unknown): void {
      if (isRecord(data)) deps.post({ mattersEraseProgress: data });
    },
  };
}
