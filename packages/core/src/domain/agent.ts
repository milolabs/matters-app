/**
 * Agents run on the person's own plans (ADR 0051) and find the things that matter in mail
 * (ADR 0052). This file holds the vocabulary and the one pure rule that decides whether work may
 * run now. Nothing here talks to a runtime or reads mail.
 */

import type { ThreadFactView } from "./promiseLines.ts";

export type AgentRuntimeId = string;

/**
 * - `missing`: the program is not on this machine.
 * - `signedOut`: found, but the person has not signed in with a plan.
 * - `found`: signed in; has not yet passed the test with a made-up message (ADR 0051, rule 5).
 * - `ready`: passed the test; may receive mail the person agreed to send.
 * - `failed`: the check itself broke; `problem` says how.
 */
export type AgentRuntimeStatus = "missing" | "signedOut" | "found" | "ready" | "failed";

/** One window of a plan's limits. */
export interface PlanWindow {
  /** 0 to 100. */
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

/** The plan's windows as the runtime last reported them. */
export interface PlanLimits {
  /** The short window (five hours on Claude). */
  readonly session?: PlanWindow;
  /** The long window (seven days on Claude). */
  readonly week?: PlanWindow;
  /** The plan's own allowance is spent and the runtime bills on top of it. */
  readonly usingOverage: boolean;
  /** When the runtime said so; limits are known only after a turn, so they age. */
  readonly seenAtMs: number;
}

export interface AgentRuntimeInfo {
  readonly id: AgentRuntimeId;
  readonly name: string;
  readonly status: AgentRuntimeStatus;
  /** The plan's name as the runtime reports it, when it does. */
  readonly plan?: string;
  /** Model names the runtime accepts, for the choice per kind of work. */
  readonly models: readonly string[];
  readonly limits?: PlanLimits;
  /** A sentence for the person, when `status` is `signedOut` or `failed`. */
  readonly problem?: string;
}

/** `P0` what the person asked for; `P1` understanding new mail; `P2` drafts; `P3` reading back. */
export type AgentPriority = "P0" | "P1" | "P2" | "P3";

export interface AgentBudget {
  /** Share of the plan's week that background work (`P1` to `P3`) may use, in percent. */
  readonly weekSharePercent: number;
  /** How much of the plan's week our own runs have used so far, in percent of the week. */
  readonly usedByUsPercent: number;
  /** When the plan's week began. Absent: taken from the week window's reset time. */
  readonly weekStartMs?: number;
}

export const DEFAULT_WEEK_SHARE_PERCENT = 10;

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  weekSharePercent: DEFAULT_WEEK_SHARE_PERCENT,
  usedByUsPercent: 0,
};

export type MayRunReason = "sessionLimit" | "weekLimit" | "overage" | "budget";

export type MayRun =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MayRunReason; readonly untilMs?: number };

const WEEK_MS = 7 * 24 * 3_600_000;

/**
 * ADR 0051, rule 7. Work stops when a window is above its ceiling for the priority. The ceilings
 * are starting values to be calibrated on real use.
 */
const CEILING: Record<AgentPriority, { readonly session: number; readonly week: number }> = {
  P0: { session: 100, week: 100 },
  P1: { session: 70, week: 80 },
  P2: { session: 50, week: 70 },
  P3: { session: 25, week: 50 },
};

/**
 * Whether work of this priority may start now, from the last known windows. Pure.
 *
 * - `P0` stops only when a window is full. Everything else stops while the runtime is billing
 *   overage, above its ceiling in either window, or when background work has used more than its
 *   even share of the week so far and the week has no spare (see `withinShare`).
 * - A window whose reset time has passed counts as empty: what we know is older than the reset.
 * - Unknown limits (nothing run yet) allow `P0` and `P1` only, so the first turns of background
 *   work learn the windows and later priorities wait for them.
 * - `untilMs` is when the answer can change, when that is knowable.
 */
export function mayRun(
  priority: AgentPriority,
  limits: PlanLimits | undefined,
  budget: AgentBudget,
  nowMs: number,
): MayRun {
  const background = priority !== "P0";
  if (limits === undefined) {
    if (priority === "P2" || priority === "P3") return { ok: false, reason: "sessionLimit" };
    return background ? withinShare(budget, undefined, nowMs) : { ok: true };
  }
  if (background && limits.usingOverage) return { ok: false, reason: "overage" };
  const ceiling = CEILING[priority];
  const session = effective(limits.session, nowMs);
  const week = effective(limits.week, nowMs);
  if (priority === "P0" ? session >= ceiling.session : session > ceiling.session) {
    return refused("sessionLimit", limits.session?.resetsAtMs);
  }
  if (priority === "P0" ? week >= ceiling.week : week > ceiling.week) {
    return refused("weekLimit", limits.week?.resetsAtMs);
  }
  return background ? withinShare(budget, limits.week, nowMs) : { ok: true };
}

