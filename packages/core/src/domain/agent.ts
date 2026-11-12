import type { WholeMediaType } from "./fileText.ts";

/**
 * Agents run on the person's own plans (ADR 0051) and read mail for the person's prompts (ADR 0116,
 * 0117), asks and drafts. This file holds the vocabulary and the one pure rule that decides whether work may
 * run now. Nothing here talks to a runtime or reads mail.
 */

export type AgentRuntimeId = string;

/**
 * - `missing`: the program is not on this machine.
 * - `signedOut`: found, but the person has not signed in with a plan.
 * - `found`: signed in; has not yet passed the test with a made-up message (ADR 0051, rule 5).
 * - `ready`: passed the test; may receive mail the person agreed to send.
 * - `failed`: the check itself broke; `problem` says how.
 * - `notRunning`: a server on this machine that does not answer (ADR 0119, rule 6).
 * - `noModel`: it answers, but no model that runs here is installed (ADR 0119, rule 6).
 */
export type AgentRuntimeStatus =
  | "missing"
  | "signedOut"
  | "found"
  | "ready"
  | "failed"
  | "notRunning"
  | "noModel";

/** One window of a plan's limits. */
export interface PlanWindow {
  /** 0 to 100. */
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

/** The plan's windows as the runtime last reported them. */
export interface PlanLimits {
  /** The short window (five hours on Claude Code; the shorter Codex reports). */
  readonly session?: PlanWindow;
  /** The long window (seven days on Claude Code; the longer Codex reports). */
  readonly week?: PlanWindow;
  /** The plan's own allowance is spent and the runtime bills on top of it. */
  readonly usingOverage: boolean;
  /** When the runtime said so; limits are known only after a turn or a read, so they age. */
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
  /**
   * The levels of effort the runtime takes (ADR 0118, rule 4). Absent or empty: it takes none, and
   * no effort is ever sent to it.
   */
  readonly efforts?: readonly AgentEffort[];
  /**
   * The levels of each model, when they differ by model (ADR 0119, rule 9). When present, it is
   * what a model takes, `efforts` is not read, and a model it does not name takes none.
   */
  readonly modelEfforts?: Readonly<Record<string, readonly AgentEffort[]>>;
  /**
   * The model every kind of work starts on, for a runtime with no fixed model names (ADR 0119,
   * rule 4). Absent: the runtime's names are fixed and the starting choice is the app's own.
   */
  readonly defaultModel?: string;
  /**
   * The model each kind of work starts on, where the runtime suggests one per kind (ADR 0120): a
   * smaller model for understanding mail than for writing. A kind it does not name, or names a
   * model it does not list, starts as `defaultModel` says.
   */
  readonly defaultModels?: Readonly<Partial<Record<AgentWorkKind, string>>>;
  /**
   * The runtime has no plan (ADR 0119, rule 7): no windows, shares or limits apply or show, and
   * the gates of the plan always pass. Absent: it runs on a plan.
   */
  readonly noPlan?: boolean;
  /**
   * Its windows are read apart from its turns and can be stale (ADR 0120, rule 9): the first
   * refusal for a limit in the background pauses the reading until the person continues it, with
   * the time the runtime names. The gates of the windows apply as for any runtime with a plan.
   */
  readonly pausesOnLimit?: boolean;
  /**
   * How many characters of untrusted text (mail and the person's words) one turn on each model may
   * carry (ADR 0119, rule 8). Requests sized from mail are made to fit it; a model it does not name,
   * or a runtime without it, keeps the app's own sizes.
   */
  readonly modelInputChars?: Readonly<Record<string, number>>;
  /**
   * It can run a turn with our read-only tools (ADR 0083). Set by the app from the port, not by
   * the runtime. Absent: it cannot, and the search runs in turns without tools.
   */
  readonly tools?: boolean;
  /**
   * The models that can use our tools (ADR 0119, rule 10). Absent: every model of a runtime with
   * `tools` can. The search in a loop runs only on such a model; another plans its searches in
   * turns without tools.
   */
  readonly toolModels?: readonly string[];
  /**
   * What each model takes whole of a file with no text (ADR 0090; ADR 0119, rule 10). Absent: a
   * runtime that takes files takes every kind on every model. A model it does not name takes none.
   */
  readonly modelFiles?: Readonly<Record<string, readonly WholeMediaType[]>>;
  /** Mail sent to it stays on this machine (ADR 0119, rule 5): the consent question says so. */
  readonly onThisMachine?: boolean;
  /**
   * How many turns of a reading may run side by side. Absent: the app's own number. A runtime
   * with no plan always runs one at a time (ADR 0119, rule 7).
   */
  readonly turnsAtOnce?: number;
  readonly limits?: PlanLimits;
  /** A sentence for the person, when the runtime cannot be used now (`status` not `found`/`ready`). */
  readonly problem?: string;
}

/**
 * The levels a model takes on this runtime (ADR 0118, rule 4; ADR 0119, rule 9): its own when the
 * runtime lists levels per model, else the runtime's. Undefined or empty: none.
 */
export function levelsFor(
  runtime: Pick<AgentRuntimeInfo, "efforts" | "modelEfforts"> | null | undefined,
  model: string,
): readonly AgentEffort[] | undefined {
  if (runtime === null || runtime === undefined) return undefined;
  if (runtime.modelEfforts !== undefined) {
    return Object.hasOwn(runtime.modelEfforts, model) ? runtime.modelEfforts[model] : [];
  }
  return runtime.efforts;
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

/** Every kind of file that can go whole (ADR 0090). */
export const WHOLE_MEDIA_TYPES: readonly WholeMediaType[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/** Whether a turn on `model` may use our tools (ADR 0083; ADR 0119, rule 10). */
export function modelUsesTools(
  runtime: Pick<AgentRuntimeInfo, "tools" | "toolModels"> | null | undefined,
  model: string,
): boolean {
  if (runtime?.tools !== true) return false;
  return runtime.toolModels === undefined || runtime.toolModels.includes(model);
}

/**
 * The kinds of file with no text that go whole to a turn on `model` (ADR 0090; ADR 0119, rule
 * 10): what the runtime lists for the model, else everything when the runtime takes files, else none.
 */
export function wholeTypesFor(
  runtime: Pick<AgentRuntimeInfo, "modelFiles"> | null | undefined,
  takesFiles: boolean,
  model: string,
): readonly WholeMediaType[] {
  if (!takesFiles) return [];
  const map = runtime?.modelFiles;
  if (map === undefined) return WHOLE_MEDIA_TYPES;
  return Object.hasOwn(map, model) ? (map[model] ?? []) : [];
}

/**
 * The gate of the plan for the runtime that runs the turn (ADR 0119, rule 7): a runtime with no
 * plan has no windows to keep to, so it always passes; any other is `mayRun`, unchanged.
 */
export function mayRunOn(
  runtime: Pick<AgentRuntimeInfo, "noPlan"> | null | undefined,
  priority: AgentPriority,
  limits: PlanLimits | undefined,
  budget: AgentBudget,
  nowMs: number,
): MayRun {
  if (runtime?.noPlan === true) return { ok: true };
  return mayRun(priority, limits, budget, nowMs);
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

// --- Kinds of mail (ADR 0068) ---

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

/** What preparing a thing gives: a draft, or what is missing with up to three ways forward. */
export type PreparedWork =
  | { readonly kind: "draft"; readonly body: string; readonly nudge: boolean }
  | { readonly kind: "needs"; readonly missing: string; readonly directions: readonly string[] };

/**
 * What the agent already has for one ordinary thread (ADR 0063, as amended by ADR 0117): work the
 * person asked for, for the thread as it stands. `available` is false while AI is off or the
 * thread's account has no consent; then nothing else is read.
 */
export interface ThreadAgentView {
  readonly available: boolean;
  readonly prepared: PreparedWork | null;
}

/**
 * What preparing for a person gives: the work, or a closing in their own words (ADR 0054). A
 * closing is recorded as feedback and is never stored as prepared work.
 */
export type PrepareResult = PreparedWork | { readonly kind: "closed"; readonly reason: string };

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
  /** The message it was about; a newer message makes it stale. */
  readonly lastMessageKey: number;
  /** Lowercase address of the other person; what a rule offer for the sender counts. */
  readonly senderAddress: string;
  /**
   * `closed`: nothing to answer (from a talk or from typed words). `notImportant` and `later`
   * are kept from earlier versions, which set them on rows of the built-in list (ADR 0117).
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
}

/** What went to which runtime. It holds no mail text (ADR 0051, rule 8). */
export interface LedgerEntry {
  readonly atMs: number;
  readonly runtimeId: AgentRuntimeId;
  readonly accountId: string;
  /**
   * `remember` is the turn that keeps what the person typed (ADR 0054): `threads` is 0, since no
   * thread's mail went. `talk` is a turn of the person's talk (ADR 0064): about a thread, one
   * thread went; across all mail, the threads that were sent for the answer. `consent` and `revoke`
   * record the person's choice, with `threads` 0 (lines of earlier versions may count the threads
   * the screen named). `prompt` is one batch of a prompt (ADR 0116, rule 9): the threads of that
   * account that went. `analysis` is a reading of an earlier version (ADR 0117), kept in the
   * ledger as it was.
   */
  readonly purpose: "analysis" | "prepare" | "remember" | "talk" | "prompt" | "consent" | "revoke";
  readonly threads: number;
  /**
   * The effort sent with the turn (ADR 0118, rule 7). Absent when none was sent, and on every line
   * written before it was kept.
   */
  readonly effort?: AgentEffort;
}

/** A prepared draft or question, kept for the thing it was made for. */
export interface PreparedRecord {
  readonly threadId: string;
  readonly lastMessageKey: number;
  readonly work: PreparedWork;
  readonly preparedAtMs: number;
}

// --- Settings and consent (ADR 0051, rule 6) ---

/** Which model does which kind of work. */
export interface AgentModels {
  /** Reading mail for a prompt, and other turns that understand mail (`P0` to `P3`). */
  readonly understand: string;
  /** A draft or question the person asked for (`P0`). */
  readonly write: string;
  /** Answering the person's questions about all their mail (ADR 0064, rule 8). */
  readonly answer: string;
  /** Naming a talk across all mail (`P3`, ADR 0086, rule 8). `titles: "off"` names none. */
  readonly titles: string;
}

export const DEFAULT_AGENT_MODELS: AgentModels = {
  understand: "haiku",
  write: "sonnet",
  answer: "sonnet",
  titles: "haiku",
};

/** The value of `models.titles` that turns the naming of talks off (ADR 0086, rule 8). */
export const TITLES_OFF = "off";

/** The kinds of work that have a model, and so an effort (ADR 0118, rule 1). */
export type AgentWorkKind = keyof AgentModels;

export const AGENT_WORK_KINDS: readonly AgentWorkKind[] = [
  "understand",
  "write",
  "answer",
  "titles",
];

/** How hard a runtime is asked to think, lowest first (ADR 0118, rule 2). */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** What the person sets for a kind of work: a level, or `default`, which sends none. */
export type AgentEffortSetting = AgentEffort | "default";

export const AGENT_EFFORT_SETTINGS: readonly AgentEffortSetting[] = ["default", ...AGENT_EFFORTS];

/** The effort of each kind of work, beside its model (ADR 0118, rule 1). */
export type AgentEfforts = { readonly [K in AgentWorkKind]: AgentEffortSetting };

/** ADR 0118, rule 3. */
export const DEFAULT_AGENT_EFFORTS: AgentEfforts = {
  understand: "low",
  write: "default",
  answer: "default",
  titles: "low",
};

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (AGENT_EFFORTS as readonly string[]).includes(value);
}

export function isAgentEffortSetting(value: unknown): value is AgentEffortSetting {
  return value === "default" || isAgentEffort(value);
}

/**
 * The effort a turn sends, from a setting and the levels the runtime lists (ADR 0118, rules 2 and
 * 4): `default` and a level the runtime does not list send none (`undefined`).
 */
export function resolveEffort(
  setting: AgentEffortSetting | undefined,
  levels: readonly AgentEffort[] | undefined,
): AgentEffort | undefined {
  if (setting === undefined || setting === "default") return undefined;
  return levels?.includes(setting) === true ? setting : undefined;
}

/** The effort of a turn that runs on the model of `kind` (ADR 0118, rule 1). */
export function effortFor(
  kind: AgentWorkKind,
  settings: Pick<AgentSettings, "efforts">,
  levels: readonly AgentEffort[] | undefined,
): AgentEffort | undefined {
  return resolveEffort(settings.efforts[kind], levels);
}

/** `{ effort }` to spread into a request or a ledger line, or nothing when no effort is sent. */
export function withEffort(effort: AgentEffort | undefined): { readonly effort?: AgentEffort } {
  return effort === undefined ? {} : { effort };
}

/**
 * Efforts read back from stored settings (ADR 0118, rule 8): a kind missing, or holding a value
 * this build does not know, gets its starting value.
 */
export function readEfforts(raw: unknown): AgentEfforts {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (kind: AgentWorkKind): AgentEffortSetting => {
    const value = stored[kind];
    return isAgentEffortSetting(value) ? value : DEFAULT_AGENT_EFFORTS[kind];
  };
  return {
    understand: pick("understand"),
    write: pick("write"),
    answer: pick("answer"),
    titles: pick("titles"),
  };
}

/** What the person chose on one runtime: a model and an effort for each kind of work (ADR 0119, rule 4). */
export interface AgentChoices {
  readonly models: AgentModels;
  readonly efforts: AgentEfforts;
}

export interface AgentSettings {
  /** AI is off until the person turns it on. */
  readonly enabled: boolean;
  /** The runtime they chose; absent while none is. Only this runtime ever runs a turn (ADR 0119, rule 3). */
  readonly runtimeId?: AgentRuntimeId;
  /** The models of the chosen runtime: `choices` of `runtimeId` (ADR 0119, rule 4). */
  readonly models: AgentModels;
  /** The efforts of the chosen runtime (ADR 0118); stored settings without it read as the start. */
  readonly efforts: AgentEfforts;
  /**
   * The choices kept for each runtime, so changing the runtime and changing back loses nothing
   * (ADR 0119, rule 4). A runtime with no entry has not started yet: the service gives it its
   * starting choices when it lists models.
   */
  readonly choices?: Readonly<Record<AgentRuntimeId, AgentChoices>>;
  /** Share of the plan's week that background work may use, in percent (ADR 0051, rule 7). */
  readonly weekSharePercent: number;
  /** The plan's windows as last seen. */
  readonly limits?: PlanLimits;
  /** How much of the plan's week our own runs have used, in percent of the week. */
  readonly usedByUsPercent: number;
  /** The reset time of the week `usedByUsPercent` was counted in; a different one starts it again. */
  readonly usedWeekResetsAtMs?: number;
  /**
   * The person stopped the reading in the background (ADR 0053, rule 8; ADR 0117, rule 3). It
   * lasts until they continue it, across restarts. Absent in settings stored before it existed,
   * which reads as not paused.
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
  efforts: DEFAULT_AGENT_EFFORTS,
  weekSharePercent: DEFAULT_WEEK_SHARE_PERCENT,
  usedByUsPercent: 0,
};

/**
 * The runtime that settings stored before ADR 0119 were choices for: the only one there was. Its
 * flat `models` and `efforts` read as its choices; the choices of no runtime chosen are kept here.
 */
export const LEGACY_RUNTIME_ID = "claude-code";

/** The key of the choices of the runtime the settings name. */
function choiceKey(runtimeId: AgentRuntimeId | undefined): AgentRuntimeId {
  return runtimeId ?? LEGACY_RUNTIME_ID;
}

const MAX_MODEL_NAME = 128;

/** Models read back from stored settings: a kind missing or not a short string keeps its start. */
function readModels(raw: unknown): AgentModels {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (kind: AgentWorkKind): string => {
    const value = stored[kind];
    return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_NAME
      ? value
      : DEFAULT_AGENT_MODELS[kind];
  };
  return {
    understand: pick("understand"),
    write: pick("write"),
    answer: pick("answer"),
    titles: pick("titles"),
  };
}

function readChoices(raw: unknown): Record<AgentRuntimeId, AgentChoices> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<AgentRuntimeId, AgentChoices> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length === 0 || id.length > 64 || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    out[id] = { models: readModels(v.models), efforts: readEfforts(v.efforts) };
  }
  return out;
}

/**
 * Settings as stored, read defensively (a newer build may have written them). Both shapes read:
 * settings from before ADR 0119 hold one flat `models` and `efforts`, which read as the choices of
 * the runtime they name, or of Claude Code when they name none (rule 4). `models` and `efforts`
 * are then the choices of the chosen runtime, or the starting values when it has none yet.
 */
export function readAgentSettings(raw: unknown): AgentSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_AGENT_SETTINGS;
  // `windowDays` and `models.draftAhead` of settings stored before ADR 0117 are not read.
  const {
    windowDays: _window,
    choices: rawChoices,
    ...stored
  } = raw as Partial<AgentSettings> & { windowDays?: unknown; choices?: unknown };
  const runtimeId =
    typeof stored.runtimeId === "string" && stored.runtimeId.length > 0
      ? stored.runtimeId
      : undefined;
  const choices = readChoices(rawChoices) ?? {
    [choiceKey(runtimeId)]: {
      models: readModels(stored.models),
      efforts: readEfforts(stored.efforts),
    },
  };
  const { runtimeId: _id, ...rest } = stored;
  const mine = choices[choiceKey(runtimeId)];
  return {
    ...DEFAULT_AGENT_SETTINGS,
    ...rest,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    models: mine?.models ?? DEFAULT_AGENT_MODELS,
    efforts: mine?.efforts ?? DEFAULT_AGENT_EFFORTS,
    choices,
  };
}

/** What `AgentSettingsPort.update` takes. */
export type AgentSettingsPatch = Partial<
  Omit<AgentSettings, "limits" | "usedWeekResetsAtMs" | "choices">
> & {
  readonly limits?: PlanLimits | null;
  readonly usedWeekResetsAtMs?: number | null;
};

/**
 * The settings after a patch, for every store alike. `models` and `efforts` are the choices of the
 * runtime the settings name after the patch: given with a new `runtimeId`, they are that runtime's
 * starting choices. A new `runtimeId` alone reads that runtime's own choices back (ADR 0119,
 * rule 4); nothing of another runtime is changed.
 */
export function patchAgentSettings(
  current: AgentSettings,
  patch: AgentSettingsPatch,
): AgentSettings {
  const { limits, usedWeekResetsAtMs, models, efforts, ...rest } = patch;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) next[key] = value;
  }
  if (limits === null) delete next.limits;
  else if (limits !== undefined) next.limits = limits;
  if (usedWeekResetsAtMs === null) delete next.usedWeekResetsAtMs;
  else if (usedWeekResetsAtMs !== undefined) next.usedWeekResetsAtMs = usedWeekResetsAtMs;
  if (next.runtimeId === undefined) delete next.runtimeId;
  const key = choiceKey(next.runtimeId as AgentRuntimeId | undefined);
  const choices: Record<AgentRuntimeId, AgentChoices> = { ...(current.choices ?? {}) };
  if (current.choices === undefined) {
    // Settings made in memory before choices existed: what they hold is the old runtime's.
    choices[choiceKey(current.runtimeId)] = { models: current.models, efforts: current.efforts };
  }
  if (models !== undefined || efforts !== undefined) {
    const had = choices[key];
    choices[key] = {
      models: models ?? had?.models ?? DEFAULT_AGENT_MODELS,
      efforts: efforts ?? had?.efforts ?? DEFAULT_AGENT_EFFORTS,
    };
  }
  next.choices = choices;
  next.models = choices[key]?.models ?? DEFAULT_AGENT_MODELS;
  next.efforts = choices[key]?.efforts ?? DEFAULT_AGENT_EFFORTS;
  return next as unknown as AgentSettings;
}

