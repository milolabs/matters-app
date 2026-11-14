// Browser sign-in (ADR 0133): setup and Settings › Accounts ask main whether a provider's sign-in
// is offered, to start one, and to cancel it. Like the other bridges it exposes nothing: the page
// posts a request, the preload checks its shape and asks main, which answers only the app's own
// windows. What comes back is a handle and an address, or why there is nothing; never a token.

export const CHANNEL_SIGN_IN = "matters:sign-in";

export type SignInAction = "offered" | "start" | "cancel";
const ACTIONS: readonly string[] = ["offered", "start", "cancel"] satisfies SignInAction[];

export interface SignInBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface SignInMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function createSignInBridge(deps: SignInBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: SignInMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersSignIn;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      const { action, provider, address } = ask;
      if (
        typeof action !== "string" ||
        !ACTIONS.includes(action) ||
        (provider !== undefined && typeof provider !== "string") ||
        (address !== undefined && typeof address !== "string")
      ) {
        deps.post({ mattersSignInAnswer: { requestId, answer: null } });
        return;
      }
      deps
        .invoke(CHANNEL_SIGN_IN, action, provider, address)
        .then(
          (answer) => (isRecord(answer) ? answer : null),
          () => null,
        )
        .then((answer) => deps.post({ mattersSignInAnswer: { requestId, answer } }));
    },
  };
}