function refused(reason: MayRunReason, untilMs: number | undefined): MayRun {
  return untilMs === undefined ? { ok: false, reason } : { ok: false, reason, untilMs };
}

function effective(window: PlanWindow | undefined, nowMs: number): number {
  if (window === undefined || nowMs >= window.resetsAtMs) return 0;
  return window.usedPercent;
}

/**
 * Background work keeps to its share of the week, spread evenly over the week. On top, it may use
 * what the week would otherwise lose: what is left beyond the whole plan at an even pace until the
 * reset. Late in a quiet week that is most of what is left; the ceilings above still bound it.
 */
function withinShare(budget: AgentBudget, week: PlanWindow | undefined, nowMs: number): MayRun {
  const share = Math.max(0, budget.weekSharePercent);
  const start = budget.weekStartMs ?? (week === undefined ? undefined : week.resetsAtMs - WEEK_MS);
  // Without a week start the share cannot be spread, so it is a plain cap.
  const elapsed = start === undefined ? 1 : Math.min(1, Math.max(0, (nowMs - start) / WEEK_MS));
  const allowed = share * elapsed;
  if (budget.usedByUsPercent <= allowed) return { ok: true };
  const spareFromMs = spareFrom(week, nowMs);
  if (spareFromMs !== undefined && spareFromMs <= nowMs) return { ok: true };
  const caughtUpMs =
    start === undefined || share <= 0
      ? undefined
      : Math.ceil(start + (budget.usedByUsPercent / share) * WEEK_MS);
  const untilMs =
    caughtUpMs === undefined || spareFromMs === undefined
      ? (caughtUpMs ?? spareFromMs)
      : Math.min(caughtUpMs, spareFromMs);
  return refused("budget", untilMs);
}

/**
 * From when the week has spare: what is left exceeds the whole plan at an even pace until the reset.
 * Undefined when the week is not known or has already reset.
 */
function spareFrom(week: PlanWindow | undefined, nowMs: number): number | undefined {
  if (week === undefined || nowMs >= week.resetsAtMs) return undefined;
  const left = Math.max(0, 100 - week.usedPercent);
  return Math.ceil(week.resetsAtMs - (left / 100) * WEEK_MS);
}

// --- What the model says about a thread (ADR 0052) ---

/** `onYou`: the person owes something. `waiting`: someone owes the person. */
export type ThreadState = "onYou" | "waiting" | "fyi" | "none";

/** A passage of a message, kept only if it occurs in that message. */
export interface Evidence {
  readonly quote: string;
  /** The message's chronological key (`messageKey`). */
  readonly messageKey: number;
}

export interface ThreadFact {
  readonly kind: "promise" | "ask";
  /** Who is on the hook: the person (`you`) or the other side (`them`). */
  readonly who: "you" | "them";
  readonly dueMs?: number;
  readonly evidence: Evidence;
}

export type Stakes = "none" | "money" | "contract";

/**
 * What the thread asks of the person, apart from who owes what (ADR 0066).
 * - `reply`: someone expects an answer.
 * - `act`: pay, upload, confirm, renew: an act outside a reply.
 * - `decide`: the person may take or refuse something; nobody owes anything.
 * - `wait`: someone owes the person.
 * - `know`: it changes something for the person and there is nothing to do.
 */
export type AnalysisIntent = "reply" | "act" | "decide" | "wait" | "know" | "none";

/** What the main amount of a thread is: 1090 as a price, a debt and a refund are different things. */
export type AmountRole = "debt" | "price" | "refund" | "other";

/** The main amount of a thread, with the passage it was read from (found in the mail by code). */
export interface MatterAmount {
  readonly value: number;
  /** Upper case, three letters ("PLN"). */
  readonly currency: string;
  readonly role: AmountRole;
  readonly evidence: Evidence;
}

/** Whether the thread itself shows the matter finished. Separate from the intent. */
export type CaseStatus = "open" | "done" | "unknown";

/**
 * What kind of mail a thread is (ADR 0068). The model names it; code uses it for rules the person
 * makes ("do not show this kind"), and, for `official`, to let mail from a public office through.
 * A value this build does not know reads as `other`.
 */
export type ThreadCategory =
  | "personal"
  | "work"
  | "official"
  | "bill"
  | "paymentProblem"
  | "account"
  | "order"
  | "offer"
  | "terms"
  | "newsletter"
  | "notification"
  | "other";