/**
 * The choices a runtime starts with, from what it lists (ADR 0119, rule 4): the app's own starting
 * models when the runtime lists all of them (Claude Code), else each kind of work on the model the
 * runtime suggests for it (ADR 0120), else every kind, titles too, on the model it names as its
 * default, else on the first it lists. Efforts start as ever (ADR 0118,
 * rule 3); a level the model does not take is sent as none. Null when it lists no model.
 */
export function startingChoices(
  runtime: Pick<AgentRuntimeInfo, "models" | "defaultModel" | "defaultModels">,
): AgentChoices | null {
  const names = runtime.models;
  if (names.length === 0) return null;
  if (AGENT_WORK_KINDS.every((k) => names.includes(DEFAULT_AGENT_MODELS[k]))) {
    return { models: DEFAULT_AGENT_MODELS, efforts: DEFAULT_AGENT_EFFORTS };
  }
  const one =
    runtime.defaultModel !== undefined && names.includes(runtime.defaultModel)
      ? runtime.defaultModel
      : (names[0] as string);
  // A model the runtime suggests for a kind, when it lists it (ADR 0120); else the one above.
  const pick = (kind: AgentWorkKind): string => {
    const named = runtime.defaultModels?.[kind];
    return named !== undefined && names.includes(named) ? named : one;
  };
  return {
    models: {
      understand: pick("understand"),
      write: pick("write"),
      answer: pick("answer"),
      titles: pick("titles"),
    },
    efforts: DEFAULT_AGENT_EFFORTS,
  };
}

