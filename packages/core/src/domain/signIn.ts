/**
 * Why a mail server turned a sign-in or a secure connection away, as a small closed set the
 * screens can say something specific about (ADR 0114). Adapters decide it from the server's own
 * answer: IMAP response codes (RFC 5530), SMTP reply and enhanced status codes (RFC 4954, 3463),
 * and a few provider wordings. Logic only ever looks at these values, never at the server's text.
 *
 * - `credentials`: the user name or password is wrong (`AUTHENTICATIONFAILED`, SMTP 535 / 5.7.8).
 * - `appPassword`: the server wants an app password, not the account password.
 * - `webLogin`: the server wants one sign-in on its website first, usually a security check.
 * - `imapOff`: IMAP is switched off for the mailbox.
 * - `browserOnly`: the server takes no password from mail apps, only browser sign-in.
 * - `notAllowed`: the server knows the person but will not let the mailbox in this way
 *   (`AUTHORIZATIONFAILED`, `CONTACTADMIN`, a tenant or admin policy).
 * - `expired`: the password has expired (`EXPIRED`).
 * - `encryptionRequired`: no password over this connection (`PRIVACYREQUIRED`, SMTP 530 / 538).
 * - `unavailable`: the server could not check just now (`UNAVAILABLE`, SMTP 454).
 * - `throttled`: too many attempts or connections for now (`LIMIT`, provider wordings).
 * - `unknown`: nothing above could be told from the answer.
 */
export type SignInRefusal =
  | "credentials"
  | "appPassword"
  | "webLogin"
  | "imapOff"
  | "browserOnly"
  | "notAllowed"
  | "expired"
  | "encryptionRequired"
  | "unavailable"
  | "throttled"
  | "unknown";

const REFUSALS: ReadonlySet<string> = new Set<SignInRefusal>([
  "credentials",
  "appPassword",
  "webLogin",
  "imapOff",
  "browserOnly",
  "notAllowed",
  "expired",
  "encryptionRequired",
  "unavailable",
  "throttled",
  "unknown",
]);

/**
 * Why a secure connection failed.
 * - `expired`: the certificate has expired.
 * - `nameMismatch`: the certificate is for another name.
 * - `selfSigned`: the certificate is self-signed.
 * - `untrusted`: it is signed by an authority this computer does not trust.
 * - `noEncryption`: the server offers no encryption on this port (plaintext where TLS was
 *   expected, or no STARTTLS).
 * - `other`: the handshake failed some other way.
 */
export type TlsProblem =
  | "expired"
  | "nameMismatch"
  | "selfSigned"
  | "untrusted"
  | "noEncryption"
  | "other";

const TLS_PROBLEMS: ReadonlySet<string> = new Set<TlsProblem>([
  "expired",
  "nameMismatch",
  "selfSigned",
  "untrusted",
  "noEncryption",
  "other",
]);

/**
 * What an adapter could tell about a failure, carried next to the error's kind. `serverText` is
 * the server's own sentence, cleaned by `serverSentence`: for showing as a quote, never for logic
 * and never for logs, which is why it is kept out of every error message.
 */
export interface FailureDetail {
  readonly refusal?: SignInRefusal;
  readonly tls?: TlsProblem;
  readonly serverText?: string;
}

