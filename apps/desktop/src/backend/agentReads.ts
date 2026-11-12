// What the agent's views need from the store, without a runtime: work prepared on request, the
// talks, rules, instructions and the journal, read from the store and local mail only. The sync
// worker's service uses it, and so does the router on its reader connection (ADR 0019), so none
// of these reads waits for a model or for a write.
import type {
  AccountStorePort,
  AgentInsightStorePort,
  AgentInstruction,
  AgentRule,
  AgentSettingsPort,
  JournalEntry,
  Message,
  MessageStorePort,
  Participant,
  PreparedWork,
  RuleOffer,
  TalkEntry,
  TalkHit,
  TalkQuote,
  TalkSummary,
  ThreadAgentView,
  WrittenTo,
} from "@matters/core";
import {
  companiesWrittenTo,
  companyOf,
  describeHistory,
  rulesCoverThread,
  SHARED_MAIL_DOMAINS,
} from "@matters/core";

export interface AgentReadDeps {
  readonly insights: Pick<
    AgentInsightStorePort,
    | "listFeedback"
    | "getPrepared"
    | "listJournal"
    | "listRules"
    | "listInstructions"
    | "listTalk"
    | "listTalks"
  >;
  readonly settings: Pick<AgentSettingsPort, "get" | "listConsents">;
  readonly store: Pick<MessageStorePort, "getThread" | "listWrittenTo">;
  readonly accounts: Pick<AccountStorePort, "list">;
}

/** Said no to this many from a domain, by more than one sender: offered for the whole domain. */
const DOMAIN_OFFER_AFTER = 3;
/** `Not important` this many times for one sender: offered for that sender. */
const SENDER_OFFER_AFTER = 2;
const lower = (address: string) => address.trim().toLowerCase();

/** The line is made for every thread a prompt reads; who the person wrote to hardly moves. */
const WRITTEN_TO_AGE_MS = 60_000;
interface WrittenToCache {
  readonly atMs: number;
  readonly addresses: ReadonlyMap<string, WrittenTo>;
  /** The same by company (ADR 0066, rule 3), derived once per read of the store. */
  readonly companies: ReadonlyMap<string, WrittenTo>;
}
const writtenToCache = new WeakMap<object, WrittenToCache>();

async function writtenTo(
  store: Pick<MessageStorePort, "listWrittenTo">,
  nowMs: number,
): Promise<WrittenToCache> {
  const known = writtenToCache.get(store);
  if (known !== undefined && Math.abs(nowMs - known.atMs) < WRITTEN_TO_AGE_MS) return known;
  const addresses = await store.listWrittenTo();
  const fresh = { atMs: nowMs, addresses, companies: companiesWrittenTo(addresses) };
  writtenToCache.set(store, fresh);
  return fresh;
}

/**
 * The line "History" of a prompt (ADR 0066, rule 1): how often the person wrote to the sender's
 * company before, from counts, with no address in it. The messages of this thread do not count:
 * they are in the prompt already. `undefined` while nothing is known about Sent mail, so that no
 * one is called a stranger for lack of a Sent folder.
 */
export async function senderHistory(
  store: Pick<MessageStorePort, "listWrittenTo">,
  nowMs: number,
  messages: readonly Message[],
  own: ReadonlySet<string>,
): Promise<string | undefined> {
  const written = await writtenTo(store, nowMs);
  if (written.addresses.size === 0) return undefined;
  const other = [...messages].reverse().find((m) => !own.has(lower(m.from.address)));
  const sender = other === undefined ? "" : lower(other.from.address);
  if (sender === "") return undefined;
  const company = companyOf(sender);
  const same = (address: string) =>
    company === "" ? lower(address) === sender : companyOf(address) === company;
  const inThread = messages.filter(
    (m) => own.has(lower(m.from.address)) && [...m.to, ...m.cc].some((p) => same(p.address)),
  ).length;
  const all = company === "" ? written.addresses.get(sender) : written.companies.get(company);
  const before =
    all === undefined || all.sent - inThread < 1
      ? undefined
      : { sent: all.sent - inThread, lastMs: all.lastMs };
  return describeHistory(before, company === "" ? "sender" : "company");
}

/**
 * Accounts that agreed to any runtime (ADR 0121, rule 4): what a talk shows of what went before,
 * since each turn of it went to a runtime that its accounts agreed to. A read only: no mail goes.
 */
export async function accountsWithConsent(
  deps: Pick<AgentReadDeps, "settings">,
): Promise<ReadonlySet<string>> {
  return new Set((await deps.settings.listConsents()).map((c) => c.accountId));
}