/**
 * The kinds of work whose chosen model the runtime does not list now (ADR 0119, rule 4): each waits
 * until the person picks another; nothing is put in its place. Titles turned off is not a model.
 */
export function unlistedKinds(
  settings: Pick<AgentSettings, "models">,
  runtime: Pick<AgentRuntimeInfo, "models"> | null | undefined,
): readonly AgentWorkKind[] {
  if (runtime === null || runtime === undefined) return [];
  return AGENT_WORK_KINDS.filter((k) => {
    const model = settings.models[k];
    if (k === "titles" && model === TITLES_OFF) return false;
    return !runtime.models.includes(model);
  });
}

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
  /**
   * The model the test ran on: the one for understanding mail (ADR 0119). The record holds for that
   * model only. Absent on records from before it was kept, which hold for the model chosen now:
   * they were made with what was chosen then.
   */
  readonly model?: string;
  readonly problem?: string;
  readonly testedAtMs: number;
}

// --- What the service says about itself ---

/** Where the reading in the background stands (ADR 0117, rule 3). */
export interface ReadingProgress {
  /**
   * - `idle`: nothing is being read in the background, or the rest waits for new mail.
   * - `checking`: looking at the runtime, or running the made-up test (ADR 0051, rule 5).
   * - `reading`: a pass is running.
   * - `paused`: waiting for the plan's allowance or for the person; `reason` says which.
   * - `off`: AI is off, has no consent, or the runtime is not ready.
   */
  readonly state: "idle" | "checking" | "reading" | "paused" | "off";
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
  /** The runtime's reason when it cannot be used. Fixed sentences written by us; never mail. */
  readonly problem?: string;
}

/** One runtime the app knows, and what was last seen of it (null: not looked at yet). */
export interface AgentRuntimeEntry {
  readonly id: AgentRuntimeId;
  readonly name: string;
  readonly info: AgentRuntimeInfo | null;
}

export interface AgentStatus {
  readonly settings: AgentSettings;
  /**
   * The chosen runtime as last seen. Null while none is chosen, or the service has not been able
   * to look at it.
   */
  readonly runtime: AgentRuntimeInfo | null;
  /** Every runtime the app knows, in the order it offers them (ADR 0119, rule 2). */
  readonly runtimes: readonly AgentRuntimeEntry[];
  /**
   * The kinds of work whose model the chosen runtime does not list now (ADR 0119, rule 4); they do
   * not run until the person picks another. Empty when every model is there.
   */
  readonly unlisted: readonly AgentWorkKind[];
  readonly consents: readonly AgentConsent[];
  readonly progress: ReadingProgress;
  /** Newest first. */
  readonly ledger: readonly LedgerEntry[];
}
