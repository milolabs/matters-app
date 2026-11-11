/**
 * How the person stands to a sender, from their own Sent mail alone (ADR 0066, rules 3 and 7). Pure:
 * no store and no model. A "company" is the registrable-enough domain of an address, and never a
 * domain that strangers share (gmail and the like).
 */

/** What the person's Sent mail says about one address or company. */
export interface WrittenTo {
  /** How many messages named it in To or Cc. */
  readonly sent: number;
  /** When the newest of them was sent. */
  readonly lastMs: number;
  /** The name the person's mail gave the recipient, if any did (ADR 0068, rule 2). */
  readonly name?: string;
}

/**
 * Domains that thousands of unrelated people share. A rule for these would be a rule for strangers
 * (ADR 0058, rule 4), and "you wrote to someone there" says nothing about the next sender (ADR 0066).
 */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "interia.pl",
  "poczta.fm",
]);

/** `co.uk`, `com.pl`: a second-level label that belongs to the suffix, not to a company. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "biz", "info"]);

/**
 * The company of an address: its domain cut to the last two labels, or three when the last two are a
 * suffix such as `com.pl`. Empty for an address without a domain and for a shared mail domain.
 */
export function companyOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  const labels = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .split(".")
    .filter((l) => l !== "");
  if (labels.length < 2) return "";
  const last = labels.at(-1) as string;
  const before = labels.at(-2) as string;
  const take = labels.length >= 3 && last.length === 2 && SECOND_LEVEL.has(before) ? 3 : 2;
  const company = labels.slice(-take).join(".");
  return SHARED_MAIL_DOMAINS.has(company) ? "" : company;
}

/** What was sent to each company: the sum of its addresses, and the newest time. */
export function companiesWrittenTo(
  sent: ReadonlyMap<string, WrittenTo>,
): ReadonlyMap<string, WrittenTo> {
  const out = new Map<string, WrittenTo>();
  for (const [address, w] of sent) {
    const company = companyOf(address);
    if (company === "") continue;
    const known = out.get(company);
    out.set(
      company,
      known === undefined
        ? { sent: w.sent, lastMs: w.lastMs }
        : { sent: known.sent + w.sent, lastMs: Math.max(known.lastMs, w.lastMs) },
    );
  }
  return out;
}
