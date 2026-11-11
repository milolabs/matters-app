import {
  type FailureDetail,
  hostRule,
  type MailErrorKind,
  refusalFromWording,
  type SignInRefusal,
  serverSentence,
  soundsTemporary,
  tlsProblemOf,
} from "@matters/core";

/**
 * The server refused the user name or password. `detail.refusal` says why, as far as the answer
 * told (ADR 0114); `detail.serverText` is the server's sentence for showing, kept out of the
 * message, which travels to logs.
 */
export class ImapAuthError extends Error {
  readonly kind = "auth";
  readonly host: string;
  readonly user: string;
  readonly detail: FailureDetail;
  constructor(host: string, user: string, detail: FailureDetail = {}, note?: string) {
    const refusal = detail.refusal ?? "unknown";
    super(
      `IMAP authentication failed for ${user} on ${host} (${refusal})${note ? `: ${note}` : ""}`,
    );
    this.name = "ImapAuthError";
    this.host = host;
    this.user = user;
    this.detail = { ...detail, refusal };
  }
}

/** RFC 5530 response codes that say why a LOGIN or AUTHENTICATE failed. */
const IMAP_CODES: Readonly<Record<string, SignInRefusal>> = {
  AUTHENTICATIONFAILED: "credentials",
  AUTHORIZATIONFAILED: "notAllowed",
  CONTACTADMIN: "notAllowed",
  EXPIRED: "expired",
  PRIVACYREQUIRED: "encryptionRequired",
  UNAVAILABLE: "unavailable",
  LIMIT: "throttled",
};

/**
 * Why an IMAP server refused the sign-in, from its answer: a provider's specific wording first,
 * then the response code, then a temporary-sounding text. On a host that takes browser sign-in
 * only, every refusal but a temporary one means that, whatever it says ("LOGIN failed.").
 */
export function imapRefusal(host: string, code: string | undefined, text: string): SignInRefusal {
  const bracket = /\[([A-Z-]+)[\] ]/.exec(text)?.[1];
  const said =
    refusalFromWording(text) ??
    IMAP_CODES[(code ?? bracket ?? "").toUpperCase()] ??
    (soundsTemporary(text) ? "unavailable" : "unknown");
  if (hostRule(host)?.signIn === "browserOnly" && said !== "unavailable" && said !== "throttled") {
    return "browserOnly";
  }
  return said;
}

/** The `ImapAuthError` for a refused LOGIN or AUTHENTICATE, without any secret. */
export function refusedSignIn(
  host: string,
  user: string,
  answer: { readonly code?: string; readonly text?: string },
  secrets: readonly string[],
): ImapAuthError {
  const text = answer.text ?? "";
  const serverText = serverSentence(text, { secrets, user });
  return new ImapAuthError(host, user, {
    refusal: imapRefusal(host, answer.code, text),
    ...(serverText === undefined ? {} : { serverText }),
  });
}

export class ImapConnectionError extends Error {
  readonly code: string | undefined;
  readonly kind: MailErrorKind;
  readonly detail?: FailureDetail;
  constructor(message: string, code?: string, kind: MailErrorKind = "other") {
    super(message);
    this.name = "ImapConnectionError";
    this.code = code;
    this.kind = kind;
  }
}

/**
 * The certificate was rejected, the handshake failed, or the server offers no STARTTLS.
 * `detail.tls` says which (ADR 0114).
 */
export class ImapTlsError extends ImapConnectionError {
  override readonly detail: FailureDetail;
  constructor(message: string, code?: string) {
    super(message, code, "tls");
    this.name = "ImapTlsError";
    this.detail = { tls: tlsProblemOf(code, message) };
  }
}

/** Nothing answered: wrong host or port, no network, a timeout, a reset connection. */
export class ImapUnreachableError extends ImapConnectionError {
  constructor(message: string, code?: string) {
    super(message, code, "unreachable");
    this.name = "ImapUnreachableError";
  }
}

/** A plaintext connection was asked for and `MATTERS_ALLOW_INSECURE_IMAP=1` is not set. */
export class ImapInsecureTransportError extends ImapConnectionError {
  constructor(host: string, port: number) {
    super(
      `Refusing a connection to ${host}:${port} without TLS. Use TLS (port 993) or STARTTLS.`,
      undefined,
      "insecure",
    );
    this.name = "ImapInsecureTransportError";
  }
}

const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|HOSTNAME_MISMATCH|EPROTO|STARTTLS)/;
const TLS_TEXT = /certificate|self[- ]signed|handshake|ssl|tls|starttls/i;
const NETWORK_CODE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ETIMEOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "NoConnection",
]);
const NETWORK_TEXT = /timeout|timed out|connection (closed|not available)|socket/i;

/**
 * Text of an error with every secret removed. Nothing from the original error is kept but its
 * text and code; the class says what went wrong in terms a user can act on.
 */
export function safeError(error: unknown, secrets: readonly string[]): ImapConnectionError {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join("***");
  }
  const raw = (error as { code?: unknown; tlsFailed?: unknown } | null) ?? {};
  const code = typeof raw.code === "string" ? raw.code : undefined;
  if (raw.tlsFailed === true || (code !== undefined && TLS_CODE.test(code))) {
    return new ImapTlsError(message, code);
  }
  if (code !== undefined && NETWORK_CODE.has(code)) return new ImapUnreachableError(message, code);
  if (code === undefined && TLS_TEXT.test(message)) return new ImapTlsError(message);
  if (NETWORK_TEXT.test(message)) return new ImapUnreachableError(message, code);
  return new ImapConnectionError(message, code);
}