/** The `detail` an adapter's error carries, checked against the closed sets. */
export function failureDetailOf(error: unknown): FailureDetail | undefined {
  const raw = (error as { detail?: unknown } | null)?.detail;
  if (raw === null || typeof raw !== "object") return undefined;
  const { refusal, tls, serverText } = raw as Record<string, unknown>;
  const out: { refusal?: SignInRefusal; tls?: TlsProblem; serverText?: string } = {};
  if (typeof refusal === "string" && REFUSALS.has(refusal)) out.refusal = refusal as SignInRefusal;
  if (typeof tls === "string" && TLS_PROBLEMS.has(tls)) out.tls = tls as TlsProblem;
  if (typeof serverText === "string" && serverText !== "") {
    out.serverText = serverText.slice(0, SERVER_TEXT_MAX);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Provider wordings that name the reason whatever the protocol code says; checked before the
 * codes, since a server often sends a generic code with a specific sentence (Gmail answers an
 * account that needs an app password with `[ALERT] Application-specific password required`).
 */
const WORDINGS: readonly (readonly [RegExp, SignInRefusal])[] = [
  [/application[- ]specific password|\bapp[- ]?passwords?\b/i, "appPassword"],
  [
    /web ?login required|\bWEBALERT\b|(log|sign) ?in (via|with|using) (your |a )?(web )?browser/i,
    "webLogin",
  ],
  [
    /BasicAuthBlocked|basic auth(entication)? (is )?(disabled|blocked|not supported|turned off)/i,
    "browserOnly",
  ],
  [
    /SmtpClientAuthentication is disabled|disabled for the tenant|User is authenticated but not connected/i,
    "notAllowed",
  ],
  [
    /\bIMAP\b[^.]{0,40}\b(disabled|not enabled|not allowed|turned off|switched off|is off)\b|not enabled for IMAP|\b(enable|turn on|switch on|activate)\b[^.]{0,30}\bIMAP\b/i,
    "imapOff",
  ],
  [/password (has |is )?expired|expired password/i, "expired"],
  [
    /too many (failed |login |authentication |sign[- ]?in |simultaneous |concurrent )?(attempts|logins|failures|connections)/i,
    "throttled",
  ],
];

/** The reason a provider's own sentence names, if it names one. */
export function refusalFromWording(text: string): SignInRefusal | undefined {
  for (const [pattern, refusal] of WORDINGS) if (pattern.test(text)) return refusal;
  return undefined;
}

/** A temporary failure as servers word it, after the codes said nothing. */
export function soundsTemporary(text: string): boolean {
  return /temporar(y|ily)|try again later|service unavailable/i.test(text);
}

const NO_ENCRYPTION =
  /wrong version number|packet length too long|unknown protocol|http request|does not support STARTTLS|STARTTLS is not possible|not offer(ing)? STARTTLS/i;

/** The certificate or handshake problem in a TLS error's code and text (Node's codes). */
export function tlsProblemOf(code: string | undefined, message: string): TlsProblem {
  const c = code ?? "";
  if (c === "CERT_HAS_EXPIRED" || /certificate has expired/i.test(message)) return "expired";
  if (
    c === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    c === "HOSTNAME_MISMATCH" ||
    /altnames|does not match certificate/i.test(message)
  ) {
    return "nameMismatch";
  }
  if (
    c === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    c === "SELF_SIGNED_CERT_IN_CHAIN" ||
    /self[- ]signed/i.test(message)
  ) {
    return "selfSigned";
  }
  if (
    /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_UNTRUSTED|CERT_SIGNATURE_FAILURE)$/.test(
      c,
    ) ||
    /unable to (verify|get (local )?issuer)/i.test(message)
  ) {
    return "untrusted";
  }
  if (c === "ERR_SSL_WRONG_VERSION_NUMBER" || NO_ENCRYPTION.test(message)) return "noEncryption";
  return "other";
}

/** Longest server sentence kept; enough for any provider's explanation, short enough to show. */
export const SERVER_TEXT_MAX = 200;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const URL_WITH_QUERY = /<?\bhttps?:\/\/[^\s<>]*[?#][^\s<>]*>?/gi;

/**
 * The server's own sentence, fit to show as a quote: the protocol prefix (IMAP tag and status,
 * SMTP reply and enhanced codes, a leading `[CODE ...]`) is cut, every secret and every address
 * but `user` is replaced, links with a query (which may carry a sign-in token) are dropped,
 * control characters go, and it is capped at `SERVER_TEXT_MAX`. Undefined when nothing is left.
 */
export function serverSentence(
  raw: string,
  keep: { readonly secrets: readonly string[]; readonly user?: string },
): string | undefined {
  let text = raw;
  for (const secret of keep.secrets) {
    if (secret.length > 0) text = text.split(secret).join("***");
  }
  text = text
    .split(/\r?\n/)
    .map((line) =>
      line
        // SMTP: `535-5.7.8 ` / `535 5.7.8 `
        .replace(/^\s*\d{3}[ -](\d\.\d{1,3}\.\d{1,3}\s+)?/, "")
        // IMAP: `A2 NO ` and a leading response code with its arguments
        .replace(/^\s*(\S+\s+)?(NO|BAD|BYE)\s+/, "")
        .replace(/^\s*\[[^\]]*\]\s*/, ""),
    )
    .join(" ")
    .replace(URL_WITH_QUERY, "")
    .replace(EMAIL, (found) =>
      keep.user !== undefined && found.toLowerCase() === keep.user.toLowerCase() ? found : "…",
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\(Failure\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  return text.length > SERVER_TEXT_MAX ? `${text.slice(0, SERVER_TEXT_MAX - 1).trimEnd()}…` : text;
}

/**
 * Refusals on the server's side, for now (`unavailable`, `throttled`): a later try can pass
 * without anyone acting, so the sync tries again on its slow schedule and the password is not
 * marked refused (ADR 0113, as amended).
 */
export function refusalIsTemporary(refusal: SignInRefusal | undefined): boolean {
  return refusal === "unavailable" || refusal === "throttled";
}

/**
 * Refusals a new password can end: a wrong or revoked one (`credentials`), one that must be an
 * app password (`appPassword`), one that expired (`expired`, changed on the host first), and a
 * refusal nothing could be told about (`unknown`, or no reason at all), which is most often a
 * wrong password. The others want something done elsewhere (webmail, an admin, the server
 * settings) or cannot be fixed by any password (`browserOnly`).
 */
export function newPasswordCanFix(refusal: SignInRefusal | undefined): boolean {
  return (
    refusal === undefined ||
    refusal === "credentials" ||
    refusal === "appPassword" ||
    refusal === "expired" ||
    refusal === "unknown"
  );
}
