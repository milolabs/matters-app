import { randomBytes } from "node:crypto";
import type {
  Credential,
  CredentialAvailability,
  CredentialGetOptions,
  CredentialPort,
  MailErrorKind,
  TokenRenewal,
  TokenRenewalPort,
} from "@matters/core";
import { SignInEndedError } from "@matters/core";

/** A browser sign-in's credential, as main keeps it: with its refresh token. */
export type OAuthCredential = Extract<Credential, { readonly kind: "oauth2" }>;

export interface RenewingCredentialStoreOptions {
  /** Where credentials are kept: the encrypted file of ADR 0018. */
  readonly vault: CredentialPort;
  /** The provider's token endpoint; injected, so this package knows no provider. */
  readonly renewal: TokenRenewalPort;
  readonly now?: () => number;
  /** A fresh random handle for a held sign-in; by default of the shape `isSignInHandle` takes. */
  readonly newHandle?: () => string;
  /** How long a sign-in is held for its test (ADR 0133, rule 6). */
  readonly holdMs?: number;
  /** An access token that ends within this is renewed before it is handed out (rule 7). */
  readonly renewWithinMs?: number;
}

export const SIGN_IN_HOLD_MS = 10 * 60_000;
export const RENEW_WITHIN_MS = 5 * 60_000;

/** A renewal failed for a reason other than a refused sign-in. Never holds a token. */
export class TokenRenewalError extends Error {
  readonly kind: MailErrorKind;
  constructor(kind: "unreachable" | "other", message: string) {
    super(message);
    this.name = "TokenRenewalError";
    this.kind = kind;
  }
}

/**
 * The `CredentialPort` main serves to the backend (ADR 0133, rules 5 to 8), over the vault:
 *
 * - A browser sign-in is held in memory under a random handle for 10 minutes (`hold`) until
 *   setup has tested it; `move` then writes it to the account's entry in one atomic write. A
 *   handle past its time holds nothing.
 * - `get` hands out an access token that still works: one that ends within 5 minutes is renewed
 *   first, and what came back (the rotated refresh token too) is saved in one write. Renewals for
 *   one account are joined: callers that come while one runs wait for it.
 * - `get` with `renew` renews now, whenever the token ends: the service refused it (ADR 0136,
 *   rule 11: the vault is asked again once, and it renews). Joined the same way.
 * - `get` never returns the refresh token: it stays in main.
 * - A refused renewal is a refused sign-in with the reason `signInAgain` (rule 8); one that could
 *   not reach the provider is `unreachable`, retried as any other (rule 7).
 */
export class RenewingCredentialStore implements CredentialPort {
  private readonly vault: CredentialPort;
  private readonly renewal: TokenRenewalPort;
  private readonly now: () => number;
  private readonly newHandle: () => string;
  private readonly holdMs: number;
  private readonly renewWithinMs: number;
  private readonly held = new Map<string, { credential: OAuthCredential; untilMs: number }>();
  private readonly renewing = new Map<string, Promise<Credential | null>>();
  /** Bumped by every write to an id, so a renewal that finished late does not undo it. */
  private readonly writes = new Map<string, number>();

  constructor(options: RenewingCredentialStoreOptions) {
    this.vault = options.vault;
    this.renewal = options.renewal;
    this.now = options.now ?? Date.now;
    this.newHandle = options.newHandle ?? (() => `signin-${randomBytes(16).toString("hex")}`);
    this.holdMs = options.holdMs ?? SIGN_IN_HOLD_MS;
    this.renewWithinMs = options.renewWithinMs ?? RENEW_WITHIN_MS;
  }

  /** Holds what a browser sign-in gave until it is tested (rule 6); returns its handle. */
  hold(credential: OAuthCredential): string {
    this.sweep();
    let handle = this.newHandle();
    while (this.held.has(handle)) handle = this.newHandle();
    this.held.set(handle, { credential, untilMs: this.now() + this.holdMs });
    return handle;
  }

  availability(): Promise<CredentialAvailability> {
    return this.vault.availability();
  }

  async get(accountId: string, options: CredentialGetOptions = {}): Promise<Credential | null> {
    const held = this.heldUnder(accountId);
    if (held) return withoutRefreshToken(held);
    const stored = await this.vault.get(accountId);
    if (stored?.kind !== "oauth2") return stored;
    const now = options.renew === true;
    if ((!now && !this.endsSoon(stored)) || stored.refreshToken === undefined) {
      return withoutRefreshToken(stored);
    }
    const renewed = await this.renewJoined(accountId, now);
    return renewed?.kind === "oauth2" ? withoutRefreshToken(renewed) : renewed;
  }

