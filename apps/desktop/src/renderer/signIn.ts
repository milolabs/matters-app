// Browser sign-in, the page's side (ADR 0133). The page asks main, through the preload, whether a
// provider's sign-in is offered, to start one, and to cancel it. What comes back is the handle of
// what main holds and the address that signed in, or why there is nothing: never a token.
import type { BrowserSignInAnswer } from "@matters/contracts";
import {
  type BrowserSignInFailure,
  browserSignInProvider,
  type DiscoveredServers,
  type OAuthProvider,
  takesPassword,
} from "@matters/core";
import { createSignal } from "solid-js";

/** What the page can ask of main about browser sign-in. */
export interface SignInClient {
  /** Whether this build can offer the provider's sign-in (rule 4: it has a client id). */
  offered(provider: OAuthProvider): Promise<boolean>;
  /** Opens the browser and waits for the answer (rules 1 to 3). */
  start(provider: OAuthProvider, address: string): Promise<BrowserSignInAnswer>;
  /** Ends the sign-in this window started, which then answers `notFinished`. */
  cancel(): Promise<void>;
}

let counter = 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Asks main through the preload; null when main did not answer. */
function ask(
  action: "offered" | "start" | "cancel",
  provider?: OAuthProvider,
  address?: string,
): Promise<Record<string, unknown> | null> {
  const requestId = `s${++counter}`;
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.source !== window || !isRecord(data)) return;
      const body = data.mattersSignInAnswer;
      if (!isRecord(body) || body.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      resolve(isRecord(body.answer) ? body.answer : null);
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        mattersSignIn: {
          requestId,
          action,
          ...(provider === undefined ? {} : { provider }),
          ...(address === undefined ? {} : { address }),
        },
      },
      "*",
    );
  });
}

/** The answer of a start, checked: anything that is not a handle and an address is a failure. */
export function readAnswer(answer: Record<string, unknown> | null): BrowserSignInAnswer {
  if (answer === null) return { ok: false, reason: "failed" };
  if (answer.ok === true) {
    return typeof answer.handle === "string" && typeof answer.address === "string"
      ? { ok: true, handle: answer.handle, address: answer.address }
      : { ok: false, reason: "failed" };
  }
  const text = typeof answer.providerText === "string" ? answer.providerText : undefined;
  switch (answer.reason) {
    case "notFinished":
    case "unreachable":
    case "notOffered":
      return { ok: false, reason: answer.reason };
    case "wrongAccount":
      return typeof answer.signedIn === "string" && typeof answer.asked === "string"
        ? { ok: false, reason: "wrongAccount", signedIn: answer.signedIn, asked: answer.asked }
        : { ok: false, reason: "failed" };
    case "adminApproval":
      return { ok: false, reason: "adminApproval", ...(text ? { providerText: text } : {}) };
    default:
      return { ok: false, reason: "failed", ...(text ? { providerText: text } : {}) };
  }
}

/** Main's answers, over the window's messages. */
export const mainSignIn: SignInClient = {
  offered: async (provider) => (await ask("offered", provider))?.offered === true,
  start: async (provider, address) => readAnswer(await ask("start", provider, address)),
  cancel: async () => {
    await ask("cancel");
  },
};

/** The provider's name as the screens say it. */
export function providerName(provider: OAuthProvider): string {
  switch (provider) {
    // Both entries are Microsoft's to the person (ADR 0136, rule 3).
    case "microsoft":
    case "microsoftGraph":
      return "Microsoft";
  }
}

/**
 * One plain sentence per reason a browser sign-in gave nothing (rule 12); the provider's own
 * words go under it (`signInFailureEvidence`).
 */
export function signInFailureSentence(
  failure: BrowserSignInFailure,
  provider: OAuthProvider,
): string {
  const name = providerName(provider);
  switch (failure.reason) {
    case "notFinished":
      return "The sign-in was not finished. Try again when you're ready.";
    case "adminApproval":
      return "Your organisation has to approve Matters before you can sign in. Ask an administrator of your organisation to approve it, then try again.";
    case "wrongAccount":
      return `You signed in as ${failure.signedIn}, not ${failure.asked}. Nothing was saved. Try again and choose ${failure.asked}.`;
    case "unreachable":
      return `${name} couldn't be reached to finish the sign-in. Check your internet connection, then try again.`;
    case "notOffered":
      return `Sign-in with ${name} isn't set up in this copy of Matters.`;
    case "failed":
      return `${name} didn't finish the sign-in. Try again.`;
  }
}

/** The provider's own description, as the quote under the sentence (ADR 0114, rule 3). */
export function signInFailureEvidence(
  failure: BrowserSignInFailure,
  provider: OAuthProvider,
): string | undefined {
  const said = "providerText" in failure ? failure.providerText : undefined;
  return said ? `${providerName(provider)} said: “${said}”` : undefined;
}

/**
 * Which step of setup the servers found lead to: a password, the provider's sign-in in the
 * browser (ADR 0133, rule 11), or the screen that says neither works.
 */
export function setupStepFor(
  servers: DiscoveredServers,
  offered: (provider: OAuthProvider) => boolean,
): "password" | "browser" | "blocked" {
  const provider = browserSignInProvider(servers);
  if (provider !== undefined && offered(provider)) return "browser";
  return takesPassword(servers) ? "password" : "blocked";
}

export type SignInPhase = "idle" | "browser" | "checking";

/**
 * The state of one browser sign-in on a screen: waiting in the browser, then checking the
 * servers with what came back. `use` does the backend's part with the handle (adding the account,
 * or signing in again) and throws when that fails; `explain` says why in a sentence and a quote.
 * Cancelling while the browser is open ends the sign-in and says nothing.
 */
export function createBrowserSignIn(client: SignInClient) {
  const [phase, setPhase] = createSignal<SignInPhase>("idle");
  const [failure, setFailure] = createSignal("");
  const [evidence, setEvidence] = createSignal("");
  let cancelled = false;

  function clear() {
    setFailure("");
    setEvidence("");
  }

  /** True when the backend took the sign-in. */
  async function run(
    provider: OAuthProvider,
    address: string,
    use: (handle: string) => Promise<void>,
    explain: (error: unknown) => { readonly sentence: string; readonly evidence?: string },
  ): Promise<boolean> {
    if (phase() !== "idle") return false;
    clear();
    cancelled = false;
    setPhase("browser");
    const answer = await client.start(provider, address);
    if (!answer.ok) {
      if (!cancelled) {
        setFailure(signInFailureSentence(answer, provider));
        setEvidence(signInFailureEvidence(answer, provider) ?? "");
      }
      setPhase("idle");
      return false;
    }
    setPhase("checking");
    try {
      await use(answer.handle);
      return true;
    } catch (error) {
      const why = explain(error);
      setFailure(why.sentence);
      setEvidence(why.evidence ?? "");
      return false;
    } finally {
      setPhase("idle");
    }
  }

  return {
    phase,
    failure,
    evidence,
    clear,
    run,
    /** The person cancelled, or the screen went away while the browser was open. */
    cancel(): void {
      if (phase() !== "browser") return;
      cancelled = true;
      void client.cancel();
    },
  };
}

export type BrowserSignIn = ReturnType<typeof createBrowserSignIn>;
