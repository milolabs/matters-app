// Browser sign-in, main's side (ADR 0133). Main is the only process that opens the browser and
// the only one that ever holds a token: a page asks for a sign-in and gets back the handle of what
// main holds and the address that signed in, or why there is nothing (rules 5 and 6).
import type { BrowserSignInAnswer } from "@matters/contracts";
import {
  type BrowserSignInPort,
  type BrowserSignInRequest,
  isOAuthProvider,
  isPlausibleAddress,
  type OAuthProvider,
} from "@matters/core";

// Replaced by the build with the id in its environment (electron.vite.config.ts); not defined
// where the source runs unbuilt, as in tests.
declare const __MATTERS_MICROSOFT_CLIENT_ID__: string | undefined;

/**
 * The client id of a registration with Microsoft Entra, as the build was given it (ADR 0133,
 * rule 4). It is not in the source: a release gets Matters' own from the release workflow, and a
 * copy built by someone else has none unless they bring their own registration, so a changed
 * copy does not sign people in under Matters' name by default. It is no secret all the same: it
 * is in every released app and in the address of the sign-in page. Empty: browser sign-in is not
 * offered and setup says what it said before.
 *
 * A registration is for accounts in any organisation and personal Microsoft accounts, platform
 * "Mobile and desktop applications", redirect `http://localhost`, with the delegated permissions
 * IMAP.AccessAsUser.All and SMTP.Send, and Graph's Mail.ReadWrite and Mail.Send (ADR 0136,
 * rule 3).
 */
export const MICROSOFT_CLIENT_ID =
  typeof __MATTERS_MICROSOFT_CLIENT_ID__ === "string" ? __MATTERS_MICROSOFT_CLIENT_ID__ : "";

/**
 * The variable that carries the id: set when building, it is built in; set when the app starts,
 * it replaces what was built in (rule 4).
 */
export const CLIENT_ID_VARIABLE = "MATTERS_MICROSOFT_CLIENT_ID";

/**
 * Window tests of a dev build say "this build has no registration" with this set to `1`, so
 * what they expect of a build without one does not depend on what the build was given (rule 4).
 * A packaged app does not read it.
 */
export const NO_CLIENT_ID_VARIABLE = "MATTERS_TEST_NO_CLIENT_ID";

/**
 * The client id per provider entry: the environment's, else the one built in; empty is none. One
 * registration serves both Microsoft entries, IMAP's and Graph's (ADR 0136, rule 3).
 */
export function clientIds(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly devBuild?: boolean; readonly builtIn?: string } = {},
): Partial<Record<OAuthProvider, string>> {
  if (options.devBuild === true && env[NO_CLIENT_ID_VARIABLE] === "1") return {};
  const builtIn = options.builtIn ?? MICROSOFT_CLIENT_ID;
  const id = (env[CLIENT_ID_VARIABLE] ?? "").trim() || builtIn.trim();
  return id === "" ? {} : { microsoft: id, microsoftGraph: id };
}

/** The longest address a page may ask a sign-in for (RFC 5321's path limit). */
const MAX_ADDRESS = 320;

/** What a page may ask of main about browser sign-in, its arguments checked. */
export type SignInAsk =
  | { readonly action: "offered"; readonly provider: OAuthProvider }
  | { readonly action: "start"; readonly provider: OAuthProvider; readonly address: string }
  | { readonly action: "cancel" };

/** The arguments of one IPC call, checked the way the other handlers check theirs; null: refused. */
export function parseSignInAsk(
  action: unknown,
  provider: unknown,
  address: unknown,
): SignInAsk | null {
  if (action === "cancel") return { action };
  if (!isOAuthProvider(provider)) return null;
  if (action === "offered") return { action, provider };
  if (action !== "start" || typeof address !== "string" || address.length > MAX_ADDRESS)
    return null;
  const trimmed = address.trim();
  return isPlausibleAddress(trimmed) ? { action, provider, address: trimmed } : null;
}

/** What a held sign-in is, as `RenewingCredentialStore.hold` takes it. */
export interface HeldSignIn {
  readonly kind: "oauth2";
  readonly provider: OAuthProvider;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtMs: number;
}

