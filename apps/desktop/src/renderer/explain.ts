import { hostRule, type SignInRefusal, type SyncStatus, type TlsProblem } from "@matters/core";
import { BackendError } from "./client.ts";

export interface FailureContext {
  readonly host: string;
  readonly port: number;
  readonly smtpHost?: string;
  /** Where the sentence is read; setup by default. */
  readonly place?: Exclude<RefusalPlace, "status">;
}

const GENERIC_REFUSAL =
  "The server refused the sign-in. Check the password. Many hosts want an app password, or IMAP turned on in their settings, and some use other servers for business accounts: see their help pages.";

/**
 * Where a refusal's sentence is read, which changes its next step:
 * - `setup`: adding the account; the server settings are above and can be changed.
 * - `newPassword`: the form that mends a saved password (ADR 0113); only the password changes.
 * - `status`: an account the sync could not sign in to, in its row of Settings › Accounts; it
 *   is tried again with *Sync now*, or by itself when the refusal is temporary.
 */
export type RefusalPlace = "setup" | "newPassword" | "status";

/**
 * One sentence per reason the server gave for refusing (ADR 0114); `host` picks a known rule.
 * The only place these sentences are written: setup, the password form and the account's row
 * all read them here.
 */
export function refusalSentence(
  refusal: SignInRefusal | undefined,
  host: string,
  place: RefusalPlace = "setup",
): string {
  const rule = hostRule(host);
  const setup = place === "setup";
  const saved = place === "status";
  /** The way to try again after doing what the sentence asks. */
  const retry = saved ? "then choose Sync now" : setup ? "then try again here" : "then try again";
  switch (refusal) {
    case "credentials": {
      const lead = saved
        ? "The server refused the saved password."
        : place === "newPassword"
          ? "The server says this password is wrong."
          : "The server says the user name or password is wrong.";
      if (rule?.signIn === "appPassword") {
        return `${lead} ${rule.name} wants ${appPasswordOf(rule.term)} here, not your ${rule.account ?? rule.name} password.`;
      }
      if (rule?.signIn === "turnOnImap") {
        return `${lead} ${rule.name} also turns mail apps away until IMAP access is on in its webmail settings.`;
      }
      return setup
        ? `${lead} Check both. With two-factor sign-in, most hosts want an app password here.`
        : `${lead} With two-factor sign-in, most hosts want an app password here.`;
    }
    case "appPassword": {
      const then = setup ? "then enter it here." : "then enter it as the new password.";
      return rule?.signIn === "appPassword"
        ? `${rule.name} wants ${appPasswordOf(rule.term)}, not your ${rule.account ?? rule.name} password. ${rule.steps ?? `Create one in your account's security settings, ${then}`}`
        : `The server wants an app password, not your account password. Create one in your account's security settings, ${then}`;
    }
    case "webLogin":
      return `The server wants you to sign in on its website once first, usually to confirm it's you. Do that in a browser, ${retry}.`;
    case "imapOff":
      return `IMAP is turned off for this mailbox. Turn it on in your webmail's settings, ${saved ? "then choose Sync now" : "then try again"}.`;
    case "browserOnly":
      return `${rule?.signIn === "browserOnly" ? rule.name : "This server"} takes only browser sign-in from mail apps, which Matters can't do yet. A password won't work there.`;
    case "notAllowed":
      return `The server knows you, but won't let this mailbox in this way. Ask whoever runs your mail to allow IMAP for it${saved ? ", then choose Sync now" : ""}.`;
    case "expired":
      return setup
        ? "The server says your password has expired. Change it in your webmail, then enter the new one here."
        : "The server says the password has expired. Change it in your webmail, then enter the new one as the new password.";
    case "encryptionRequired":
      return setup
        ? "The server won't take a password over this connection. Choose TLS in the settings above, then try again."
        : "The server won't take a password over this connection. Remove the account and add it again with TLS.";
    case "unavailable":
      return saved
        ? "The server couldn't check the password just now. That's on its side; Matters tries again by itself in a few minutes."
        : "The server couldn't check the password just now. That's on its side; try again in a few minutes.";
    case "throttled":
      return saved
        ? "The server is turning sign-ins away for now, after too many tries. Matters waits, then tries again by itself, slowly."
        : "The server is turning sign-ins away for now, after too many tries. Wait a few minutes, then try again.";
    default:
      return setup
        ? GENERIC_REFUSAL
        : `${saved ? "The server refused the saved password." : "The server refused this password."} Many hosts want an app password, or IMAP turned on in their settings: see their help pages.`;
  }
}

/** What was wrong with the secure connection, in a sentence; ports differ for sending. */
export function tlsSentence(problem: TlsProblem | undefined, protocol: "imap" | "smtp"): string {
  switch (problem) {
    case "expired":
      return "Its certificate has expired, so Matters can't be sure it's the real server. Whoever runs it needs to renew it.";
    case "nameMismatch":
      return "Its certificate is for a different name. Check the server name; your host's help pages list the right one.";
    case "selfSigned":
      return "Its certificate is self-signed, so Matters can't be sure it's the real server.";
    case "untrusted":
      return "Its certificate isn't from an authority this Mac trusts, so Matters can't be sure it's the real server.";
    case "noEncryption":
      return protocol === "imap"
        ? "It offers no encryption on this port. TLS is usually port 993, STARTTLS port 143."
        : "It offers no encryption on this port. TLS is usually port 465, STARTTLS port 587.";
    default:
      return "The secure handshake failed.";
  }
}