export async function consentedAccounts(
  deps: Pick<AgentReadDeps, "settings">,
  runtimeId: string | undefined,
): Promise<ReadonlySet<string>> {
  if (runtimeId === undefined) return new Set();
  const consents = await deps.settings.listConsents();
  return new Set(consents.filter((c) => c.runtimeId === runtimeId).map((c) => c.accountId));
}

function nameOf(p: Participant): string {
  const name = (p.name ?? "").replace(/\s+/g, " ").trim();
  return name === "" ? p.address : name;
}

/**
 * The other person of a thread: the newest sender who is not the user, else the first one the
 * user wrote to.
 */
function otherPerson(
  messages: readonly { from: Participant; to: readonly Participant[] }[],
  own: ReadonlySet<string>,
): Participant | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && !own.has(lower(m.from.address))) return m.from;
  }
  const last = messages[messages.length - 1];
  return last?.to.find((p) => !own.has(lower(p.address))) ?? null;
}

/** The name of the other person of a thread, or their address; empty when there is nobody else. */
export function whoOf(
  messages: readonly { from: Participant; to: readonly Participant[] }[],
  own: ReadonlySet<string>,
): string {
  const other = otherPerson(messages, own);
  return other === null ? "" : nameOf(other);
}

/** What was prepared for the thread as it stands now; null when nothing, or when mail came since. */
export async function preparedFor(
  deps: AgentReadDeps,
  threadId: string,
): Promise<PreparedWork | null> {
  const view = await deps.store.getThread(threadId, { visibleOnly: true });
  if (view === null) return null;
  const record = await deps.insights.getPrepared(threadId, view.thread.lastMessageKey);
  return record?.work ?? null;
}

/**
 * What the agent already has for one ordinary thread (ADR 0063, as amended by ADR 0117): the work
 * prepared on request for the thread as it stands now, from the store alone. Nothing is read
 * beyond `available` while AI is off or the thread's account did not agree to the runtime for
 * writing, where a turn about the thread goes (ADR 0121, rule 4).
 */
export async function readThreadAgent(
  deps: AgentReadDeps,
  threadId: string,
): Promise<ThreadAgentView> {
  const none: ThreadAgentView = { available: false, prepared: null };
  const settings = await deps.settings.get();
  if (!settings.enabled) return none;
  const view = await deps.store.getThread(threadId, { visibleOnly: true });
  if (view === null) return none;
  const consented = await consentedAccounts(deps, settings.kindRuntime.write);
  if (!consented.has(view.thread.accountId)) return none;
  const record = await deps.insights.getPrepared(threadId, view.thread.lastMessageKey);
  return { available: true, prepared: record?.work ?? null };
}

/** The newest entries of a talk that are read and shown (ADR 0064). */
export const MAX_TALK_SHOWN = 200;

/**
 * The talk about one thread, oldest first (ADR 0064, rule 13): a read of the store alone. Empty
 * while AI is off or the thread's account agreed to no runtime.
 */
export async function readTalk(
  deps: AgentReadDeps,
  threadId: string,
): Promise<readonly TalkEntry[]> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return [];
  const view = await deps.store.getThread(threadId, { visibleOnly: true });
  if (view === null) return [];
  const consented = await accountsWithConsent(deps);
  if (!consented.has(view.thread.accountId)) return [];
  return deps.insights.listTalk(threadId, MAX_TALK_SHOWN);
}

/**
 * A talk across all mail, oldest first (ADR 0064, rule 13; ADR 0086): a read of the store alone.
 * With `talkId`, that talk; without it, every entry across all mail. With `beforeId`, the page
 * before that entry (rule 13). Empty while AI is off or no account has consent. A hit or a quote
 * whose thread is gone, hidden, or of an account that has since lost every consent is left out,
 * so a removed thread never shows.
 */
export async function readTalkAll(
  deps: AgentReadDeps,
  talkId?: number,
  beforeId?: number,
): Promise<readonly TalkEntry[]> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return [];
  const consented = await accountsWithConsent(deps);
  if (consented.size === 0) return [];
  const entries = await deps.insights.listTalk(null, MAX_TALK_SHOWN, {
    ...(talkId === undefined ? {} : { talkId }),
    ...(beforeId === undefined ? {} : { beforeId }),
  });
  const shown = new Map<string, boolean>();
  const isShown = async (threadId: string): Promise<boolean> => {
    const known = shown.get(threadId);
    if (known !== undefined) return known;
    const view = await deps.store.getThread(threadId, { visibleOnly: true });
    const ok = view !== null && consented.has(view.thread.accountId);
    shown.set(threadId, ok);
    return ok;
  };
  const out: TalkEntry[] = [];
  for (const entry of entries) {
    if (entry.role !== "agent" || (entry.hits === undefined && entry.quotes.length === 0)) {
      out.push(entry);
      continue;
    }
    const hits: TalkHit[] = [];
    for (const hit of entry.hits ?? []) if (await isShown(hit.threadId)) hits.push(hit);
    const quotes: TalkQuote[] = [];
    for (const q of entry.quotes) {
      if (q.threadId === undefined || (await isShown(q.threadId))) quotes.push(q);
    }
    out.push({ ...entry, quotes, ...(entry.hits === undefined ? {} : { hits }) });
  }
  return out;
}

