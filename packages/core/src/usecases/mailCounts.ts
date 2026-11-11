/**
 * Counts by code for the loop (ADR 0102): what a query matches, as a saved view would run it, and
 * who writes most. Both look only at the accounts agreed to and leave out what the person's rules
 * cover. No message text is read. They answer the loop's `count_mail` and `mail_overview`, check
 * the offers the loop makes, and are the facts an answer about numbers rests on. The press of a
 * clean-up acts on the same match its count was made of.
 */

import type { AgentRule, TalkFact } from "../domain/agent.ts";
import { ruleCovers, rulesCoverThread } from "../domain/agentRules.ts";
import type { Message } from "../domain/entities.ts";
import { foldText } from "../domain/text.ts";
import type { MessageStorePort, SearchIndexPort, SenderCount } from "../ports/index.ts";
import type { ParsedQuery } from "./parseQuery.ts";

// --- Limits. Starting values (ADR 0102). ---

/** A count stops past this many messages and says "500+". */
export const COUNT_CAP = 500;
/** Senders a count names among its matches. */
export const COUNT_TOP_SENDERS = 8;
/** Chunks of the index one count reads at most, so a sparse query cannot walk without bound. */
export const MAX_COUNT_CHUNKS = 40;
/** The window of the overview, in months, when the model gives none; and the longest it may ask. */
export const OVERVIEW_MONTHS = 3;
export const MAX_OVERVIEW_MONTHS = 12;
/** Rows of the overview: senders, and domains. */
export const MAX_OVERVIEW_SENDERS = 30;
export const MAX_OVERVIEW_DOMAINS = 15;
/** Counts one answer keeps as its facts, the latest of each query; and the overview's rows kept. */
export const MAX_COUNT_FACTS = 12;
export const FACT_OVERVIEW_SENDERS = 8;
export const FACT_OVERVIEW_DOMAINS = 5;

/** What a query matches, counted by code. */
export interface QueryCount {
  /** Messages, at most `COUNT_CAP`. */
  readonly matches: number;
  /** More may match: the count stopped at the cap or at `MAX_COUNT_CHUNKS`. */
  readonly capped: boolean;
  /** Unread among the messages counted. */
  readonly unread: number;
  /** Who sent the most of them, the person left out; lowercase addresses. */
  readonly senders: readonly {
    readonly address: string;
    readonly name: string;
    readonly messages: number;
  }[];
}

export interface QueryCountDeps {
  readonly index: Pick<SearchIndexPort, "searchChunk">;
  readonly store: Pick<MessageStorePort, "getByKeys" | "getThread">;
}

/** Where a count or the overview may look: the accounts agreed to, the rules, the person's own addresses. */
export interface MailScope {
  readonly consented: ReadonlySet<string>;
  readonly rules: readonly AgentRule[];
  readonly ownAddresses: readonly string[];
}

const lower = (s: string) => s.trim().toLowerCase();

/** The messages a query matches in the scope, as a count keeps them (ADR 0102). */
export interface QueryMatch {
  /** Newest first, at most `COUNT_CAP`. */
  readonly messages: readonly Message[];
  /** More may match: the walk stopped at the cap or at `MAX_COUNT_CHUNKS`. */
  readonly capped: boolean;
}

/**
 * One message a clean-up acts on (ADR 0102, rule 7): what the list's move and mark take, and no
 * text. The press of an offer gets these, the same set its count was made of.
 */
export interface ActMatch {
  readonly key: number;
  readonly threadId: string;
  readonly accountId: string;
  readonly subject: string;
  readonly seen: boolean;
}

/** What the press of a clean-up gets back: the match, without text. */
export interface ActMatches {
  readonly messages: readonly ActMatch[];
  readonly capped: boolean;
}

/** A match as the press of a clean-up takes it: keys, threads, accounts, subjects, the seen flag. */
export function actMatches(match: QueryMatch): ActMatches {
  return {
    messages: match.messages.map((m) => ({
      key: m.key,
      threadId: m.threadId,
      accountId: m.accountId,
      subject: m.subject,
      seen: m.flags.seen,
    })),
    capped: match.capped,
  };
}

const NO_MATCH: QueryMatch = { messages: [], capped: false };

