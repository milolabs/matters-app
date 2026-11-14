import { createHash } from "node:crypto";
import {
  type FailureDetail,
  type MailErrorKind,
  type SignInRefusal,
  scrubSecrets,
  serverSentence,
} from "@matters/core";

/**
 * Graph turned the token or the mailbox away (ADR 0136, rule 11). `detail.refusal` says why:
 * `signInAgain` for a token refused a second time, `notAllowed` for a `403`, `throttled` or
 * `unavailable` for a `429` or `503` that lasted longer than the adapter waits. `detail.serverText`
 * is Graph's own sentence for showing, kept out of the message, which travels to logs.
 */
export class GraphAuthError extends Error {
  readonly kind = "auth";
  readonly status: number;
  readonly detail: FailureDetail;
  /** For `throttled` and `unavailable`: how long Graph asked to wait, when it said. */
  readonly retryAfterMs?: number;
  constructor(status: number, refusal: SignInRefusal, serverText?: string, retryAfterMs?: number) {
    super(`Microsoft Graph refused the request (${status}, ${refusal})`);
    this.name = "GraphAuthError";
    this.status = status;
    this.detail = { refusal, ...(serverText === undefined ? {} : { serverText }) };
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Any other trouble with a request. `status` is Graph's answer; absent when none came. */
export class GraphRequestError extends Error {
  readonly kind: MailErrorKind;
  readonly status?: number;
  /** Graph's `error.code`, a fixed word that never holds a secret. */
  readonly code?: string;
  constructor(message: string, kind: MailErrorKind = "other", status?: number, code?: string) {
    super(message);
    this.name = "GraphRequestError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/** Graph could not be reached, or the connection broke: retried as any lost connection. */
export class GraphUnreachableError extends GraphRequestError {
  constructor(message: string) {
    super(message, "unreachable");
    this.name = "GraphUnreachableError";
  }
}

/**
 * The first `401` for a token (ADR 0136, rule 11): not yet a refused sign-in. It is retried as a
 * failed request is, and the retry asks the vault for the credential again; the second refusal
 * (see `RefusedTokens`) is `GraphAuthError` with `signInAgain`.
 */
export class GraphTokenRefusedError extends GraphRequestError {
  constructor() {
    super("Microsoft Graph did not take the token; the sign-in is asked for again", "other", 401);
    this.name = "GraphTokenRefusedError";
  }
}

/** Graph answered with a link to somewhere other than itself (rule 12): it is not followed. */
export class GraphLinkError extends GraphRequestError {
  constructor() {
    super("Microsoft Graph returned a link to another address; it was not followed");
    this.name = "GraphLinkError";
  }
}

/** Graph's error body: `{ "error": { "code", "message" } }`. */
export interface GraphErrorBody {
  readonly code?: string;
  readonly message?: string;
}

export function errorBodyOf(body: unknown): GraphErrorBody {
  const error = (body as { error?: unknown } | null)?.error;
  if (error === null || typeof error !== "object") return {};
  const { code, message } = error as Record<string, unknown>;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

/** Graph's sentence, cleaned for showing (ADR 0114), without the token. */
export function graphSentence(body: GraphErrorBody, secrets: readonly string[]) {
  return body.message === undefined ? undefined : serverSentence(body.message, { secrets });
}

/** An error code is a word; anything else is not repeated. */
export function safeCode(code: string | undefined): string | undefined {
  return code !== undefined && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : undefined;
}

const REMEMBERED = 64;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A short list of hashes, the oldest dropped first. */
function remember(list: string[], hash: string): void {
  if (list.includes(hash)) return;
  list.push(hash);
  if (list.length > REMEMBERED) list.shift();
}

/**
 * Tokens Graph refused (rule 11), kept as hashes, never as tokens. Share one between the
 * connector, the submitter and the backend's reader of the vault, so that all count the same
 * refusals:
 *
 * - the first `401` for a token marks it (`refused` answers false: the request fails, to be
 *   retried);
 * - the backend sees the mark (`wasRefused`), asks the vault for a renewed token, and notes that
 *   one as the retry (`renewedAfterRefusal`);
 * - a `401` for the retry is the second refusal (`refused` answers true: `signInAgain`).
 *
 * With `renewedByVault` (the backend renews), another `401` for a token already marked comes from
 * work that still held it while the retry was being fetched, and is retried again: only the
 * renewed token's refusal ends the sign-in. Without it nothing renews, and a second `401` for the
 * same token is the second refusal.
 */
export class RefusedTokens {
  private readonly hashes: string[] = [];
  private readonly retries: string[] = [];
  private readonly renewedByVault: boolean;

  constructor(options: { readonly renewedByVault?: boolean } = {}) {
    this.renewedByVault = options.renewedByVault ?? false;
  }

  /** Notes the refusal; true when it is the second: the token was the retry, or refused before. */
  refused(token: string): boolean {
    const hash = hashOf(token);
    if (this.retries.includes(hash)) return true;
    if (this.hashes.includes(hash)) return !this.renewedByVault;
    remember(this.hashes, hash);
    return false;
  }

  /** Whether Graph refused this token, and no retry was handed out as it: renew it first. */
  wasRefused(token: string): boolean {
    const hash = hashOf(token);
    return this.hashes.includes(hash) && !this.retries.includes(hash);
  }

  /**
   * The token the vault handed out in place of a refused one: its first `401` is the second. The
   * same token again (the vault had nothing to renew with) counts the same.
   */
  renewedAfterRefusal(token: string): void {
    remember(this.retries, hashOf(token));
  }
}

/** Text of any error with the token removed. */
export function scrubbed(error: unknown, secrets: readonly string[]): string {
  return scrubSecrets(error instanceof Error ? error.message : String(error), secrets);
}