export const THREAD_CATEGORIES: readonly ThreadCategory[] = [
  "personal",
  "work",
  "official",
  "bill",
  "paymentProblem",
  "account",
  "order",
  "offer",
  "terms",
  "newsletter",
  "notification",
  "other",
];

/** The values this build knows; a stored value outside them reads as absent. */
export const ANALYSIS_INTENTS: readonly AnalysisIntent[] = [
  "reply",
  "act",
  "decide",
  "wait",
  "know",
  "none",
];
export const AMOUNT_ROLES: readonly AmountRole[] = ["debt", "price", "refund", "other"];
export const CASE_STATUSES: readonly CaseStatus[] = ["open", "done", "unknown"];

export interface ThreadAnalysis {
  readonly threadId: string;
  readonly lastMessageKey: number;
  readonly analyzerVersion: number;
  readonly state: ThreadState;
  /** The model's one line. Shown as the title; never used for ranking or for "why". */
  readonly headline: string;
  readonly facts: readonly ThreadFact[];
  readonly stakes: Stakes;
  /** 0 to 1. */
  readonly confidence: number;
  readonly analyzedAtMs: number;
  /** What ignoring it costs. Absent: not asked for, and counted as `minor` (ADR 0058). */
  readonly consequence?: Consequence;
  /** The model's name for the matter, for bundling threads later (ADR 0058, rule 6). Text only. */
  readonly caseName?: string;
  /** What identifies the matter, each one found word for word in the thread. */
  readonly anchors?: readonly string[];
  /** What the thread asks of the person (ADR 0066). Absent on readings made before it. */
  readonly intent?: AnalysisIntent;
  /** The passage that shows the intent; present for every intent but `none`. */
  readonly intentEvidence?: Evidence;
  /** The main amount, when the thread has one and the passage was found. */
  readonly amount?: MatterAmount;
  /** When an offer or chance ends. Midnight UTC of that day. */
  readonly windowEndMs?: number;
  /** Present only when the thread is about this person's own matter, on a passage that was found. */
  readonly forYouEvidence?: Evidence;
  /** Whether the thread itself shows the matter finished; absent on older readings. */
  readonly status?: CaseStatus;
  /** What kind of mail it is (ADR 0068). Absent on older readings. */
  readonly category?: ThreadCategory;
}

/** `real`: a passage of the mail shows that something is lost if nothing is done. */
export type Consequence = "none" | "minor" | "real";

/** What preparing a thing gives: a draft, or what is missing with up to three ways forward. */
export type PreparedWork =
  | { readonly kind: "draft"; readonly body: string; readonly nudge: boolean }
  | { readonly kind: "needs"; readonly missing: string; readonly directions: readonly string[] };

/**
 * What the agent already has for one ordinary thread (ADR 0063). `available` is false while AI is
 * off or the thread's account has no consent; then nothing else is read. `reading` is the
 * thread's own reading when it is current and passes the one condition of the list (`shownPath`,
 * ADR 0066): sure enough, not hidden, not done, and let in by a quoted fact or by what it asks.
 */
export interface ThreadAgentView {
  readonly available: boolean;
  readonly reading: {
    readonly state: ThreadState;
    readonly headline: string;
  } | null;
  /**
   * The reading's promises and asks with their quotes (ADR 0075), for the lines under the messages
   * and the strip's summary. Empty exactly when `reading` is null.
   */
  readonly facts: readonly ThreadFactView[];
  readonly prepared: PreparedWork | null;
}

/**
 * What preparing for a person gives: the work, or a closing in their own words (ADR 0054). A
 * closing is recorded as feedback and is never stored as prepared work.
 */
export type PrepareResult =
  | PreparedWork
  | { readonly kind: "closed"; readonly reason: string; readonly alsoCovers?: number };

/**
 * A passage an answer in a talk rests on, shown as a citation (ADR 0064, rule 11). The code
 * checked that `text` occurs in the message `messageKey`; `from` is the sender as the person sees
 * them ("You" for their own message).
 */
export interface TalkQuote {
  readonly text: string;
  readonly from: string;
  readonly dateMs: number;
  readonly messageKey: number;
  /** The thread the quote is from. Set in the talk across all mail, where there are many. */
  readonly threadId?: string;
  /**
   * Set when the quote is from a file sent whole (ADR 0090, rule 5): the model read it from the
   * page, and there was no text to check it against.
   */
  readonly unchecked?: true;
}

/**
 * One thread an answer across all mail names (ADR 0064, rule 7). Everything but `note` is from
 * code and the store, never from the model: it is read when the answer is accepted.
 */
