// What the list of things that matter needs from the store, without a runtime: it reads
// analyses and local mail only. The sync worker's service uses it, and so does the router on its
// reader connection (ADR 0019), so opening the list never waits for a model or for a write.
import type {
  AccountStorePort,
  AgentInsightStorePort,
  AgentInstruction,
  AgentRule,
  AgentSettingsPort,
  AnalyzedThread,
  BundleInput,
  DraftStorePort,
  JournalEntry,
  MatterCard,
  Message,
  MessageStorePort,
  OutboxPort,
  Participant,
  PreparedWork,
  ReceivedMail,
  RuleOffer,
  SentMail,
  TalkEntry,
  TalkHit,
  TalkQuote,
  TalkSummary,
  Thing,
  ThingEdge,
  ThingFeedback,
  ThingSignals,
  ThingsPage,
  ThreadAgentView,
  ThreadAnalysis,
  WrittenTo,
} from "@matters/core";
import {
  ANALYZER_VERSION,
  answeredSinceReading,
  arrangeThings,
  bundleSignature,
  cardOf,
  categoryRuleCovers,
  collapseSeries,
  companiesWrittenTo,
  companyOf,
  coveredBySeriesEnd,
  describeHistory,
  findBundles,
  isOfficialAddress,
  isSharedMailAddress,
  isThingHidden,
  messageKey,
  otherSenders,
  personKey,
  rankThings,
  rulesCoverThread,
  type SeriesEnd,
  type SeriesInput,
  SHARED_MAIL_DOMAINS,
  selectCandidates,
  seriesKey,
  sharesTopic,
  shownPath,
} from "@matters/core";
import type { ReadEstimate } from "./agentApi.ts";
import { CompanyIndex } from "./companyIndex.ts";

export interface AgentReadDeps {
  readonly insights: Pick<
    AgentInsightStorePort,
    | "listAnalyses"
    | "listFeedback"
    | "getPrepared"
    | "getBundleRead"
    | "listJournal"
    | "listRules"
    | "listInstructions"
    | "listTalk"
    | "listTalks"
  >;
  readonly settings: Pick<AgentSettingsPort, "get" | "listConsents">;
  readonly store: Pick<
    MessageStorePort,
    "getThread" | "listThreadsSince" | "listWrittenTo" | "listSentMail" | "listReceivedMail"
  >;
  readonly accounts: Pick<AccountStorePort, "list">;
  /**
   * The sends under way, so that a reply the person sent is known before it is in its thread
   * (ADR 0112). Absent: only the thread itself says that the person answered.
   */
  readonly sends?: {
    readonly outbox: Pick<OutboxPort, "listVisible">;
    readonly drafts: Pick<DraftStorePort, "get">;
  };
}

/** More threads than this in a window are not counted or read. Far above a month of real mail. */
export const CANDIDATE_LIMIT = 5000;

const DAY_MS = 86_400_000;

/** Said no to this many from a domain, by more than one sender: offered for the whole domain. */
const DOMAIN_OFFER_AFTER = 3;
/** `Not important` this many times for one sender: offered for that sender. */
const SENDER_OFFER_AFTER = 2;
/** One bundle as it stands, for the turn that asks what blocks what (ADR 0059, rule 4). */
export interface BundleRead {
  readonly signature: string;
  /** Null: not asked yet about these threads at these messages. */
  readonly edges: readonly ThingEdge[] | null;
  readonly threadIds: readonly string[];
  /** A newer message waits to be read in one of them: asking now would be asking twice. */
  readonly stale: boolean;
  readonly cards: readonly MatterCard[];
}

/** A thing with what the service needs to act on it. */
export interface RankedThing {
  readonly thing: Thing;
  readonly analysis: ThreadAnalysis;
}

const lower = (address: string) => address.trim().toLowerCase();

/** The list is read on every push and keystroke; who the person wrote to hardly moves. */
const WRITTEN_TO_AGE_MS = 60_000;
interface WrittenToCache {
  readonly atMs: number;
  readonly addresses: ReadonlyMap<string, WrittenTo>;
  /** The same by company (ADR 0066, rule 3), derived once per read of the store. */
  readonly companies: ReadonlyMap<string, WrittenTo>;
  /**
   * When the person last wrote to a recipient of this folded name (ADR 0068, rule 2): a name of two
   * words or more and no role word. Knowingly approximate.
   */
  readonly people: ReadonlyMap<string, number>;
}
const writtenToCache = new WeakMap<object, WrittenToCache>();