  /**
   * Refuses a browser sign-in without its refresh token: the backend never has one (rule 5), so
   * writing what it sent would throw the stored one away. Tokens come in through `move`.
   */
  async set(accountId: string, credential: Credential): Promise<void> {
    if (this.held.has(accountId)) throw new TokenRenewalError("other", "That id is a held sign-in");
    if (credential.kind === "oauth2" && credential.refreshToken === undefined) {
      throw new TokenRenewalError("other", "A browser sign-in is stored with its refresh token");
    }
    this.wrote(accountId);
    await this.vault.set(accountId, credential);
  }

  async delete(accountId: string): Promise<void> {
    if (this.held.delete(accountId)) return;
    this.wrote(accountId);
    await this.vault.delete(accountId);
  }

  async move(fromId: string, toId: string): Promise<void> {
    if (this.held.has(toId)) throw new TokenRenewalError("other", "That id is a held sign-in");
    const held = this.heldUnder(fromId);
    this.wrote(toId);
    if (held) {
      // The one atomic write of ADR 0018: the entry is the sign-in's, refresh token and all.
      await this.vault.set(toId, held);
      this.held.delete(fromId);
      return;
    }
    // A handle past its time is gone from memory and was never in the vault, whose move then
    // rejects with `SignInEndedError` as for any id that holds nothing.
    this.wrote(fromId);
    await this.vault.move(fromId, toId);
  }

  private heldUnder(id: string): OAuthCredential | undefined {
    const entry = this.held.get(id);
    if (entry === undefined) return undefined;
    if (entry.untilMs <= this.now()) {
      this.held.delete(id);
      return undefined;
    }
    return entry.credential;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.held) if (entry.untilMs <= now) this.held.delete(id);
  }

  private endsSoon(credential: OAuthCredential): boolean {
    return (
      credential.expiresAtMs !== undefined &&
      credential.expiresAtMs - this.now() <= this.renewWithinMs
    );
  }

  private wrote(id: string): void {
    this.writes.set(id, (this.writes.get(id) ?? 0) + 1);
  }

  /** `now`: renew whenever the token ends (the service refused it). */
  private renewJoined(accountId: string, now: boolean): Promise<Credential | null> {
    const running = this.renewing.get(accountId);
    if (running) return running;
    const run = this.renew(accountId, now).finally(() => this.renewing.delete(accountId));
    this.renewing.set(accountId, run);
    return run;
  }

  private async renew(accountId: string, now: boolean): Promise<Credential | null> {
    const seen = this.writes.get(accountId) ?? 0;
    // Read again inside the joined run: a renewal that just finished has written a fresh token,
    // and the refresh token this caller read may already be replaced.
    const stored = await this.vault.get(accountId);
    if (stored?.kind !== "oauth2") return stored;
    if ((!now && !this.endsSoon(stored)) || stored.refreshToken === undefined) return stored;
    const answer = await this.renewal.renew(stored.provider, stored.refreshToken);
    // Removed or replaced while the provider was asked (a Sign in again, rule 11): what was
    // written then stands, and the old refresh token's refusal says nothing about it.
    if ((this.writes.get(accountId) ?? 0) !== seen) return this.vault.get(accountId);
    if (!answer.ok) throw renewalFailure(answer);
    const next: OAuthCredential = {
      ...stored,
      accessToken: answer.tokens.accessToken,
      refreshToken: answer.tokens.refreshToken ?? stored.refreshToken,
      expiresAtMs: answer.tokens.expiresAtMs,
    };
    await this.vault.set(accountId, next);
    return next;
  }
}

function withoutRefreshToken(credential: OAuthCredential): Credential {
  const { refreshToken: _kept, ...rest } = credential;
  return rest;
}

function renewalFailure(answer: Extract<TokenRenewal, { ok: false }>): Error {
  switch (answer.failure) {
    case "signInAgain":
      return new SignInEndedError();
    case "unreachable":
      return new TokenRenewalError(
        "unreachable",
        `The sign-in service could not be reached to renew the sign-in: ${answer.reason}`,
      );
    default:
      return new TokenRenewalError("other", `Renewing the sign-in failed: ${answer.reason}`);
  }
}