export interface TalkHit {
  readonly threadId: string;
  readonly who: string;
  readonly subject: string;
  /** The model's one line on why this thread, shown as text only. */
  readonly note: string;
  readonly lastMessageMs: number;
  /** The reading of the thread when it has a current one on the person or waiting; else null. */
  readonly state: "onYou" | "waiting" | null;
}

/**
 * What a question across all mail leaves for the next one of the same talk (ADR 0080): what the
 * agent came to think, the threads it read and the queries it ran. Written by the model from mail,
 * so it is data wherever it is read again; it is never instructions.
 */
export interface TalkCarry {
  readonly hypothesis: string;
  /** Threads that were read for the answer, most important first. */
  readonly threadIds: readonly string[];
  readonly queries: readonly string[];
}

export const MAX_CARRY_THREADS = 20;
export const MAX_CARRY_QUERIES = 24;

interface TalkEntryBase {
  readonly id: number;
  /** The thread the talk is about; null for a talk across all mail. */
  readonly threadId: string | null;
  /** Only across all mail: the talk it belongs to (ADR 0086). Absent on the entries of a thread. */
  readonly talkId?: number;
  readonly atMs: number;
}

/** What the person typed. */
export interface TalkYouEntry extends TalkEntryBase {
  readonly role: "you";
  readonly text: string;
}

/**
 * What the code accepted from the model (ADR 0064, rule 3). `text` is the answer, or the reason
 * of a closing; it is empty for a draft and a question, which live in the thread's prepared work.
 */
export interface TalkAgentEntry extends TalkEntryBase {
  readonly role: "agent";
  readonly kind: "answer" | "draft" | "question" | "closed" | "found";
  readonly text: string;
  readonly quotes: readonly TalkQuote[];
  readonly runtimeName: string;
  readonly model: string;
  /**
   * How many threads went to the runtime for this answer (ADR 0064, rule 10). For `found`, 0 means
   * that nothing was found and no mail was sent.
   */
  readonly threads: number;
  /** Only on `found`: the query the search ran, in the language of ADR 0025 (maybe empty). */
  readonly query?: string;
  /** Only on `found`: the threads the answer names, in its order. */
  readonly hits?: readonly TalkHit[];
  /** Only on `found`: what the next question of the talk builds on (ADR 0080). */
  readonly carry?: TalkCarry;
  /**
   * Only on `found`, and only when the loop of ADR 0083 answered: the searches it ran and the
   * threads it opened in full while it searched. Absent: the trail of ADR 0080 answered.
   */
  readonly loop?: TalkLoopUse;
  /**
   * Only on `found`, and only from the loop (ADR 0102): what the agent offers the person to do, as
   * the code accepted it. Absent: nothing was offered or nothing passed. Nothing of it has happened:
   * each offer waits for the person's press, and whether it was pressed is read from the app.
   */
  readonly offers?: readonly TalkOffer[];
  /**
   * Only on `found`, and only from the loop (ADR 0102): the counts the answer rests on, made by
   * code when the loop asked. The answer's text is the model's; these numbers are the code's.
   */
  readonly facts?: readonly TalkFact[];
}

/** What the loop of ADR 0083 did before the answer turn: searches run, threads opened in full, files read. */
export interface TalkLoopUse {
  readonly searches: number;
  readonly read: number;
  /** Attached files whose text it read (ADR 0087). Absent on an answer from before that. */
  readonly files?: number;
  /**
   * Calls of `count_mail` and `mail_overview` that sent senders and counts to the model (ADR
   * 0102). Absent: none.
   */
  readonly counts?: number;
  /** The names and queries of the person's views went to the model (`list_views`, ADR 0102). */
  readonly views?: true;
}

/** The kinds of offer (ADR 0102). Each has one rule in the ADR and one check in code. */
export type TalkOfferKind = "view" | "act" | "message";

/**
 * A view to save (ADR 0102, rule 6). `name`, `query` and `why` are the model's words, checked by
 * code and shown as text; the counts are made by code when the offer is accepted, in the accounts
 * agreed to and without the threads the rules cover. `notify`: saving it also turns on its
 * notifications (ADR 0071).
 */
export interface TalkViewOffer {
  readonly kind: "view";
  readonly name: string;
  readonly query: string;
  readonly why: string;
  readonly notify?: true;
  /** Messages the query matched, at most the cap. */
  readonly matches: number;
  /** More messages match than `matches`: the count stopped at the cap. */
  readonly matchesCapped: boolean;
  /** Unread among the messages counted: a lower bound when `matchesCapped`. */
  readonly unread: number;
}

/** What a clean-up offer does (ADR 0102, rule 7). Never spam, never a folder, never for good. */
export type TalkActAction = "archive" | "trash" | "markRead";