async function writtenTo(
  store: Pick<MessageStorePort, "listWrittenTo">,
  nowMs: number,
): Promise<WrittenToCache> {
  const known = writtenToCache.get(store);
  if (known !== undefined && Math.abs(nowMs - known.atMs) < WRITTEN_TO_AGE_MS) return known;
  const addresses = await store.listWrittenTo();
  const people = new Map<string, number>();
  for (const w of addresses.values()) {
    const key = personKey(w.name);
    if (key !== null) people.set(key, Math.max(people.get(key) ?? 0, w.lastMs));
  }
  const fresh = { atMs: nowMs, addresses, companies: companiesWrittenTo(addresses), people };
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

/** How many subjects of the person's own mail to a company are looked at (ADR 0066, rule 3). */
export const SENT_SUBJECTS_LIMIT = 200;

/** How far back mail from a company is counted for `ignoredSince`, so the walk is bounded (ADR 0068). */
export const RECEIVED_LOOKBACK_DAYS = 365;
/** Most messages counted for `ignoredSince`. */
export const RECEIVED_LIMIT = 100;

/**
 * What a list build asks the store beyond who was written to, and only for the few readings that need
 * it: the subjects of the person's mail to the sender's company (ADR 0066, rule 3), and the mail that
 * reached the person from it since they last wrote (ADR 0068, rule 6). The first question of each kind
 * walks that mail once and files it by company, and every other is a look in the map (ADR 0070, rule
 * 1), so the cost does not grow with how many companies are on the list.
 */
export function lookups(
  store: Pick<MessageStorePort, "listSentMail" | "listReceivedMail">,
  nowMs: number,
) {
  const floorMs = nowMs - RECEIVED_LOOKBACK_DAYS * DAY_MS;
  let sent: Promise<CompanyIndex<SentMail>> | undefined;
  let received: Promise<CompanyIndex<ReceivedMail>> | undefined;
  const fileSent = async () => {
    const index = new CompanyIndex<SentMail>(SENT_SUBJECTS_LIMIT);
    for (const mail of await store.listSentMail()) {
      for (const address of mail.recipients) index.add(address, mail);
    }
    return index;
  };
  const fileReceived = async () => {
    const index = new CompanyIndex<ReceivedMail>(RECEIVED_LIMIT);
    for (const mail of await store.listReceivedMail(floorMs)) index.add(mail.from, mail);
    return index;
  };
  return {
    async subjects(sender: string): Promise<readonly string[]> {
      const target = companyOf(sender) || sender;
      if (target === "") return [];
      sent ??= fileSent();
      return (await sent).get(target).map((mail) => mail.subject);
    },
    /** Thread ids of mail from the sender's company (their address when it has none) since a time. */
    async received(sender: string, afterMs: number): Promise<readonly string[]> {
      const target = companyOf(sender) || sender;
      if (target === "") return [];
      received ??= fileReceived();
      const floor = messageKey(Math.max(afterMs, floorMs), 0);
      const ids: string[] = [];
      for (const mail of (await received).get(target)) {
        if (mail.key < floor) break;
        ids.push(mail.threadId);
      }
      return ids;
    },
  };
}
type Lookups = ReturnType<typeof lookups>;

/**
 * What the thread itself says, for the ranking (ADR 0057). With no Sent mail at all nothing is known
 * about who the person wrote to: everyone would look like a stranger.
 */
async function signalsOf(
  analysis: ThreadAnalysis,
  messages: readonly Message[],
  subject: string,
  own: ReadonlySet<string>,
  written: WrittenToCache,
  sender: string,
  look: Lookups,
): Promise<ThingSignals> {
  const { addresses: sent, companies } = written;
  const mine = messages.filter((m) => own.has(lower(m.from.address)));
  const lastOwnKey = mine.at(-1)?.key;
  const inThread = mine.some((m) => [...m.to, ...m.cc].some((p) => lower(p.address) === sender));
  const side = analysis.state === "onYou" ? "you" : "them";
  const factKeys = analysis.facts.filter((f) => f.who === side).map((f) => f.evidence.messageKey);
  const keys =
    factKeys.length > 0
      ? factKeys
      : analysis.intentEvidence === undefined
        ? []
        : [analysis.intentEvidence.messageKey];
  const source = messages.find((m) => m.key === Math.max(...keys));
  const named = (list: readonly Participant[]) => list.some((p) => own.has(lower(p.address)));
  const onlyCc = source !== undefined && named(source.cc) && !named(source.to);
  const known = sent.size > 0 && sender !== "";
  const company = companyOf(sender);
  const toAddress = sent.get(sender);
  const toCompany = company === "" ? undefined : companies.get(company);
  // The newest mail from someone else is the one whose sender check says whom to trust.
  const theirs = [...messages].reverse().find((m) => !own.has(lower(m.from.address)));
  // Interaction recency (ADR 0068, rule 2): when the person last wrote to this address, to what
  // looks like the same person, and to anyone at the company.
  const person = personKey(theirs?.from.name);
  const toPerson = person === null ? undefined : written.people.get(person);
  const interaction = {
    ...(toAddress === undefined ? {} : { address: toAddress.lastMs }),
    ...(toPerson === undefined ? {} : { person: toPerson }),
    ...(toCompany === undefined ? {} : { company: toCompany.lastMs }),
  };
  // Only a reading that may be shown for a personal reason it cannot give itself asks for the
  // person's own mail: a rare, bounded read (ADR 0066, rule 3).
  const needsTopic =
    (analysis.intent === "decide" || analysis.intent === "know") &&
    analysis.forYouEvidence === undefined &&
    (analysis.caseName !== undefined ||
      (analysis.anchors ?? []).length > 0 ||
      subject.trim() !== "") &&
    sender !== "";
  const topic = needsTopic
    ? sharesTopic(analysis.caseName, analysis.anchors, await look.subjects(sender), subject)
    : undefined;
  // Offers and news from someone who keeps writing and is never answered (ADR 0068, rule 6).
  const stateRead =
    (analysis.state === "onYou" || analysis.state === "waiting") && analysis.facts.length > 0;
  const asksIgnored =
    (analysis.intent === "decide" || analysis.intent === "know") &&
    !stateRead &&
    analysis.category !== "official" &&
    sender !== "";
  const ignoredSince = asksIgnored
    ? (
        await look.received(
          sender,
          company !== "" ? (toCompany?.lastMs ?? 0) : (toAddress?.lastMs ?? 0),
        )
      ).filter((id) => id !== analysis.threadId).length
    : undefined;
  return {
    dateOf: new Map(messages.map((m) => [m.key, m.dateMs])),
    ...(lastOwnKey === undefined ? {} : { lastOwnKey }),
    ...(known
      ? {
          wroteToSender: inThread || toAddress !== undefined,
          ...(company === "" ? {} : { wroteToCompany: toCompany !== undefined }),
        }
      : {}),
    ...(Object.keys(interaction).length === 0 ? {} : { interaction }),
    ...(ignoredSince === undefined ? {} : { ignoredSince }),
    ...(sender !== "" && isOfficialAddress(sender) ? { senderIsOfficial: true } : {}),
    ...(topic === undefined ? {} : { sharesTopic: topic }),
    ...(sender !== "" && isSharedMailAddress(sender) ? { freeMail: true } : {}),
    ...(theirs?.senderAuth === "fail" ? { authFailed: true } : {}),
    ...(onlyCc ? { onlyCc } : {}),
  };
}

/** Accounts whose mail may go to the runtime the person chose. */
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

/**
 * What ended a series (ADR 0061): a thread of it the person hid or set aside, or one they wrote in,
 * whether it is still listed or the reading after their reply found nothing open. Only threads whose
 * matter is on the list are looked at, so this costs a few reads and not one per analysis.
 */
async function seriesEnds(
  deps: AgentReadDeps,
  analyses: readonly ThreadAnalysis[],
  feedback: readonly ThingFeedback[],
  listed: readonly SeriesInput[],
  own: ReadonlySet<string>,
  nowMs: number,
): Promise<readonly SeriesEnd[]> {
  const names = new Set(listed.flatMap((t) => seriesKey("-", t.caseName) ?? []));
  const here = new Set(listed.map((t) => t.threadId));
  const senderOf = new Map(feedback.map((f) => [f.threadId, f.senderAddress]));
  const ends: SeriesEnd[] = listed.flatMap((t) =>
    t.answered && t.caseName !== undefined
      ? [
          {
            senderAddress: t.senderAddress,
            caseName: t.caseName,
            lastMessageKey: t.lastMessageKey,
            ...(t.anchors === undefined ? {} : { anchors: t.anchors }),
          },
        ]
      : [],
  );
  for (const a of analyses) {
    const name = a.caseName;
    if (name === undefined || here.has(a.threadId) || !names.has(seriesKey("-", name) ?? "")) {
      continue;
    }
    const anchors = a.anchors === undefined ? {} : { anchors: a.anchors };
    const sender = senderOf.get(a.threadId);
    if (sender !== undefined && isThingHidden(a, feedback, nowMs)) {
      ends.push({
        senderAddress: sender,
        caseName: name,
        lastMessageKey: a.lastMessageKey,
        ...anchors,
      });
      continue;
    }
    const view = await deps.store.getThread(a.threadId, { visibleOnly: true });
    if (view === null || !view.messages.some((m) => own.has(lower(m.from.address)))) continue;
    const other = otherPerson(view.messages, own);
    if (other !== null) {
      ends.push({
        senderAddress: lower(other.address),
        caseName: name,
        lastMessageKey: a.lastMessageKey,
        ...anchors,
      });
    }
  }
  return ends;
}

/** The row of a series for one listed thread. */
function seriesInputOf(
  analysis: ThreadAnalysis,
  view: NonNullable<Awaited<ReturnType<AgentReadDeps["store"]["getThread"]>>>,
  senderAddress: string,
  own: ReadonlySet<string>,
): SeriesInput {
  return {
    threadId: analysis.threadId,
    accountId: view.thread.accountId,
    senderAddress,
    ...(analysis.caseName === undefined ? {} : { caseName: analysis.caseName }),
    ...(analysis.anchors === undefined ? {} : { anchors: analysis.anchors }),
    lastMessageKey: analysis.lastMessageKey,
    lastDateMs: view.messages.at(-1)?.dateMs ?? 0,
    answered: view.messages.some((m) => own.has(lower(m.from.address))),
  };
}

/**
 * How many threads this one takes along when it is dealt with now (ADR 0065): those of its series that
 * the list has, are not covered yet and would be. It reads only the threads under the same name, and
 * is asked before the feedback is written. It says what is hidden, not what the row shows folded.
 */
export async function alsoCoveredBy(
  deps: AgentReadDeps,
  analysis: ThreadAnalysis,
  senderAddress: string,
  nowMs: number,
): Promise<number> {
  const name = seriesKey("-", analysis.caseName);
  const key = seriesKey(senderAddress, analysis.caseName);
  if (name === null || key === null) return 0;
  const settings = await deps.settings.get();
  const consented = await consentedAccounts(deps, settings.runtimeId);
  if (!settings.enabled || consented.size === 0) return 0;
  const [analyses, feedback, accounts, rules, written, answering] = await Promise.all([
    deps.insights.listAnalyses(ANALYZER_VERSION),
    deps.insights.listFeedback(),
    deps.accounts.list(),
    deps.insights.listRules(),
    writtenTo(deps.store, nowMs),
    answeringThreads(deps, nowMs),
  ]);
  const own = new Set(accounts.map((a) => lower(a.address)));
  const look = lookups(deps.store, nowMs);
  const series: SeriesInput[] = [];
  for (const a of analyses) {
    // The same condition as the list's (ADR 0066, rule 2): a coarse pass first, then with signals.
    if (
      a.threadId === analysis.threadId ||
      seriesKey("-", a.caseName) !== name ||
      categoryRuleCovers(rules, a) ||
      shownPath(a, { feedback, nowMs }) === null
    ) {
      continue;
    }
    const view = await deps.store.getThread(a.threadId, { visibleOnly: true });
    if (view === null || !consented.has(view.thread.accountId)) continue;
    const froms = view.messages.map((m) => ({ from: m.from.address }));
    if (rulesCoverThread(rules, froms, [...own])) continue;
    // What the list leaves out while the person's answer waits to be read (ADR 0112).
    if (answered(a, view.messages, own, answering)) continue;
    const other = otherPerson(view.messages, own);
    const sender = other === null ? "" : lower(other.address);
    const signals = await signalsOf(
      a,
      view.messages,
      view.thread.subject,
      own,
      written,
      sender,
      look,
    );
    if (shownPath(a, { feedback, nowMs, signals, senderAddress: sender }) === null) continue;
    series.push(seriesInputOf(a, view, sender, own));
  }
  const ends = await seriesEnds(deps, analyses, feedback, series, own, nowMs);
  const end: SeriesEnd = {
    senderAddress,
    caseName: analysis.caseName as string,
    lastMessageKey: analysis.lastMessageKey,
    ...(analysis.anchors === undefined ? {} : { anchors: analysis.anchors }),
  };
  return coveredBySeriesEnd(series, [...ends, end]).size - coveredBySeriesEnd(series, ends).size;
}

/** A send that ended this long ago is no longer looked at: its message is in its thread by then. */
const SENT_RECORD_MS = 10 * 60_000;
/** A send in these states is a reply on its way, or one sent whose copy is not in its thread yet. */
const ANSWERING_STATES: ReadonlySet<string> = new Set([
  "pending",
  "held",
  "running",
  "unknown",
  "succeeded",
]);

/**
 * The threads the person is answering through the outbox (ADR 0112, rule 2): a send of a reply
 * that has not failed, been undone or voided, whose draft is still there. The draft goes once the
 * sent message is recorded in its thread, and from then on the thread itself says so. A read of
 * the few sends shown in the outbox, not of mail.
 */
export async function answeringThreads(
  deps: Pick<AgentReadDeps, "sends">,
  nowMs: number,
): Promise<ReadonlySet<string>> {
  const sends = deps.sends;
  if (sends === undefined) return new Set();
  const ops = (await sends.outbox.listVisible(nowMs - SENT_RECORD_MS)).filter((op) =>
    ANSWERING_STATES.has(op.state.kind),
  );
  if (ops.length === 0) return new Set();
  const drafts = await Promise.all(ops.map((op) => sends.drafts.get(op.draftId)));
  return new Set(drafts.flatMap((d) => (d?.threadId === undefined ? [] : [d.threadId])));
}

/**
 * The person has answered the thread since its reading (ADR 0112): their reply is the newest
 * message, or it is in the outbox. Such a thing is not listed, counted or said until the agent has
 * read the thread again, and that reading decides.
 */
function answered(
  analysis: ThreadAnalysis,
  messages: Parameters<typeof answeredSinceReading>[1],
  own: ReadonlySet<string>,
  answering: ReadonlySet<string>,
): boolean {
  return answering.has(analysis.threadId) || answeredSinceReading(analysis, messages, own);
}

/**
 * The things that matter, best first, with the analysis each comes from. A thread whose newest
 * message is newer than its analysis keeps its old reading and is marked `updating`: it waits for
 * the new reading and does not vanish while it comes. The one exception is the person's own answer
 * (ADR 0112): what they replied to leaves until the new reading says whether it is still on them.
 * `limit` keeps the best ones; `total` counts them all, and the rest cost no further read.
 */
export async function rankedThings(
  deps: AgentReadDeps,
  nowMs: number,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<{
  readonly ranked: RankedThing[];
  readonly total: number;
  readonly now: number;
  readonly bundles: readonly BundleRead[];
}> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return { ranked: [], total: 0, now: 0, bundles: [] };
  const consented = await consentedAccounts(deps, settings.runtimeId);
  if (consented.size === 0) return { ranked: [], total: 0, now: 0, bundles: [] };
  const [analyses, feedback, accounts, rules, written, answering] = await Promise.all([
    deps.insights.listAnalyses(ANALYZER_VERSION),
    deps.insights.listFeedback(),
    deps.accounts.list(),
    deps.insights.listRules(),
    writtenTo(deps.store, nowMs),
    answeringThreads(deps, nowMs),
  ]);
  const own = new Set(accounts.map((a) => lower(a.address)));
  const look = lookups(deps.store, nowMs);
  // A coarse pass with no signals drops what can never show, so that only the rest costs a read of
  // its thread. `rankThings` asks the same predicate again with the signals (ADR 0066, rule 2).
  const shown = analyses.filter(
    (a) => !categoryRuleCovers(rules, a) && shownPath(a, { feedback, nowMs }) !== null,
  );
  const analyzed: AnalyzedThread[] = [];
  const inputs: BundleInput[] = [];
  const series: SeriesInput[] = [];
  const currentKey = new Map<string, number>();
  const byThread = new Map<string, ThreadAnalysis>();
  for (const analysis of shown) {
    const view = await deps.store.getThread(analysis.threadId, { visibleOnly: true });
    if (view === null || !consented.has(view.thread.accountId)) continue;
    // A rule hides at read time, so it needs no new reading and goes with the rule (ADR 0054).
    if (
      rulesCoverThread(
        rules,
        view.messages.map((m) => ({ from: m.from.address })),
        [...own],
      )
    ) {
      continue;
    }
    // The person answered it: it waits for the reading of their answer (ADR 0112).
    if (answered(analysis, view.messages, own, answering)) continue;
    const other = otherPerson(view.messages, own);
    const senderAddress = other === null ? "" : lower(other.address);
    analyzed.push({
      analysis,
      accountId: view.thread.accountId,
      who: other === null ? "" : nameOf(other),
      senderAddress,
      signals: await signalsOf(
        analysis,
        view.messages,
        view.thread.subject,
        own,
        written,
        senderAddress,
        look,
      ),
    });
    inputs.push({
      threadId: analysis.threadId,
      accountId: view.thread.accountId,
      ...(analysis.caseName === undefined ? {} : { caseName: analysis.caseName }),
      ...(analysis.anchors === undefined ? {} : { anchors: analysis.anchors }),
      people: otherSenders(
        view.messages.map((m) => ({ from: m.from.address })),
        [...own],
      ),
      subject: view.thread.subject,
      lastDateMs: view.messages.at(-1)?.dateMs ?? 0,
    });
    series.push(seriesInputOf(analysis, view, senderAddress, own));
    currentKey.set(analysis.threadId, view.thread.lastMessageKey);
    byThread.set(analysis.threadId, analysis);
  }
  const ends = await seriesEnds(deps, analyses, feedback, series, own, nowMs);
  const covered = coveredBySeriesEnd(series, ends);
  const rankedAll = collapseSeries(
    rankThings(
      analyzed.filter((a) => !covered.has(a.analysis.threadId)),
      feedback,
      nowMs,
    ),
    series,
  );
  // What was hidden, set aside or folded into a series is not part of a matter any more.
  const listed = new Set(rankedAll.map((t) => t.threadId));
  const found = findBundles(inputs.filter((t) => listed.has(t.threadId)));
  const reads = new Map<string, BundleRead>();
  for (const bundle of found) {
    const signature = bundleSignature(
      bundle.threadIds,
      (id) => byThread.get(id)?.lastMessageKey ?? 0,
    );
    reads.set(bundle.id, {
      signature,
      edges: await deps.insights.getBundleRead(signature),
      threadIds: bundle.threadIds,
      stale: bundle.threadIds.some(
        (id) => (currentKey.get(id) ?? 0) > (byThread.get(id)?.lastMessageKey ?? 0),
      ),
      cards: bundle.threadIds.flatMap((id) => {
        const a = byThread.get(id);
        return a === undefined ? [] : [cardOf(a)];
      }),
    });
  }
  const all = arrangeThings(rankedAll, found, (id) => reads.get(id)?.edges ?? []);
  const ranked: RankedThing[] = [];
  for (const thing of all.slice(0, Math.max(0, limit))) {
    const analysis = byThread.get(thing.threadId);
    if (analysis === undefined) continue;
    const current = currentKey.get(thing.threadId) ?? analysis.lastMessageKey;
    const stale = current > analysis.lastMessageKey;
    const record = stale
      ? null
      : await deps.insights.getPrepared(analysis.threadId, analysis.lastMessageKey);
    ranked.push({
      analysis,
      thing: {
        ...thing,
        ...(record === null ? {} : { prepared: record.work }),
        ...(stale ? { updating: true } : {}),
      },
    });
  }
  return {
    ranked,
    total: all.length,
    now: all.filter((t) => t.now === true).length,
    bundles: [...reads.values()],
  };
}

export async function listThings(
  deps: AgentReadDeps,
  nowMs: number,
  limit?: number,
): Promise<ThingsPage> {
  const { ranked, total, now } = await rankedThings(deps, nowMs, limit);
  return { things: ranked.map((r) => r.thing), total, now };
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

/** A thread as the reading of one thread sees it: its view, and its reading if that shows. */
interface OneThread {
  readonly accountId: string;
  readonly lastMessageKey: number;
  readonly analysis: ThreadAnalysis | null;
}

/**
 * The thread's reading when it shows, by the same bar as the list: of the thread's last message,
 * sure enough, not hidden, not covered by a rule, not answered by the person (ADR 0112), and let in
 * by a path (ADR 0066, rule 2). Null for
 * a thread that is not there or whose account has no consent; `analysis` null when nothing shows.
 */
async function oneThread(
  deps: AgentReadDeps,
  threadId: string,
  runtimeId: string | undefined,
  nowMs: number,
): Promise<OneThread | null> {
  const view = await deps.store.getThread(threadId, { visibleOnly: true });
  if (view === null) return null;
  const consented = await consentedAccounts(deps, runtimeId);
  if (!consented.has(view.thread.accountId)) return null;
  const lastKey = view.thread.lastMessageKey;
  const base = { accountId: view.thread.accountId, lastMessageKey: lastKey };
  const [[analysis], feedback, rules, accounts, answering] = await Promise.all([
    deps.insights.listAnalyses(ANALYZER_VERSION, [threadId]),
    deps.insights.listFeedback(),
    deps.insights.listRules(),
    deps.accounts.list(),
    answeringThreads(deps, nowMs),
  ]);
  const own = new Set(accounts.map((a) => lower(a.address)));
  // A reading of an older message is never shown here, so the person's answer in the thread
  // already leaves it out; one in the outbox does so too, as in the list (ADR 0112).
  if (
    analysis === undefined ||
    analysis.lastMessageKey !== lastKey ||
    answering.has(threadId) ||
    categoryRuleCovers(rules, analysis) ||
    rulesCoverThread(
      rules,
      view.messages.map((m) => ({ from: m.from.address })),
      [...own],
    )
  ) {
    return { ...base, analysis: null };
  }
  // The same condition as the list's (ADR 0066, rule 2). Only a reading let in by what it asks of
  // the person needs this thread's signals; one with a fact on the needed side shows without them.
  const path = shownPath(analysis, { feedback, nowMs });
  if (path === null) return { ...base, analysis: null };
  if (path !== "state") {
    const other = otherPerson(view.messages, own);
    const sender = other === null ? "" : lower(other.address);
    const signals = await signalsOf(
      analysis,
      view.messages,
      view.thread.subject,
      own,
      await writtenTo(deps.store, nowMs),
      sender,
      lookups(deps.store, nowMs),
    );
    if (shownPath(analysis, { feedback, nowMs, signals, senderAddress: sender }) === null) {
      return { ...base, analysis: null };
    }
  }
  return { ...base, analysis };
}

/**
 * The thread's reading if it shows in Matters now, with the thread's account: what a notice of
 * "this matters" stands on (ADR 0106, rule 3). Null while AI is off, without consent, or when it
 * does not show.
 */
export async function shownReading(
  deps: AgentReadDeps,
  threadId: string,
  nowMs: number = Date.now(),
): Promise<{ readonly analysis: ThreadAnalysis; readonly accountId: string } | null> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return null;
  const one = await oneThread(deps, threadId, settings.runtimeId, nowMs);
  return one?.analysis ? { analysis: one.analysis, accountId: one.accountId } : null;
}

/**
 * What the agent already has for one ordinary thread (ADR 0063), from the store alone. Nothing is
 * read beyond `available` while AI is off or the thread's account has no consent. The reading shows
 * only when it is of the thread's last message, on the person or waiting, sure enough, not hidden
 * and not covered by a rule: the same bar as the list, for this one thread.
 */
export async function readThreadAgent(
  deps: AgentReadDeps,
  threadId: string,
  nowMs: number = Date.now(),
): Promise<ThreadAgentView> {
  const none: ThreadAgentView = { available: false, reading: null, facts: [], prepared: null };
  const settings = await deps.settings.get();
  if (!settings.enabled) return none;
  const one = await oneThread(deps, threadId, settings.runtimeId, nowMs);
  if (one === null) return none;
  const record = await deps.insights.getPrepared(threadId, one.lastMessageKey);
  const prepared = record?.work ?? null;
  const analysis = one.analysis;
  if (analysis === null) return { available: true, reading: null, facts: [], prepared };
  return {
    available: true,
    reading: { state: analysis.state, headline: analysis.headline },
    // The facts ride with the reading and under the same conditions (ADR 0075, rule 1).
    facts: analysis.facts.map((f) => ({
      kind: f.kind,
      who: f.who,
      ...(f.dueMs === undefined ? {} : { dueMs: f.dueMs }),
      quote: f.evidence.quote,
      messageKey: f.evidence.messageKey,
    })),
    prepared,
  };
}

/** The newest entries of a talk that are read and shown (ADR 0064). */
export const MAX_TALK_SHOWN = 200;

/**
 * The talk about one thread, oldest first (ADR 0064, rule 13): a read of the store alone. Empty
 * while AI is off or the thread's account has no consent, like the rest of a thread's agent view.
 */
export async function readTalk(
  deps: AgentReadDeps,
  threadId: string,
): Promise<readonly TalkEntry[]> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return [];
  const view = await deps.store.getThread(threadId, { visibleOnly: true });
  if (view === null) return [];
  const consented = await consentedAccounts(deps, settings.runtimeId);
  if (!consented.has(view.thread.accountId)) return [];
  return deps.insights.listTalk(threadId, MAX_TALK_SHOWN);
}

