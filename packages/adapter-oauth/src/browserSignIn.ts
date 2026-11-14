import type {
  BrowserSignInPort,
  BrowserSignInRequest,
  BrowserSignInResult,
  OAuthProvider,
  TokenRenewal,
  TokenRenewalPort,
} from "@matters/core";
import { renewalFailureOf, signInFailureOf } from "./errors.ts";
import { listenForRedirect, REDIRECT_TIMEOUT_MS, type Schedule } from "./loopback.ts";
import { challengeOf, createState, createVerifier } from "./pkce.ts";
import { loopbackAuthority, PROVIDERS, type ProviderEntry } from "./providers.ts";
import { addressesOf, postToken, sameAccount } from "./tokens.ts";

export interface BrowserOAuthOptions {
  /**
   * The application's client id per provider (rule 4). A public client's id is no secret; a
   * provider without one is not offered.
   */
  readonly clientIds: Readonly<Partial<Record<OAuthProvider, string>>>;
  /**
   * Opens the person's own browser at the URL (rule 1): in the app, Electron's
   * `shell.openExternal`, never a window of the app. Rejects when it could not.
   */
  readonly openBrowser: (url: string) => Promise<void>;
  /**
   * Tests only: a stand-in authorization server in place of every provider's authority. Only a
   * loopback http address is taken; anything else throws here (rule 13).
   */
  readonly authority?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Timers for the 5-minute wait; tests pass a manual clock's. */
  readonly schedule?: Schedule;
  readonly timeoutMs?: number;
}

/** The authorization request for one sign-in (rule 1). */
export function authorizeUrl(
  provider: ProviderEntry,
  authority: string,
  request: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
    readonly loginHint: string;
  },
): string {
  const url = new URL(`${authority}${provider.authorizePath}`);
  const params: Record<string, string> = {
    client_id: request.clientId,
    response_type: "code",
    redirect_uri: request.redirectUri,
    response_mode: "query",
    scope: provider.scopes.join(" "),
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
    login_hint: request.loginHint,
    ...provider.authorizeParams,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Browser sign-in and token renewal over OAuth 2.0 with PKCE (ADR 0133, rules 1 to 3, 7, 12 and
 * 13): `node:crypto`, `node:http` and `fetch`, no library. It runs in main. One sign-in at a
 * time: starting one ends the one before, which answers `notFinished`. Codes, verifiers and
 * tokens appear in no message and no log; only the result carries the tokens.
 */
export class BrowserOAuth implements BrowserSignInPort, TokenRenewalPort {
  private readonly options: BrowserOAuthOptions;
  private readonly authority: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private current: AbortController | null = null;

  constructor(options: BrowserOAuthOptions) {
    this.options = options;
    this.authority =
      options.authority === undefined ? undefined : loopbackAuthority(options.authority);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  offers(provider: OAuthProvider): boolean {
    return this.clientIdOf(provider) !== undefined;
  }

  async signIn(request: BrowserSignInRequest): Promise<BrowserSignInResult> {
    const provider = PROVIDERS[request.provider];
    const clientId = this.clientIdOf(request.provider);
    if (provider === undefined || clientId === undefined)
      return { ok: false, reason: "notOffered" };

    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const signal =
      request.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, request.signal]);
    try {
      return await this.run(provider, clientId, request.address, signal);
    } finally {
      if (this.current === controller) this.current = null;
    }
  }

  /** Ends the sign-in that is waiting, if any (the window that asked closed, rule 2). */
  cancel(): void {
    this.current?.abort();
  }

  async renew(provider: OAuthProvider, refreshToken: string): Promise<TokenRenewal> {
    const entry = PROVIDERS[provider];
    const clientId = this.clientIdOf(provider);
    if (entry === undefined || clientId === undefined) {
      return { ok: false, failure: "other", reason: "No client id for this provider" };
    }
    const answer = await postToken(
      this.fetchFn,
      this.tokenUrl(entry),
      {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: entry.scopes.join(" "),
      },
      this.now,
    );
    if (!answer.ok) return renewalFailureOf(answer);
    return {
      ok: true,
      tokens: {
        accessToken: answer.accessToken,
        expiresAtMs: answer.expiresAtMs,
        ...(answer.refreshToken === undefined ? {} : { refreshToken: answer.refreshToken }),
      },
    };
  }

  private async run(
    provider: ProviderEntry,
    clientId: string,
    address: string,
    signal: AbortSignal,
  ): Promise<BrowserSignInResult> {
    const verifier = createVerifier();
    const state = createState();
    const listener = await listenForRedirect({
      state,
      signal,
      timeoutMs: this.options.timeoutMs ?? REDIRECT_TIMEOUT_MS,
      ...(this.options.schedule === undefined ? {} : { schedule: this.options.schedule }),
    });
    const url = authorizeUrl(provider, this.authority ?? provider.authority, {
      clientId,
      redirectUri: listener.redirectUri,
      state,
      challenge: challengeOf(verifier),
      loginHint: address.trim(),
    });
    try {
      await this.options.openBrowser(url);
    } catch {
      listener.close();
      return { ok: false, reason: "failed" };
    }

    const answer = await listener.answer;
    if (answer.kind === "ended") return { ok: false, reason: "notFinished" };
    if (answer.kind === "error") return signInFailureOf(answer.error, answer.description);

    const tokens = await postToken(
      this.fetchFn,
      this.tokenUrl(provider),
      {
        client_id: clientId,
        grant_type: "authorization_code",
        code: answer.code,
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
        scope: provider.scopes.join(" "),
      },
      this.now,
      signal,
    );
    if (signal.aborted) return { ok: false, reason: "notFinished" };
    if (!tokens.ok) {
      if (tokens.kind === "unreachable") return { ok: false, reason: "unreachable" };
      if (tokens.kind === "badAnswer") return { ok: false, reason: "failed" };
      return signInFailureOf(tokens.error, tokens.description, tokens.codes);
    }
    // Without a refresh token the account would stop working within the hour.
    if (tokens.refreshToken === undefined) return { ok: false, reason: "failed" };

    const signedIn = addressesOf(tokens.idToken);
    const first = signedIn[0];
    if (first === undefined) return { ok: false, reason: "failed" };
    // Another account than the one typed: nothing is kept (rule 3).
    if (!sameAccount(address, signedIn)) {
      return { ok: false, reason: "wrongAccount", signedIn: first, asked: address.trim() };
    }
    return {
      ok: true,
      provider: provider.id,
      address: first,
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresAtMs,
      },
    };
  }

  private clientIdOf(provider: OAuthProvider): string | undefined {
    const id = this.options.clientIds[provider]?.trim();
    return id === undefined || id === "" ? undefined : id;
  }

  private tokenUrl(provider: ProviderEntry): string {
    return `${this.authority ?? provider.authority}${provider.tokenPath}`;
  }
}