/**
 * A clean-up the person presses (ADR 0102, rule 7). The counts are code's at acceptance; what is
 * acted on is what the query matches when it is pressed.
 */
export interface TalkActOffer {
  readonly kind: "act";
  readonly action: TalkActAction;
  readonly query: string;
  readonly why: string;
  readonly matches: number;
  readonly matchesCapped: boolean;
  readonly unread: number;
}

/**
 * A new message the person opens as a draft (ADR 0102, rule 8). `to` holds only addresses the
 * person has written to before; the others are in `unknownTo`, never in the draft.
 */
export interface TalkMessageOffer {
  readonly kind: "message";
  readonly to: readonly string[];
  readonly unknownTo: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly why: string;
}

export type TalkOffer = TalkViewOffer | TalkActOffer | TalkMessageOffer;

/** One row of an overview kept as a fact: a sender (lowercase address) or a domain. */
export interface TalkFactRow {
  readonly key: string;
  readonly name?: string;
  readonly messages: number;
  readonly unread: number;
}

/** A count by code that an answer rests on (ADR 0102, rule 9). */
export type TalkFact =
  | {
      readonly kind: "count";
      readonly query: string;
      readonly matches: number;
      readonly capped: boolean;
      readonly unread: number;
    }
  | {
      readonly kind: "overview";
      readonly months: number;
      readonly senders: readonly TalkFactRow[];
      readonly domains: readonly TalkFactRow[];
    };

export type TalkEntry = TalkYouEntry | TalkAgentEntry;

/** An entry as it is given to the store, which assigns the id. */
export type NewTalkEntry = Omit<TalkYouEntry, "id"> | Omit<TalkAgentEntry, "id">;

/** The two entries one turn adds: the person's words, then the answer. */
export interface TalkResult {
  readonly entries: readonly TalkEntry[];
  /** Across all mail: the talk the turn was asked in, maybe one it started (ADR 0086). */
  readonly talkId?: number;
  /** A closing: how many older threads of its series went with it (ADR 0065). */
  readonly alsoCovers?: number;
}

/** The best things that matter, and how many there are in all (ADR 0055). */
export interface ThingsPage {
  readonly things: readonly Thing[];
  readonly total: number;
  /** How many of `total` are for now; they come first. Absent: the list has no sections. */
  readonly now?: number;
}

/** One item on the list of things that matter. */
export interface Thing {
  readonly threadId: string;
  readonly accountId: string;
  /** The other person, as the person knows them. */
  readonly who: string;
  readonly headline: string;
  readonly dueMs?: number;
  readonly lateByDays?: number;
  readonly quote: Evidence;
  /** Derived from the facts by code, never taken from the model's prose. */
  readonly why: string;
  readonly score: number;
  readonly prepared?: PreparedWork;
  /** The thread has a newer message than this was read from; a new reading is on its way. */
  readonly updating?: boolean;
  /** For now rather than for later (ADR 0058, rule 2). */
  readonly now?: boolean;
  /** The matter this is one thread of, when it shares one with others (ADR 0059). */
  readonly bundle?: ThingBundle;
  /** The same ask, sent again and again: this row stands for all of them (ADR 0061). */
  readonly series?: ThingSeries;
  /** What the thread asks of the person (ADR 0066); absent when the reading did not say. */
  readonly intent?: AnalysisIntent;
  readonly amount?: MatterAmount;
  /** When an offer or chance ends. */
  readonly windowEndMs?: number;
  /** Nothing has come for a while, so it is not known whether it is still open (ADR 0066, rule 4). */
  readonly check?: boolean;
  /** It asks for money or an act from a sender nobody can vouch for (ADR 0066, rule 5). */
  readonly suspect?: boolean;
  /**
   * The sender's domain did not confirm it sent the mail (authentication `fail`, ADR 0048). A
   * warning only: the thing keeps its place and its section (ADR 0079).
   */
  readonly unverified?: boolean;
  /** What kind of mail the reading says it is; for the "Not like this" control (ADR 0068). */
  readonly category?: ThreadCategory;
  /** It comes from a public office (ADR 0068, rule 4). */
  readonly official?: boolean;
}

/** Mails that repeat one matter from one sender, in threads of their own. */
export interface ThingSeries {
  /** Model text: shown as text only. */
  readonly name: string;
  /** Newest first, this thing's own thread among them. */
  readonly mails: readonly {
    readonly threadId: string;
    readonly headline: string;
    readonly dateMs: number;
  }[];
}

/** One open commitment holds up another, on a quote from the mail. */
export interface ThingEdge {
  readonly blocker: string;
  readonly blocked: string;
  readonly quote: string;
}