export interface SignInServiceDeps {
  readonly oauth: BrowserSignInPort;
  /** Keeps the tokens in main for their test (rule 6) and returns a random handle. */
  readonly hold: (signIn: HeldSignIn) => string;
  /**
   * The browser gave its answer for this window's sign-in, good or bad: the person is still
   * looking at the browser, so main brings the window back to the front (rule 2). Not called
   * when the sign-in was cancelled or ran out of time.
   */
  readonly returned?: (owner: number) => void;
}

/**
 * One browser sign-in at a time, for the window that asked (rule 2). Starting one ends the one
 * before, which answers `notFinished`; so does the asking window closing or loading another page.
 * The answer carries a handle and an address, never a token.
 */
export class SignInService {
  private readonly deps: SignInServiceDeps;
  private current: { readonly owner: number; readonly controller: AbortController } | null = null;

  constructor(deps: SignInServiceDeps) {
    this.deps = deps;
  }

  offered(provider: OAuthProvider): boolean {
    return this.deps.oauth.offers(provider);
  }

  /** `owner` names the asking window (its webContents id). */
  async start(
    owner: number,
    provider: OAuthProvider,
    address: string,
  ): Promise<BrowserSignInAnswer> {
    this.current?.controller.abort();
    const controller = new AbortController();
    const mine = { owner, controller };
    this.current = mine;
    try {
      const request: BrowserSignInRequest = { provider, address, signal: controller.signal };
      const result = await this.deps.oauth.signIn(request);
      const ended = controller.signal.aborted || (!result.ok && result.reason === "notFinished");
      if (!ended) this.deps.returned?.(owner);
      if (!result.ok) return result;
      // Ended while the token was being fetched: nothing is held for a page that is gone.
      if (controller.signal.aborted) return { ok: false, reason: "notFinished" };
      const handle = this.deps.hold({
        kind: "oauth2",
        provider: result.provider,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresAtMs: result.tokens.expiresAtMs,
      });
      return { ok: true, handle, address: result.address };
    } catch {
      // The port does not throw for the provider's trouble; anything else is said plainly.
      return { ok: false, reason: "failed" };
    } finally {
      if (this.current === mine) this.current = null;
    }
  }

  /** The person cancelled, or the window that asked closed (rule 2). Another window's stays. */
  cancel(owner: number): void {
    if (this.current?.owner === owner) this.current.controller.abort();
  }

  /** Whether a sign-in for this window is waiting. */
  waiting(owner: number): boolean {
    return this.current?.owner === owner;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Whether the URL is plain http on this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Window tests only (ADR 0130): what stands in for the person's browser when the authorization
 * server is a stand-in on this machine. Main takes it only in a dev build and only together with
 * the stand-in's address, which the adapter refuses unless it is loopback (rule 13).
 *
 * - `wait`: opens nothing; the sign-in waits until it is cancelled, as a person who has not
 *   finished in the browser yet.
 * - `follow`: plays the browser: asks the authorization page on the stand-in, and follows its
 *   redirect to main's own loopback listener. Each of the two requests is made only to a loopback
 *   http address, the first only to the stand-in's origin; anything else is not requested.
 *
 * Null for any other mode, or when the authority is not loopback: the real browser is used.
 */
export function testBrowser(
  mode: string | undefined,
  authority: string,
  fetchFn: typeof fetch = fetch,
): ((url: string) => Promise<void>) | null {
  if (!isLoopbackUrl(authority)) return null;
  const origin = new URL(authority).origin;
  if (mode === "wait") return async () => {};
  if (mode !== "follow") return null;
  return async (url) => {
    if (!isLoopbackUrl(url) || new URL(url).origin !== origin) {
      throw new Error("The stand-in browser opens only the stand-in's pages");
    }
    const page = await fetchFn(url, { redirect: "manual" });
    const location = page.headers.get("location");
    await page.text().catch(() => "");
    // No redirect: the person closed the tab, and nothing comes back.
    if (location === null || !isLoopbackUrl(location)) return;
    await fetchFn(location, { redirect: "manual" }).then((r) => r.text().catch(() => ""));
  };
}
