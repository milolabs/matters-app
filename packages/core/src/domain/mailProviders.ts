import type { MailTransport } from "./accounts.ts";

/**
 * Who runs a domain's mail, as public DNS shows it (ADR 0135). The table of signs lives here,
 * next to the host table of `hosts.ts`, and like it holds no server settings: server names for a
 * provider chosen by hand come from where lookup would have found them (rule 6). The signs are
 * the providers' own published names as of 2026-11 and can go stale; a provider that renames its
 * exchangers is no longer found, which costs a click, not a broken account.
 */
export type MailProviderId = "microsoft" | "google";

export interface MailProviderRule {
  readonly id: MailProviderId;
  /** How the line of rule 5 names it: *Found Microsoft 365 for firma.pl*. */
  readonly name: string;
  /** How the list of rule 3 offers it. */
  readonly choice: string;
  /** Can be chosen by hand under *Not right?* (rule 3). */
  readonly choosable: boolean;
  /** How a mailbox of this provider is added (ADR 0136, rule 13). */
  readonly transport: MailTransport;
  /**
   * The provider's own mail domain, asked of ISPDB for servers when the provider is chosen by
   * hand and the transport is `imap` (rule 6). Absent when no servers are needed.
   */
  readonly settingsDomain?: string;
  readonly signs: {
    /** Suffixes of a mail exchanger's name, lower case, with the leading dot. They decide. */
    readonly mx: readonly string[];
    /** Suffixes the CNAME of `autodiscover.<domain>` may end in. It decides. */
    readonly autodiscover: readonly string[];
    /** `include:` targets of the domain's SPF record. A hint only (rule 1). */
    readonly spf: readonly string[];
  };
}

export const MAIL_PROVIDERS: readonly MailProviderRule[] = [
  {
    id: "microsoft",
    name: "Microsoft 365",
    choice: "Microsoft 365 or Outlook.com",
    choosable: true,
    transport: "graph",
    signs: {
      mx: [".mail.protection.outlook.com", ".olc.protection.outlook.com"],
      autodiscover: ["outlook.com"],
      spf: ["spf.protection.outlook.com"],
    },
  },
  {
    id: "google",
    name: "Google",
    choice: "Google",
    choosable: true,
    transport: "imap",
    settingsDomain: "gmail.com",
    signs: {
      mx: [".google.com", ".googlemail.com"],
      autodiscover: [],
      spf: ["_spf.google.com"],
    },
  },
];

const BY_ID: ReadonlyMap<MailProviderId, MailProviderRule> = new Map(
  MAIL_PROVIDERS.map((rule) => [rule.id, rule] as const),
);

export function mailProvider(id: MailProviderId): MailProviderRule | undefined {
  return BY_ID.get(id);
}

export function isMailProviderId(value: unknown): value is MailProviderId {
  return typeof value === "string" && BY_ID.has(value as MailProviderId);
}

/** The providers *Not right?* offers by name, in the table's order (rule 3). */
export function choosableProviders(): readonly MailProviderRule[] {
  return MAIL_PROVIDERS.filter((rule) => rule.choosable);
}

/**
 * A provider lookup found for a domain (ADR 0135, rule 1). `decides`: the mail exchanger's name or
 * the autodiscover CNAME showed it. Otherwise it is a hint from SPF alone, which only puts the
 * provider first in the list of rule 3. `by` is the sign that showed it.
 */
export interface FoundProvider {
  readonly id: MailProviderId;
  readonly decides: boolean;
  readonly by: "mx" | "autodiscover" | "spf";
}

/** What DNS said about a domain; each is empty when it had nothing or did not answer in time. */
export interface DomainSigns {
  /** The mail exchangers' names, by preference. */
  readonly exchangers: readonly string[];
  /** Where `autodiscover.<domain>` points as a CNAME. */
  readonly autodiscover: readonly string[];
  /** The domain's `TXT` records, each joined from its strings. */
  readonly txt: readonly string[];
}

const clean = (name: string): string => name.trim().toLowerCase().replace(/\.$/, "");

const endsWithName = (name: string, suffix: string): boolean =>
  suffix.startsWith(".") ? name.endsWith(suffix) : name === suffix || name.endsWith(`.${suffix}`);

/** The `include:` targets of the SPF records among `txt` (RFC 7208), lower case. */
export function spfIncludes(txt: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const record of txt) {
    const terms = record.trim().split(/\s+/);
    if (terms[0]?.toLowerCase() !== "v=spf1") continue;
    for (const term of terms.slice(1)) {
      const match = /^[+\-~?]?include:(.+)$/i.exec(term);
      if (match?.[1]) out.push(clean(match[1]));
    }
  }
  return out;
}

/**
 * Who runs the mail, from the signs in the order of their weight (ADR 0135, rule 1): the most
 * preferred exchanger that names a provider, then the autodiscover CNAME; both decide. SPF alone
 * is a hint, and only when it includes exactly one known provider: a domain that sends through
 * two says nothing about where its mailboxes are.
 */
export function providerFromSigns(signs: DomainSigns): FoundProvider | undefined {
  for (const exchanger of signs.exchangers.map(clean)) {
    const rule = MAIL_PROVIDERS.find((r) => r.signs.mx.some((s) => endsWithName(exchanger, s)));
    if (rule) return { id: rule.id, decides: true, by: "mx" };
  }
  for (const target of signs.autodiscover.map(clean)) {
    const rule = MAIL_PROVIDERS.find((r) =>
      r.signs.autodiscover.some((s) => endsWithName(target, s)),
    );
    if (rule) return { id: rule.id, decides: true, by: "autodiscover" };
  }
  const includes = new Set(spfIncludes(signs.txt));
  const hinted = MAIL_PROVIDERS.filter((r) => r.signs.spf.some((s) => includes.has(s)));
  const only = hinted.length === 1 ? hinted[0] : undefined;
  return only ? { id: only.id, decides: false, by: "spf" } : undefined;
}