export interface ThingBundle {
  readonly id: string;
  /** Model text or mail text: shown as text only. */
  readonly name: string;
  readonly members: readonly {
    readonly threadId: string;
    readonly who: string;
    readonly headline: string;
    readonly lateByDays?: number;
  }[];
  readonly edges: readonly ThingEdge[];
}

/**
 * What the person meant by closing a thing (ADR 0066, rule 7). Closing is not complaining: only
 * `notRelevant` (the outcome of `notImportant`) lowers the sender.
 */
export type FeedbackOutcome = "done" | "notRelevant" | "taken" | "declined";
export const FEEDBACK_OUTCOMES: readonly FeedbackOutcome[] = [
  "done",
  "notRelevant",
  "taken",
  "declined",
];

/** What the person did with a thing (ADR 0052, rule 9). */
export interface ThingFeedback {
  readonly threadId: string;
  /** The thing it was about; a newer message makes a new thing. */
  readonly lastMessageKey: number;
  /** Lowercase address of the other person; lowers the score of later things from them. */
  readonly senderAddress: string;
  /**
   * `notImportant` and `closed` hide it for good; `later` hides it until `untilMs`. Only
   * `notImportant` lowers the score of the sender.
   */
  readonly kind: "notImportant" | "later" | "closed";
  readonly atMs: number;
  readonly untilMs?: number;
  /** Why it was closed, when the agent closed it from the person's words (ADR 0054). */
  readonly reason?: string;
  /** What the person meant by it (ADR 0066, rule 7). Absent on feedback from before it. */
  readonly outcome?: FeedbackOutcome;
  /** The folded name of the matter, kept with a decline so that the same offer stays closed. */
  readonly caseKey?: string;
  /** The amount of the matter at that time, kept with a decline. */
  readonly amountValue?: number;
}

/** Where a rule applies: one address, everything at a domain, or a kind of address. */
export type RuleScope = "sender" | "domain" | "type" | "category";

/** The one type so far: addresses that look like programs (`alerts@`, `updates@`...). */
export const PROGRAM_LIKE = "programLike";

/**
 * A rule kept in code (ADR 0054, rule 7). It costs no tokens and gives the same result every time.
 * It holds an address or a type and the person's own words, never mail.
 */
export interface AgentRule {
  readonly id: number;
  readonly scope: RuleScope;
  /** A lowercase address, a lowercase domain, or a type id. */
  readonly subject: string;
  /** A closed set: later steps may add more. */
  readonly action: "noReply";
  readonly actor: "person" | "agent";
  readonly atMs: number;
  /** What the person typed, when the agent acted on their words. Text only. */
  readonly words?: string;
}

/** What a caller gives to add a rule; the store adds the id and the time. */
export interface AgentRuleInput {
  readonly scope: RuleScope;
  readonly subject: string;
  readonly action: "noReply";
  readonly actor: "person" | "agent";
  readonly words?: string;
}

/** What the tray offers after a closing: one more click that makes a rule. Never wider than said. */
export interface RuleOffer {
  readonly scope: "sender" | "domain";
  /** The lowercase address of the other person in the thread, or their domain. */
  readonly subject: string;
}

/**
 * What the page asks for to add a rule: the sender of a thread (the address comes from the store,
 * never from the page), or a typed address, domain or type.
 */
export type AddRuleInput =
  | { readonly threadId: string; readonly scope: "sender" }
  | { readonly scope: RuleScope; readonly subject: string };

/** Where an instruction applies (ADR 0054, rule 7): everywhere, when reading, when writing, or one thread. */
export type InstructionScope = "general" | "understand" | "write" | "thread";

export const MAX_INSTRUCTION_CHARS = 500;
/** Active instructions that are not about one thread. */
export const MAX_INSTRUCTIONS = 30;

/**
 * Text the person keeps for the model (ADR 0054, rule 7). It is written by the person, or by the
 * agent from the person's typed words alone; it holds no mail text.
 */
export interface AgentInstruction {
  readonly id: number;
  readonly scope: InstructionScope;
  readonly text: string;
  /** Only for `thread`. */
  readonly threadId?: string;
  readonly actor: "person" | "agent";
  /** What the person typed, when the agent wrote it. Text only. */
  readonly words?: string;
  readonly atMs: number;
}

/** What a caller gives to add an instruction; the store adds the id and the time. */
export interface AgentInstructionInput {
  readonly scope: InstructionScope;
  readonly text: string;
  readonly threadId?: string;
  readonly actor: "person" | "agent";
  readonly words?: string;
}