/**
 * What a parsed query matches, as a saved view would run it (no stemming), in the accounts agreed
 * to, newest first, up to `COUNT_CAP` and `MAX_COUNT_CHUNKS` chunks. A thread the person's rules
 * cover is left out the way the loop's search leaves it out: by all its visible messages. Only
 * threads whose matched senders are all covered (or the person) are read whole to decide it. No
 * text is read: keys, senders and flags only. A count is made of this, and a clean-up's press
 * acts on it, so the two agree.
 */
export async function matchQuery(
  deps: QueryCountDeps,
  parsed: ParsedQuery,
  scope: MailScope,
): Promise<QueryMatch> {
  if (parsed.root === null || scope.consented.size === 0) return NO_MATCH;
  const query: ParsedQuery = {
    ...parsed,
    root: { kind: "and", children: [parsed.root, { kind: "account", ids: [...scope.consented] }] },
  };
  const keys: number[] = [];
  let finished = false;
  let before: number | undefined;
  for (let i = 0; i < MAX_COUNT_CHUNKS && keys.length <= COUNT_CAP; i++) {
    const chunk = await deps.index.searchChunk(query, {
      limit: COUNT_CAP + 1 - keys.length,
      ...(before === undefined ? {} : { beforeKey: before }),
    });
    keys.push(...chunk.keys);
    if (chunk.nextBeforeKey === undefined) {
      finished = true;
      break;
    }
    before = chunk.nextBeforeKey;
  }
  if (keys.length === 0) return { ...NO_MATCH, capped: !finished };
  const own = new Set(scope.ownAddresses.map(lower));
  const messages = (await deps.store.getByKeys(keys)).filter((m) =>
    scope.consented.has(m.accountId),
  );
  const ruled = new Set<string>();
  if (scope.rules.length > 0) {
    const byThread = new Map<string, string[]>();
    for (const m of messages) {
      const list = byThread.get(m.threadId) ?? [];
      list.push(lower(m.from.address));
      byThread.set(m.threadId, list);
    }
    for (const [threadId, senders] of byThread) {
      // A matched sender no rule covers keeps the thread: a rule covers a thread only whole.
      const others = senders.filter((s) => !own.has(s));
      if (others.length > 0 && !ruleCovers(scope.rules, others)) continue;
      const view = await deps.store.getThread(threadId, { visibleOnly: true });
      if (view === null) continue;
      const all = view.messages.map((m) => ({ from: lower(m.from.address) }));
      if (rulesCoverThread(scope.rules, all, scope.ownAddresses)) ruled.add(threadId);
    }
  }
  const visible = messages.filter((m) => !ruled.has(m.threadId));
  return {
    messages: visible.sort((a, b) => b.key - a.key).slice(0, COUNT_CAP),
    capped: !finished || visible.length > COUNT_CAP,
  };
}

/** What a parsed query matches (`matchQuery`), counted: messages, unread, the top senders. */
export async function countQuery(
  deps: QueryCountDeps,
  parsed: ParsedQuery,
  scope: MailScope,
): Promise<QueryCount> {
  const { messages: kept, capped } = await matchQuery(deps, parsed, scope);
  const own = new Set(scope.ownAddresses.map(lower));
  const tally = new Map<string, { address: string; name: string; messages: number }>();
  for (const m of kept) {
    const address = lower(m.from.address);
    if (address === "" || own.has(address)) continue;
    const known = tally.get(address);
    // Newest first: the first name met is the latest one.
    if (known === undefined) {
      tally.set(address, { address, name: (m.from.name ?? "").trim(), messages: 1 });
    } else known.messages++;
  }
  const senders = [...tally.values()]
    .sort((a, b) => b.messages - a.messages || (a.address < b.address ? -1 : 1))
    .slice(0, COUNT_TOP_SENDERS);
  return {
    matches: kept.length,
    capped,
    unread: kept.filter((m) => !m.flags.seen).length,
    senders,
  };
}

/** The shape of the mailbox by sender (ADR 0102): who wrote most, per address and per domain. */
export interface MailOverview {
  readonly months: number;
  readonly senders: readonly SenderCount[];
  readonly domains: readonly SenderCount[];
}

