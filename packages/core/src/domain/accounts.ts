import { hasAddressShape } from "./recipients.ts";

/** How a connection is protected. `none` exists for the test server only (ADR 0018). */
export type TransportSecurity = "tls" | "starttls" | "none";

export type AuthMethod = "password" | "oauth2";

/** Where and as whom the app talks to a mail server. No secrets. */
export interface MailServerSettings {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
  readonly username: string;
}

/**
 * How an account's mail moves (ADR 0136, rule 2): IMAP and SMTP with the servers it stores, or
 * Microsoft Graph, which has no servers to store. Kept with the account; an account does not
 * change it (it is removed and added again).
 */
export type MailTransport = "imap" | "graph";

interface StoredAccountFields {
  readonly id: string;
  readonly address: string;
  readonly displayName: string;
  /**
   * The largest message the outgoing server takes, as it announced in `SIZE` (ADR 0040, rule 4).
   * Absent while unknown; a connection refreshes it.
   */
  readonly messageLimitBytes?: number;
  readonly createdAtMs: number;
}

/** An account whose mail moves over IMAP and SMTP. Every account from before ADR 0136 is one. */
export interface ImapStoredAccount extends StoredAccountFields {
  /** Absent reads as `imap`, so accounts written before the transport existed stay as they are. */
  readonly transport?: "imap";
  readonly imap: MailServerSettings;
  /** Where mail is sent; an account without it can read but not send. */
  readonly smtp?: MailServerSettings;
}

/** An account whose mail moves over Microsoft Graph (ADR 0136): it stores no server settings. */
export interface GraphStoredAccount extends StoredAccountFields {
  readonly transport: "graph";
  readonly imap?: undefined;
  readonly smtp?: undefined;
}

/** An account as stored: everything but the password (ADR 0018). */
export type StoredAccount = ImapStoredAccount | GraphStoredAccount;

/** The account's transport; absent is `imap` (ADR 0136, rule 2). */
export function transportOf(account: { readonly transport?: MailTransport }): MailTransport {
  return account.transport ?? "imap";
}

/** Whether mail can be sent from the account: a Graph account always sends (ADR 0136, rule 9). */
export function canSendFrom(account: StoredAccount): boolean {
  return account.transport === "graph" || account.smtp !== undefined;
}

/** A server as a provider announces it; the user name is still a template. */
export interface ServerEndpoint {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
  /** `%EMAILADDRESS%`, `%EMAILLOCALPART%` or a literal. */
  readonly usernameTemplate: string;
  readonly auth: readonly AuthMethod[];
}

export type DiscoverySource = "provider" | "ispdb" | "dns" | "mx" | "probe";

export interface DiscoveredServers {
  readonly source: DiscoverySource;
  readonly displayName?: string;
  readonly imap: ServerEndpoint;
  readonly smtp?: ServerEndpoint;
}

/** The part of an address after the last `@`, lower case; null when the address has no valid shape. */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[^\s@]+$/.test(domain) && domain.includes(".") ? domain : null;
}

/** Fills `%EMAILADDRESS%`, `%EMAILLOCALPART%` and `%EMAILDOMAIN%` of a provider's template. */
export function expandUsername(template: string, address: string): string {
  const at = address.lastIndexOf("@");
  const local = at < 0 ? address : address.slice(0, at);
  const domain = at < 0 ? "" : address.slice(at + 1);
  return template
    .replaceAll("%EMAILADDRESS%", address)
    .replaceAll("%EMAILLOCALPART%", local)
    .replaceAll("%EMAILDOMAIN%", domain);
}

/** iCloud Mail, whichever address it serves; it takes app-specific passwords only. */
export function isICloudHost(host: string): boolean {
  return host.trim().toLowerCase() === "imap.mail.me.com";
}

/** Gmail, including Workspace on a custom domain; password sign-in takes app passwords only. */
export function isGmailHost(host: string): boolean {
  const name = host.trim().toLowerCase();
  return name === "imap.gmail.com" || name === "imap.googlemail.com";
}

/**
 * The incoming user name to start from: the published template, except on iCloud, where the full
 * address also covers custom domains, whose local part alone would not identify the mailbox.
 */
export function suggestedUsername(servers: DiscoveredServers, address: string): string {
  return isICloudHost(servers.imap.host)
    ? address
    : expandUsername(servers.imap.usernameTemplate, address);
}

/** The outgoing user name to start from; empty when it is the same as the incoming one. */
export function suggestedSmtpUsername(servers: DiscoveredServers, address: string): string {
  if (!servers.smtp) return "";
  const username = expandUsername(servers.smtp.usernameTemplate, address);
  return username === suggestedUsername(servers, address) ? "" : username;
}

/** Looks like `name@host.tld`; the server has the last word. */
export function isPlausibleAddress(address: string): boolean {
  return hasAddressShape(address);
}