/** What the person adds by hand in Settings: never a thread's. */
export interface AddInstructionInput {
  readonly scope: "general" | "understand" | "write";
  readonly text: string;
}

/** What the turn that remembers kept: each item as stored, for the page to show and undo. */
export interface RememberResult {
  readonly items: readonly (
    | { readonly kind: "instruction"; readonly instruction: AgentInstruction }
    | { readonly kind: "rule"; readonly rule: AgentRule }
  )[];
}

/**
 * One line of the local journal (ADR 0054, rule 6): what was done with a thing, who decided, and on
 * what grounds. It stays on the machine, is never sent to a model, and goes when the thread's mail
 * goes. `headline`, `words` and `reason` are text from mail, the person or a model: show them as
 * text only.
 */
export type JournalEntry = FeedbackJournalEntry | RuleJournalEntry | InstructionJournalEntry;

export interface FeedbackJournalEntry {
  readonly id: number;
  readonly atMs: number;
  readonly action: "closed" | "notImportant" | "later";
  readonly actor: "person" | "agent";
  readonly threadId: string;
  readonly lastMessageKey: number;
  readonly senderAddress: string;
  /** What the thing was about, from the reading of the mail. */
  readonly headline?: string;
  /** What the person typed, when the agent acted on their words. */
  readonly words?: string;
  /** What the agent gave as its ground. */
  readonly reason?: string;
  /** For `later`: when it comes back. */
  readonly untilMs?: number;
  /** How many older threads of its series this hid as well (ADR 0065); absent when none. */
  readonly alsoCovers?: number;
  /** Set when the person pressed Undo; the line stays. */
  readonly undoneAtMs?: number;
}

/** A rule was added. It has no thread: it holds an address and words, never mail. */
export interface RuleJournalEntry {
  readonly id: number;
  readonly atMs: number;
  readonly action: "ruleAdded";
  readonly actor: "person" | "agent";
  readonly ruleId: number;
  readonly scope: RuleScope;
  readonly subject: string;
  readonly words?: string;
  /** Set when the rule was removed; the line stays. */
  readonly undoneAtMs?: number;
}

/**
 * An instruction was added, by the person or by the agent on their words. A `thread` one carries its
 * thread, and goes with the thread's mail.
 */
export interface InstructionJournalEntry {
  readonly id: number;
  readonly atMs: number;
  readonly action: "instructionAdded";
  readonly actor: "person" | "agent";
  readonly instructionId: number;
  readonly scope: InstructionScope;
  readonly text: string;
  readonly threadId?: string;
  readonly words?: string;
  /** Set when the instruction was removed; the line stays. */
  readonly undoneAtMs?: number;
}

/** What a feedback write adds to the journal beyond the feedback itself. */
export interface JournalMemo {
  readonly actor: "person" | "agent";
  readonly headline?: string;
  readonly words?: string;
  readonly alsoCovers?: number;
}

/** What went to which runtime. It holds no mail text (ADR 0051, rule 8). */
export interface LedgerEntry {
  readonly atMs: number;
  readonly runtimeId: AgentRuntimeId;
  readonly accountId: string;
  /**
   * `remember` is the turn that keeps what the person typed (ADR 0054): `threads` is 0, since no
   * thread's mail went. `talk` is a turn of the person's talk (ADR 0064): about a thread, one
   * thread went; across all mail, the threads that were sent for the answer. `consent` and `revoke` record the person's choice: for `consent`, `threads` is how many
   * threads the screen said would go; for `revoke` it is 0. `prompt` is one batch of a prompt in
   * the query bar (ADR 0116, rule 9): the threads of that account that went.
   */
  readonly purpose: "analysis" | "prepare" | "remember" | "talk" | "prompt" | "consent" | "revoke";
  readonly threads: number;
}

/** A prepared draft or question, kept for the thing it was made for. */
export interface PreparedRecord {
  readonly threadId: string;
  readonly lastMessageKey: number;
  readonly work: PreparedWork;
  readonly preparedAtMs: number;
}

// --- Settings and consent (ADR 0051, rule 6) ---

/** Which model does which kind of work. `draftAhead: "off"` turns drafts before asking off. */
export interface AgentModels {
  /** Reading threads for what is open (`P1`, `P3`). */
  readonly understand: string;
  /** Drafts prepared before the person asks (`P2`). */
  readonly draftAhead: string;
  /** A draft or question the person asked for (`P0`). */
  readonly write: string;
  /** Answering the person's questions about all their mail (ADR 0064, rule 8). */
  readonly answer: string;
  /** Naming a talk across all mail (`P3`, ADR 0086, rule 8). `titles: "off"` names none. */
  readonly titles: string;
}