/** The window the model asked for, whole months from 1 to `MAX_OVERVIEW_MONTHS`; else the default. */
export function overviewMonths(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return OVERVIEW_MONTHS;
  return Math.min(Math.max(Math.round(value), 1), MAX_OVERVIEW_MONTHS);
}

const MONTH_MS = 30 * 86_400_000;

/**
 * Who wrote most to the person in the last `months` (ADR 0102), in the accounts agreed to. A
 * sender a rule of the person covers is left out, and so is a domain a domain rule names: the
 * agent does not look at what the person said not to read. Bounded by the store: a window, a limit.
 */
export async function mailOverview(
  deps: { readonly store: Pick<MessageStorePort, "listSenderCounts"> },
  scope: MailScope,
  nowMs: number,
  months: number = OVERVIEW_MONTHS,
): Promise<MailOverview> {
  const window = overviewMonths(months);
  if (scope.consented.size === 0) return { months: window, senders: [], domains: [] };
  const sinceMs = nowMs - window * MONTH_MS;
  const accountIds = [...scope.consented];
  // Rows a rule takes away are made up from a few more, so the list keeps its length.
  const extra = Math.min(scope.rules.length, 50);
  const [senders, domains] = await Promise.all([
    deps.store.listSenderCounts(sinceMs, {
      accountIds,
      by: "sender",
      limit: MAX_OVERVIEW_SENDERS + extra,
    }),
    deps.store.listSenderCounts(sinceMs, {
      accountIds,
      by: "domain",
      limit: MAX_OVERVIEW_DOMAINS + extra,
    }),
  ]);
  const own = new Set(scope.ownAddresses.map(lower));
  const ruledDomain = new Set(
    scope.rules.filter((r) => r.scope === "domain").map((r) => r.subject),
  );
  return {
    months: window,
    senders: senders
      .filter((s) => s.key !== "" && !own.has(s.key) && !ruleCovers(scope.rules, [s.key]))
      .slice(0, MAX_OVERVIEW_SENDERS),
    domains: domains
      .filter((d) => d.key !== "" && !ruledDomain.has(d.key))
      .slice(0, MAX_OVERVIEW_DOMAINS),
  };
}

/** Text of a query as two views compare it: trimmed, folded, one space between words. */
export function sameQueryText(query: string): string {
  return foldText(query.trim().replace(/\s+/g, " "));
}

/** A count as a fact of the answer (ADR 0102): the query and the code's numbers. */
export function countFact(query: string, counted: QueryCount): TalkFact {
  return {
    kind: "count",
    query,
    matches: counted.matches,
    capped: counted.capped,
    unread: counted.unread,
  };
}

/** The overview as a fact of the answer: its window and its first rows. */
export function overviewFact(shape: MailOverview): TalkFact {
  const row = (r: SenderCount) => ({
    key: r.key,
    ...(r.name === undefined ? {} : { name: r.name }),
    messages: r.messages,
    unread: r.unread,
  });
  return {
    kind: "overview",
    months: shape.months,
    senders: shape.senders.slice(0, FACT_OVERVIEW_SENDERS).map(row),
    domains: shape.domains.slice(0, FACT_OVERVIEW_DOMAINS).map(row),
  };
}

/**
 * The facts kept for an answer, in the order they were found: the latest count of each query, at
 * most `MAX_COUNT_FACTS` of them, and the latest overview.
 */
export function keepFact(facts: readonly TalkFact[], fact: TalkFact): TalkFact[] {
  const key = (f: TalkFact) => (f.kind === "overview" ? "" : `q:${sameQueryText(f.query)}`);
  const same = (f: TalkFact) => key(f) === key(fact);
  const next = [...facts.filter((f) => !same(f)), fact];
  const counts = next.filter((f) => f.kind === "count");
  const drop = new Set<TalkFact>(counts.slice(0, Math.max(0, counts.length - MAX_COUNT_FACTS)));
  return next.filter((f) => !drop.has(f));
}

/** "128 messages, 12 unread"; past the cap "500+ messages, 12 unread". The one wording of a count. */
export function countText(matches: number, capped: boolean, unread: number): string {
  const messages = capped
    ? `${matches}+ messages`
    : `${matches} ${matches === 1 ? "message" : "messages"}`;
  return `${messages}, ${unread} unread`;
}
