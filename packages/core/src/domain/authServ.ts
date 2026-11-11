// Whose Authentication-Results to believe (ADR 0048, RFC 8601 sections 4.1 and 7.1).

/** Maps a host to its registrable domain, or `undefined` when it has none (ADR 0037). */
type RegistrableOf = (host: string) => string | undefined;

/**
 * Providers whose receiving servers write an authserv-id under another registrable domain than
 * the one the IMAP host sits in. The key is the registrable domain of the account's IMAP host,
 * the value the registrable domain of the authserv-id. Each entry was read in ADR 0048.
 */
export const KNOWN_AUTHSERV_DOMAINS: Readonly<Record<string, string>> = {
  // imap.gmail.com; Gmail and Google Workspace write `mx.google.com`.
  "gmail.com": "google.com",
  // imap.mail.me.com; iCloud writes `dmarc.icloud.com`, `spf.icloud.com` and others.
  "me.com": "icloud.com",
  // imap.fastmail.com; Fastmail's servers are `*.messagingengine.com`.
  "fastmail.com": "messagingengine.com",
};

/**
 * Providers whose header commonly has no authserv-id, keyed like the table above. Their real
 * header cannot be recognised, so a forged one that names a plausible id would be the only one
 * that reads as trusted. For an account there, nothing is trusted.
 */
const NO_AUTHSERV_ID_DOMAINS: ReadonlySet<string> = new Set(["office365.com", "outlook.com"]);

export interface AuthServContext {
  /** The first segment of an `Authentication-Results` header. */
  readonly id: string;
  /** The host of the account's IMAP server. */
  readonly imapHost: string;
  /** The account's own address. */
  readonly address: string;
  readonly registrableDomain: RegistrableOf;
}

function clean(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Is this authserv-id one the account's own receiving server writes? True when its registrable
 * domain is that of the IMAP host or of the account's address, or when the provider table maps
 * the IMAP host's registrable domain to it. Nothing else is trusted: a list that starts empty
 * (RFC 8601 section 7.1). An id with no registrable domain (an IP, a bare suffix) is never trusted.
 */
export function isTrustedAuthServ(context: AuthServContext): boolean {
  const id = clean(context.id);
  if (id === "") return false;
  const idDomain = context.registrableDomain(id);
  if (idDomain === undefined) return false;
  const imapHost = clean(context.imapHost);
  const imapDomain = imapHost === "" ? undefined : context.registrableDomain(imapHost);
  if (imapDomain !== undefined) {
    if (NO_AUTHSERV_ID_DOMAINS.has(imapDomain)) return false;
    if (idDomain === imapDomain) return true;
    if (Object.hasOwn(KNOWN_AUTHSERV_DOMAINS, imapDomain)) {
      if (KNOWN_AUTHSERV_DOMAINS[imapDomain] === idDomain) return true;
    }
  }
  const at = context.address.lastIndexOf("@");
  const addressHost = at < 0 ? "" : clean(context.address.slice(at + 1));
  return addressHost !== "" && context.registrableDomain(addressHost) === idDomain;
}