/**
 * A talk across all mail, oldest first (ADR 0064, rule 13; ADR 0086): a read of the store alone.
 * With `talkId`, that talk; without it, every entry across all mail. With `beforeId`, the page
 * before that entry (rule 13). Empty while AI is off or no account has consent. A hit or a quote
 * whose thread is gone, hidden, or of an account that has since lost its consent is left out, so a
 * removed thread never shows.
 */
export async function readTalkAll(
  deps: AgentReadDeps,
  talkId?: number,
  beforeId?: number,
): Promise<readonly TalkEntry[]> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return [];
  const consented = await consentedAccounts(deps, settings.runtimeId);
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
 * How many threads reading this window would send: the same selection the reading uses, over the
 * accounts the person is about to agree to. Local only; nothing leaves the machine.
 */
export async function readEstimate(
  deps: Pick<AgentReadDeps, "store" | "accounts"> & {
    readonly insights?: Pick<AgentReadDeps["insights"], "listRules">;
  },
  nowMs: number,
  input: { readonly accountIds: readonly string[]; readonly windowDays: number },
): Promise<ReadEstimate> {
  const wanted = new Set(input.accountIds);
  const [all, accounts, rules] = await Promise.all([
    deps.store.listThreadsSince(nowMs - input.windowDays * DAY_MS, CANDIDATE_LIMIT),
    deps.accounts.list(),
    deps.insights?.listRules() ?? Promise.resolve([]),
  ]);
  const picked = selectCandidates(
    all.filter((t) => wanted.has(t.accountId)),
    {
      nowMs,
      windowDays: input.windowDays,
      ownAddresses: accounts.map((a) => a.address),
      rules,
    },
  );
  return { threads: picked.length, capped: all.length >= CANDIDATE_LIMIT };
}

/**
 * The talks across all mail, the latest first (ADR 0086, rule 5): a read of the store alone. A talk
 * with no entries is left out: it is the one the person is about to start. Empty while AI is off or
 * no account has consent, like the talk itself.
 */
export async function readTalks(deps: AgentReadDeps): Promise<readonly TalkSummary[]> {
  const settings = await deps.settings.get();
  if (!settings.enabled) return [];
  const consented = await consentedAccounts(deps, settings.runtimeId);
  if (consented.size === 0) return [];
  return (await deps.insights.listTalks()).filter((t) => t.entries > 0);
}