/** The sentences under a failed attempt, specific to what went wrong. */
export function explainFailure(error: unknown, context: FailureContext): string {
  if (!(error instanceof BackendError)) return "Something went wrong. Try again.";
  const { host, port } = context;
  const outgoing = context.smtpHost || "the outgoing server";
  const detail = error.detail;
  switch (error.code) {
    case "authFailed":
      return refusalSentence(detail?.refusal, host, context.place);
    case "tlsFailed":
      return `Could not make a secure connection to ${host}:${port}. ${tlsSentence(detail?.tls, "imap")}`;
    case "unreachable":
      return `Could not reach ${host}:${port}. Check the server name, the port and your internet connection.`;
    case "insecureTransport":
      return "Matters does not connect without encryption. Choose TLS or STARTTLS.";
    case "credentialsUnavailable":
      return `The password cannot be saved safely on this computer. ${error.message}`;
    case "accountExists":
      return "This address is already added.";
    case "outgoingAuthFailed":
      return outgoingRefusal(detail?.refusal, outgoing, context.smtpHost ?? "");
    case "outgoingFailed":
      return detail?.tls === undefined
        ? `Receiving works, but ${outgoing} didn't answer properly. Check it in the settings above, or add the account without sending for now.`
        : `Receiving works, but the secure connection to ${outgoing} failed. ${tlsSentence(detail.tls, "smtp")} Check it in the settings above, or add the account without sending for now.`;
    case "invalidAccount":
    case "invalidRequest":
      return error.message;
    default:
      return "Adding the account failed in a way Matters didn't expect. Check the server settings above, then try again.";
  }
}

/**
 * The evidence under the sentence, shown smaller: the server's own words when it refused the
 * sign-in, the raw error when the sentence had to stay general. None when the sentence is all.
 */
export function failureEvidence(error: unknown): string | undefined {
  if (!(error instanceof BackendError)) return undefined;
  switch (error.code) {
    case "authFailed":
    case "outgoingAuthFailed": {
      const said = error.detail?.serverText;
      return said ? `The server said: “${said}”` : undefined;
    }
    case "tlsFailed":
    case "outgoingFailed":
    case "internal":
      return error.message.trim() === "" ? undefined : `Details: ${error.message.trim()}`;
    default:
      return undefined;
  }
}

/**
 * What an account's row says when the sync could not sign in (ADR 0113, 0114): the reason's
 * sentence with its next step, and the server's own words under it. None for other states.
 */
export function signInTrouble(
  status: SyncStatus,
  host: string,
): { readonly sentence: string; readonly evidence?: string } | undefined {
  if (status.state !== "error" || status.kind !== "auth") return undefined;
  const said = status.detail?.serverText;
  return {
    sentence: refusalSentence(status.detail?.refusal, host, "status"),
    ...(said ? { evidence: `The server said: “${said}”` } : {}),
  };
}

/** The line under the password field, before anything was tried. */
export function passwordHint(host: string): string {
  const rule = hostRule(host);
  switch (rule?.signIn) {
    case "appPassword":
      return `${rule.name} needs ${appPasswordOf(rule.term)}, not your ${rule.account ?? rule.name} password. ${rule.steps ?? "Create one in your account's security settings."}`;
    case "turnOnImap":
      return `${rule.name} lets mail apps in only once that's switched on. Turn on IMAP access in its webmail settings first, then enter your usual password here.`;
    case "browserOnly":
      return `${rule.name} takes only browser sign-in from mail apps, which Matters can't do yet. A password won't work there.`;
    default:
      return "Your mailbox password. With two-factor sign-in, most hosts want an app password here.";
  }
}

function outgoingRefusal(
  refusal: SignInRefusal | undefined,
  outgoing: string,
  smtpHost: string,
): string {
  const without = "Or add the account without sending for now.";
  switch (refusal) {
    case "browserOnly":
      return `Receiving works, but ${outgoing} takes only browser sign-in for sending, which Matters can't do yet. Add the account without sending for now.`;
    case "notAllowed":
      return `Receiving works, but ${outgoing} doesn't allow sending with a password for this mailbox. Whoever runs your mail can turn that on. ${without}`;
    case "appPassword":
    case "webLogin":
    case "expired":
    case "encryptionRequired":
    case "unavailable":
    case "throttled":
      return `Receiving works, but ${outgoing} refused the same login. ${refusalSentence(refusal, smtpHost)} ${without}`;
    default:
      return `Receiving works, but ${outgoing} refused the same login, so sending wouldn't. Check the user name in the settings above, or add the account without sending for now.`;
  }
}

const appPasswordOf = (term: string | undefined) => `an ${term ?? "app password"}`;