export const DEFAULT_AGENT_MODELS: AgentModels = {
  understand: "haiku",
  draftAhead: "haiku",
  write: "sonnet",
  answer: "sonnet",
  titles: "haiku",
};

export const DEFAULT_WINDOW_DAYS = 30;

/** The value of `models.draftAhead` that turns drafting ahead off. */
export const DRAFT_AHEAD_OFF = "off";

/** The value of `models.titles` that turns the naming of talks off (ADR 0086, rule 8). */
export const TITLES_OFF = "off";

export interface AgentSettings {
  /** AI is off until the person turns it on. */
  readonly enabled: boolean;
  /** The runtime they chose; absent while none is. */
  readonly runtimeId?: AgentRuntimeId;
  readonly models: AgentModels;
  /** How far back threads are read (ADR 0052, rule 3). */
  readonly windowDays: number;
  /** Share of the plan's week that background work may use, in percent (ADR 0051, rule 7). */
  readonly weekSharePercent: number;
  /** The plan's windows as last seen. */
  readonly limits?: PlanLimits;
  /** How much of the plan's week our own runs have used, in percent of the week. */
  readonly usedByUsPercent: number;
  /** The reset time of the week `usedByUsPercent` was counted in; a different one starts it again. */
  readonly usedWeekResetsAtMs?: number;
  /**
   * The person stopped the reading (ADR 0053, rule 8). It lasts until they continue it, across
   * restarts. Absent in settings stored before it existed, which reads as not paused.
   */
  readonly readingPaused?: boolean;
  /**
   * The agent searches in a loop with tools of ours (ADR 0083) instead of the plan and follow turns
   * of ADR 0080. Experimental; absent reads as off.
   */
  readonly talkLoop?: boolean;
  /**
   * `Needs you` was added to the saved views, or a view of that name was there already (ADR 0117,
   * rule 2): it is never added again, renamed, edited or deleted. Absent: not yet.
   */
  readonly needsYouAdded?: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  models: DEFAULT_AGENT_MODELS,
  windowDays: DEFAULT_WINDOW_DAYS,
  weekSharePercent: DEFAULT_WEEK_SHARE_PERCENT,
  usedByUsPercent: 0,
};

/** The person agreed that this account's mail goes to this runtime. */
export interface AgentConsent {
  readonly accountId: string;
  readonly runtimeId: AgentRuntimeId;
  readonly grantedAtMs: number;
}

/**
 * What the app last learned about a runtime by running its test (ADR 0051, rule 5), kept with
 * the plan the runtime reported at that time. A runtime is `ready` again after a restart only
 * while it reports the same plan.
 */
export interface AgentRuntimeRecord {
  readonly runtimeId: AgentRuntimeId;
  readonly status: "ready" | "failed";
  readonly plan?: string;
  readonly problem?: string;
  readonly testedAtMs: number;
}

// --- What the service says about itself ---

/** Where the reading of the window stands (ADR 0052, rule 3). */
export interface ReadingProgress {
  /**
   * - `idle`: nothing left to read, or the rest waits for new mail.
   * - `checking`: looking at the runtime, or running the made-up test (ADR 0051, rule 5).
   * - `reading`: a pass is running.
   * - `paused`: waiting for the plan's allowance or for the person; `reason` says which.
   * - `off`: AI is off, has no consent, or the runtime is not ready.
   */
  readonly state: "idle" | "checking" | "reading" | "paused" | "off";
  /** Threads of the window that have a reading of their latest message. */
  readonly done: number;
  /** Threads of the window that may be read. */
  readonly total: number;
  readonly reason?:
    | MayRunReason
    | "limit"
    | "signedOut"
    | "notPlan"
    | "runtime"
    | "consent"
    | "disabled"
    | "pausedByPerson";
  readonly untilMs?: number;
  /** How many things show now (ADR 0052, rule 6). */
  readonly found?: number;
  /**
   * Time left in this reading, from the turns finished so far (ADR 0053, rule 5). Absent until at
   * least 3 turns have finished; never from a constant.
   */
  readonly etaMs?: number;
  /** The runtime's reason when it cannot be used. Fixed sentences written by us; never mail. */
  readonly problem?: string;
  /** No thread of the window can be read: nothing to wait for. */
  readonly windowEmpty?: true;
}

export interface AgentStatus {
  readonly settings: AgentSettings;
  /** Null while the service has not been able to look at the runtime. */
  readonly runtime: AgentRuntimeInfo | null;
  readonly consents: readonly AgentConsent[];
  readonly progress: ReadingProgress;
  /** Newest first. */
  readonly ledger: readonly LedgerEntry[];
}
