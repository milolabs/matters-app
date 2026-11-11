/**
 * How the person stands to a sender, from their own Sent mail alone (ADR 0066, rules 3 and 7). Pure:
 * no store and no model. A "company" is the registrable-enough domain of an address, and never a
 * domain that strangers share (gmail and the like).
 */
import type { FeedbackOutcome, MatterAmount, ThingFeedback } from "./agent.ts";
import { foldText, tokenize } from "./text.ts";

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

/** Whether the address is at a domain that strangers share. */
export function isSharedMailAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const labels = domain.split(".");
  return SHARED_MAIL_DOMAINS.has(domain) || SHARED_MAIL_DOMAINS.has(labels.slice(-2).join("."));
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

/**
 * Two senders are one party when they share a company, or, for a shared mail domain, when they are
 * the same address.
 */
export function sameParty(a: string, b: string): boolean {
  const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  if (x === "" || y === "") return false;
  const company = companyOf(x);
  return company !== "" ? company === companyOf(y) : x === y;
}

// --- Interaction recency (ADR 0068, rule 2) ---

/** The most points a last message sent there gives, by how close the sender is to the person. */
export const INTERACTION_MAX = { address: 30, person: 24, company: 12 } as const;
/** Points halve every this many days since the last message the person sent there. */
export const INTERACTION_HALF_LIFE_DAYS = 180;

export type InteractionLevel = keyof typeof INTERACTION_MAX;

/** When the person last wrote to the sender, at each level; absent where they never did. */
export interface Interaction {
  readonly address?: number;
  readonly person?: number;
  readonly company?: number;
}

const DAY = 86_400_000;

/** `max * 0.5 ^ (days / 180)`, rounded: an old relation fades to nothing by itself. */
export function interactionPointsFor(level: InteractionLevel, days: number): number {
  return Math.round(
    INTERACTION_MAX[level] * 0.5 ** (Math.max(0, days) / INTERACTION_HALF_LIFE_DAYS),
  );
}

/** The best level at this time: its points, which level, and how many days ago. Null: no level at all. */
export function bestInteraction(
  interaction: Interaction,
  nowMs: number,
): { readonly level: InteractionLevel; readonly points: number; readonly days: number } | null {
  let best: { level: InteractionLevel; points: number; days: number } | null = null;
  for (const level of ["address", "person", "company"] as const) {
    const at = interaction[level];
    if (at === undefined) continue;
    const days = Math.max(0, Math.floor((nowMs - at) / DAY));
    const points = interactionPointsFor(level, days);
    // The nearer level wins a tie, so the sentence names the closest relation.
    if (best === null || points > best.points) best = { level, points, days };
  }
  return best;
}

/** A span in words the person reads: days, then months, then years. */
export function agoInWords(days: number): string {
  if (days < 1) return "today";
  if (days < 60) return `${days} ${days === 1 ? "day" : "days"} ago`;
  if (days < 730) {
    const months = Math.round(days / 30);
    return `${months} months ago`;
  }
  return `${Math.floor(days / 365)} years ago`;
}

/** Words that name a role and not a person: a name made of them says nothing about who wrote. */
const ROLE_WORDS: ReadonlySet<string> = new Set([
  "biuro",
  "kontakt",
  "info",
  "support",
  "team",
  "office",
  "obsluga",
  "pomoc",
  "customer",
  "service",
  "sales",
  "sekretariat",
  "administracja",
  // Words of organisations, whose names look like a person's.
  "services",
  "group",
  "grupa",
  "bank",
  "company",
  "inc",
  "ltd",
  "llc",
  "gmbh",
  "sa",
  "sp",
  "online",
  "web",
  "cloud",
  "shop",
  "sklep",
  "polska",
  "poland",
  "pl",
  "com",
  "newsletter",
  "powiadomienia",
  "notifications",
  "faktury",
  "ubezpieczenia",
]);

/**
 * The folded name of a person, when a display name can stand for one: at least two words and no role
 * word. This is knowingly approximate. Two people can share a name, and one person can be written to
 * under two spellings; an error here costs a few points and a sentence that says "looks like", never
 * a hidden or invented thing.
 */
