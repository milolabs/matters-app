/**
 * Rules in code (ADR 0054, rule 7): which threads the person does not want to see or have read,
 * decided from addresses alone. Pure; no model is involved.
 */
import type { AgentRule, RuleScope, ThreadAnalysis, ThreadCategory } from "./agent.ts";
import { PROGRAM_LIKE, THREAD_CATEGORIES } from "./agent.ts";
import { looksLikeProgram } from "./automated.ts";

const MAX_ADDRESS = 320;
const MAX_DOMAIN = 253;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The stored form of what the person typed or a caller gave: trimmed, lowercase. Null for anything
 * that is not a valid subject of that scope.
 */
export function normalizeRuleSubject(scope: RuleScope, raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (scope === "type") return value === PROGRAM_LIKE.toLowerCase() ? PROGRAM_LIKE : null;
  if (scope === "category") {
    return THREAD_CATEGORIES.find((c) => c.toLowerCase() === value && c !== "other") ?? null;
  }
  if (scope === "domain") {
    if (value.startsWith("@")) value = value.slice(1);
    if (value.length > MAX_DOMAIN || value.includes("@")) return null;
    return HOSTNAME.test(value) ? value : null;
  }
  if (value.length > MAX_ADDRESS || /\s/.test(value)) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  return local !== undefined && local.length > 0 && domain !== undefined && domain.length > 0
    ? value
    : null;
}

function matches(rule: AgentRule, address: string): boolean {
  // A category rule is about the reading, not the address: it hides at read time (ADR 0068).
  if (rule.scope === "category") return false;
  if (rule.scope === "sender") return rule.subject === address;
  if (rule.scope === "domain") return address.endsWith(`@${rule.subject}`);
  return rule.subject === PROGRAM_LIKE && looksLikeProgram(address);
}

/**
 * Whether the rules cover a thread, given the addresses of everyone in it other than the person.
 * True only when there is someone and EVERY one of them is matched: a thread a real person also
 * wrote in stays, which is the guard against hiding a real conversation.
 */
export function ruleCovers(rules: readonly AgentRule[], senders: readonly string[]): boolean {
  if (rules.length === 0 || senders.length === 0) return false;
  return senders.every((s) => {
    const address = s.toLowerCase();
    return rules.some((r) => matches(r, address));
  });
}

/** Lowercase addresses of everyone in a thread but the person; what `ruleCovers` takes. */
export function otherSenders(
  messages: readonly { readonly from: string }[],
  ownAddresses: readonly string[],
): string[] {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const out = new Set<string>();
  for (const m of messages) {
    const from = m.from.toLowerCase();
    if (!own.has(from)) out.add(from);
  }
  return [...out];
}

/** Whether rules cover a thread's messages, the person's own addresses left out. */
export function rulesCoverThread(
  rules: readonly AgentRule[],
  messages: readonly { readonly from: string }[],
  ownAddresses: readonly string[],
): boolean {
  return ruleCovers(rules, otherSenders(messages, ownAddresses));
}

/**
 * Whether a rule of the person says "do not show this kind of mail" for this reading (ADR 0068,
 * rule 3). Unlike a sender rule it cannot stop a thread from being read, since the kind is only known
 * from the reading, so it hides at read time. The one helper of the list, of the count a closing
 * covers, of drafting ahead (through the list) and of a thread's own banner.
 */
export function categoryRuleCovers(
  rules: readonly AgentRule[],
  analysis: Pick<ThreadAnalysis, "category">,
): boolean {
  const kind: ThreadCategory | undefined = analysis.category;
  return (
    kind !== undefined &&
    kind !== "other" &&
    rules.some((r) => r.scope === "category" && r.subject === kind)
  );
}