/** The active instructions (ADR 0054, rule 7), a read of the store alone. */
export async function readInstructions(
  deps: Pick<AgentReadDeps, "insights">,
): Promise<readonly AgentInstruction[]> {
  return deps.insights.listInstructions();
}

/** The active rules (ADR 0054, rule 7), a read of the store alone. */
export async function readRules(
  deps: Pick<AgentReadDeps, "insights">,
): Promise<readonly AgentRule[]> {
  return deps.insights.listRules();
}

/**
 * What the tray offers after a closing: a rule for the thread's other sender. Null when there is no
 * such sender, when it is one of the person's own addresses, or when the rules already cover the
 * thread. Local only.
 */
export async function readRuleOffer(
  deps: AgentReadDeps,
  threadId: string,
): Promise<RuleOffer | null> {
  const [view, accounts, rules, feedback] = await Promise.all([
    deps.store.getThread(threadId, { visibleOnly: true }),
    deps.accounts.list(),
    deps.insights.listRules(),
    deps.insights.listFeedback(),
  ]);
  if (view === null) return null;
  const own = accounts.map((a) => lower(a.address));
  const subject = otherSenderAddress(view.messages, new Set(own));
  if (subject === "") return null;
  const senders = view.messages.map((m) => ({ from: m.from.address }));
  if (rulesCoverThread(rules, senders, own)) return null;
  // What the person keeps saying no to (ADR 0058, rule 4). A later sets nothing aside for good.
  const said = feedback.filter((f) => f.kind === "closed" || f.kind === "notImportant");
  const domain = subject.slice(subject.lastIndexOf("@") + 1);
  const fromDomain = said.filter((f) => f.senderAddress.endsWith(`@${domain}`));
  if (
    !SHARED_MAIL_DOMAINS.has(domain) &&
    fromDomain.length >= DOMAIN_OFFER_AFTER &&
    new Set(fromDomain.map((f) => f.senderAddress)).size >= 2
  ) {
    return { scope: "domain", subject: domain };
  }
  // One `Not important` is about one thing; closing says the same of the sender at once (ADR 0054).
  const latest = said.filter((f) => f.threadId === threadId).sort((a, b) => b.atMs - a.atMs)[0];
  if (latest?.kind === "notImportant") {
    const times = said.filter((f) => f.senderAddress === subject).length;
    if (times < SENDER_OFFER_AFTER) return null;
  }
  return { scope: "sender", subject };
}

/**
 * The address of the newest sender who is not the person: who a rule for this thread is about.
 * Empty when only the person wrote.
 */
export function otherSenderAddress(
  messages: readonly { from: Participant }[],
  own: ReadonlySet<string>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && !own.has(lower(m.from.address))) return lower(m.from.address);
  }
  return "";
}

export const JOURNAL_DEFAULT = 50;
export const JOURNAL_MAX = 200;

/**
 * The local journal, newest first (ADR 0054, rule 6). A read of the store alone: it never waits
 * for a model, and nothing in it goes to one.
 */
export async function readJournal(
  deps: Pick<AgentReadDeps, "insights">,
  limit: number = JOURNAL_DEFAULT,
): Promise<readonly JournalEntry[]> {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : JOURNAL_DEFAULT;
  return deps.insights.listJournal(Math.min(JOURNAL_MAX, Math.max(1, n)));
}

/**
 * The talks across all mail, the latest first (ADR 0086, rule 5): a read of the store alone. A talk
 * with no entries is left out: it is the one the person is about to start. Empty while AI is off or
 * no account has consent, like the talk itself.
 */
export async function readTalks(deps: AgentReadDeps): Promise<readonly TalkSummary[]> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return [];
  const consented = await accountsWithConsent(deps);
  if (consented.size === 0) return [];
  return (await deps.insights.listTalks()).filter((t) => t.entries > 0);
}