export function personKey(displayName: string | undefined): string | null {
  const words = tokenize(displayName ?? "");
  if (words.length < 2 || words.some((w) => ROLE_WORDS.has(w))) return null;
  return words.join(" ");
}

// --- A reading that shares a topic with what the person wrote (ADR 0066, rule 3) ---

const STOPWORDS: ReadonlySet<string> = new Set([
  // Polish
  "i",
  "w",
  "z",
  "na",
  "do",
  "od",
  "po",
  "za",
  "dla",
  "oraz",
  "lub",
  "nr",
  "sie",
  "to",
  "ze",
  // English
  "the",
  "and",
  "for",
  "of",
  "to",
  "in",
  "on",
  "an",
  "re",
  "fw",
  "fwd",
  "your",
  "you",
  "our",
  "with",
]);

const MIN_TOKEN_CHARS = 2;
/** One word this long, shared, is a topic by itself. */
const LONG_TOKEN_CHARS = 5;
const YEAR = /^(?:19|20)\d{2}$/;

function topicTokens(text: string): string[] {
  return tokenize(text).filter(
    (t) => t.length >= MIN_TOKEN_CHARS && !YEAR.test(t) && !STOPWORDS.has(t),
  );
}

/**
 * Whether the person wrote about this matter before: the name of the matter and its anchors, against
 * the subjects of their own mail to the sender's company. Words are folded; years, one-letter words and
 * a small stoplist are dropped. It is true when a subject shares two different words with the matter
 * (two in a row included) or one word of five letters or more.
 */
export function sharesTopic(
  caseName: string | undefined,
  anchors: readonly string[] | undefined,
  subjects: readonly string[],
  threadSubject?: string,
): boolean {
  // The thread's own subject counts: a reading can come back with no name for the matter at all.
  const own = new Set(
    topicTokens([caseName ?? "", threadSubject ?? "", ...(anchors ?? [])].join(" ")),
  );
  if (own.size === 0) return false;
  for (const subject of subjects) {
    const shared = new Set(topicTokens(subject).filter((t) => own.has(t)));
    if (shared.size >= 2 || [...shared].some((t) => t.length >= LONG_TOKEN_CHARS)) return true;
  }
  return false;
}

// --- A proposal the person declined (ADR 0066, rule 7) ---

/** The folded name of a matter: what a decline remembers and a later offer is compared with. */
export function caseKeyOf(caseName: string | undefined): string {
  return foldText(caseName ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What a later offer looks like to `isDeclinedProposal`. */
export interface Proposal {
  /** Lowercase address of the sender. */
  readonly senderAddress: string;
  readonly caseName?: string;
  readonly amount?: Pick<MatterAmount, "value">;
  /** When the offer arrived. */
  readonly dateMs: number;
}

const yearOf = (ms: number) => new Date(ms).getUTCFullYear();

/**
 * What a feedback of this kind means (ADR 0066, rule 7). `Not important` is always `notRelevant`:
 * it is the only one that counts against the sender. `Later` has no outcome. A closing is `done`
 * unless the person said they took the offer or declined it.
 */
export function outcomeOf(
  kind: ThingFeedback["kind"],
  said: FeedbackOutcome | undefined,
): FeedbackOutcome | undefined {
  if (kind === "later") return undefined;
  if (kind === "notImportant") return "notRelevant";
  return said === "taken" || said === "declined" ? said : "done";
}

/**
 * Whether a person already said "not this year" to this offer: a decline from the same company, with
 * the same folded name of the matter, in the same calendar year, and the same amount (or either one
 * missing). A new year, another name, or another amount opens it again. Closing for other reasons
 * never declines anything.
 */
export function isDeclinedProposal(
  feedback: readonly ThingFeedback[],
  proposal: Proposal,
): boolean {
  const key = caseKeyOf(proposal.caseName);
  if (key === "") return false;
  return feedback.some(
    (f) =>
      f.kind === "closed" &&
      f.outcome === "declined" &&
      f.caseKey === key &&
      sameParty(f.senderAddress, proposal.senderAddress) &&
      yearOf(f.atMs) === yearOf(proposal.dateMs) &&
      (f.amountValue === undefined ||
        proposal.amount === undefined ||
        f.amountValue === proposal.amount.value),
  );
}
