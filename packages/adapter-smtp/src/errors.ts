import {
  type FailureDetail,
  hostRule,
  refusalFromWording,
  type SignInRefusal,
  serverSentence,
  soundsTemporary,
  tlsProblemOf,
} from "@matters/core";

/** Failure to build a message; never contains secrets. */
export class SmtpComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpComposeError";
  }
}

/** Reply codes that say why AUTH failed by themselves (RFC 4954). */
const REPLY_CODES: Readonly<Record<number, SignInRefusal>> = {
  535: "credentials",
  530: "encryptionRequired",
  538: "encryptionRequired",
  454: "unavailable",
};

/** Enhanced status codes (RFC 3463, RFC 4954) that say why, ahead of the reply code. */
const ENHANCED_CODES: Readonly<Record<string, SignInRefusal>> = {
  "5.7.8": "credentials",
  "5.7.11": "encryptionRequired",
  "4.7.0": "unavailable",
};

/** How the refused AUTH was made: with a password, or with a browser sign-in's token. */
export type SmtpLogin = "password" | "token";

/**
 * Why an SMTP server refused AUTH, from its answer (ADR 0114): a provider's wording first, then
 * the enhanced status code, then the reply code. On a host that takes browser sign-in only,
 * every refusal of a password but a temporary one means that. A token there is browser sign-in
 * (ADR 0133, rule 10): a provider's sentence that names a reason still wins (*SmtpClient
 * Authentication is disabled for the Tenant*), and a bare refusal means sending this way is not
 * allowed for the mailbox (`notAllowed`), since the vault hands out only a token that does not
 * end within minutes.
 */
export function smtpRefusal(
  host: string,
  responseCode: number | undefined,
  response: string,
  login: SmtpLogin = "password",
): SignInRefusal {
  const enhanced = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(response)?.[1];
  const said =
    refusalFromWording(response) ??
    (enhanced === undefined ? undefined : ENHANCED_CODES[enhanced]) ??
    (responseCode === undefined ? undefined : REPLY_CODES[responseCode]) ??
    (soundsTemporary(response) ? "unavailable" : "unknown");
  if (hostRule(host)?.signIn !== "browserOnly") return said;
  if (said === "unavailable" || said === "throttled") return said;
  if (login === "password") return "browserOnly";
  return said === "credentials" || said === "unknown" || said === "browserOnly"
    ? "notAllowed"
    : said;
}

/** What a failed connect or AUTH told, for `OutgoingCheck.detail`; never contains a secret. */
export function smtpFailureDetail(
  kind: "auth" | "tls" | "unreachable" | "other",
  host: string,
  user: string,
  error: {
    code?: string;
    originalCode?: string;
    responseCode?: number;
    response?: string;
    message?: string;
  },
  secrets: readonly string[],
  login: SmtpLogin = "password",
): FailureDetail | undefined {
  if (kind === "tls") {
    return { tls: tlsProblemOf(error.originalCode ?? error.code, error.message ?? "") };
  }
  if (kind !== "auth") return undefined;
  const response = typeof error.response === "string" ? error.response : "";
  const serverText = serverSentence(response, { secrets, user });
  return {
    refusal: smtpRefusal(host, error.responseCode, response, login),
    ...(serverText === undefined ? {} : { serverText }),
  };
}
