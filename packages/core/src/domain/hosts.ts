/**
 * The few mail hosts whose sign-in differs from "the mailbox password works" (ADR 0114, which
 * amends ADR 0023's "no table of providers"). It holds no server settings and plays no part in
 * finding servers: it is looked up by the name of a server already found or typed, and a host
 * that is missing costs only a hint. The facts come from the providers' own help pages as of
 * 2026 and can go stale; keep the list short and change it here only.
 *
 * - `appPassword`: the account password is refused; an app password made in the account's
 *   security settings works.
 * - `turnOnImap`: mail apps are turned away until access for them is switched on in webmail.
 * - `browserOnly`: no password over IMAP at all, only browser sign-in (OAuth), which Matters
 *   cannot do yet.
 */
export type HostSignIn = "appPassword" | "turnOnImap" | "browserOnly";

export interface HostRule {
  readonly id: string;
  /** How the person knows the service. */
  readonly name: string;
  /** IMAP and SMTP server names, lower case, matched exactly. */
  readonly hosts: readonly string[];
  readonly signIn: HostSignIn;
  /** The account the app password stands in for, as the provider names it. */
  readonly account?: string;
  /** What the provider calls an app password, when it calls it something else. */
  readonly term?: string;
  /** Where to do it, as the provider's pages say; without it a general sentence is shown. */
  readonly steps?: string;
}

export const HOST_RULES: readonly HostRule[] = [
  {
    id: "icloud",
    name: "iCloud",
    hosts: ["imap.mail.me.com", "smtp.mail.me.com"],
    signIn: "appPassword",
    account: "Apple Account",
    term: "app-specific password",
    steps: "Create one at account.apple.com, under Sign-In and Security.",
  },
  {
    id: "gmail",
    name: "Gmail",
    hosts: ["imap.gmail.com", "imap.googlemail.com", "smtp.gmail.com", "smtp.googlemail.com"],
    signIn: "appPassword",
    account: "Google Account",
    steps: "Turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.",
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    hosts: ["imap.mail.yahoo.com", "smtp.mail.yahoo.com"],
    signIn: "appPassword",
    account: "Yahoo account",
    steps: "Create one in your Yahoo account's security settings.",
  },
  {
    id: "aol",
    name: "AOL Mail",
    hosts: ["imap.aol.com", "smtp.aol.com"],
    signIn: "appPassword",
    account: "AOL account",
    steps: "Create one in your AOL account's security settings.",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    hosts: ["imap.fastmail.com", "smtp.fastmail.com"],
    signIn: "appPassword",
    account: "Fastmail",
    steps: "Create one in Fastmail's settings.",
  },
  {
    id: "microsoft",
    name: "Microsoft",
    hosts: [
      "outlook.office365.com",
      "outlook.office.com",
      "imap-mail.outlook.com",
      "smtp.office365.com",
      "smtp-mail.outlook.com",
    ],
    signIn: "browserOnly",
  },
  { id: "gmx", name: "GMX", hosts: ["imap.gmx.net", "mail.gmx.net"], signIn: "turnOnImap" },
  { id: "webde", name: "WEB.DE", hosts: ["imap.web.de", "smtp.web.de"], signIn: "turnOnImap" },
  { id: "wp", name: "WP Poczta", hosts: ["imap.wp.pl", "smtp.wp.pl"], signIn: "turnOnImap" },
  { id: "o2", name: "o2 Poczta", hosts: ["poczta.o2.pl"], signIn: "turnOnImap" },
  {
    id: "onet",
    name: "Onet Poczta",
    hosts: ["imap.poczta.onet.pl", "smtp.poczta.onet.pl"],
    signIn: "turnOnImap",
  },
  { id: "interia", name: "Poczta Interia", hosts: ["poczta.interia.pl"], signIn: "turnOnImap" },
];

const BY_HOST: ReadonlyMap<string, HostRule> = new Map(
  HOST_RULES.flatMap((rule) => rule.hosts.map((host) => [host, rule] as const)),
);

/** The rule for a server name, if it has one. */
export function hostRule(host: string): HostRule | undefined {
  return BY_HOST.get(host.trim().toLowerCase().replace(/\.$/, ""));
}

/**
 * The servers are Microsoft's (Outlook.com or Exchange Online, a custom domain included: its MX
 * leads the lookup to the same servers), which take no password over IMAP.
 */
export function needsBrowserSignIn(servers: {
  readonly imap: { readonly host: string };
  readonly smtp?: { readonly host: string };
}): boolean {
  return [servers.imap.host, servers.smtp?.host ?? ""].some(
    (host) => hostRule(host)?.signIn === "browserOnly",
  );
}

/**
 * Whether a password can sign in to the servers found: they list password sign-in and are not
 * Microsoft's, whose published settings list it although IMAP refuses it.
 */
export function takesPassword(servers: {
  readonly imap: { readonly host: string; readonly auth: readonly string[] };
  readonly smtp?: { readonly host: string };
}): boolean {
  return servers.imap.auth.includes("password") && !needsBrowserSignIn(servers);
}
