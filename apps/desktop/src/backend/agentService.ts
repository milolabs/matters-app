import { randomUUID } from "node:crypto";
// Agents in the sync worker (ADR 0051, rule 10). Everything here is injected, so a test
// runs it over `FakeAgentRuntime` and the in-memory stores. Nothing logs mail text, subjects or
// addresses: errors carry fixed sentences only.
import type {
  AccountStorePort,
  ActMatches,
  AddInstructionInput,
  AddRuleInput,
  AgentEffort,
  AgentEffortSetting,
  AgentEfforts,
  AgentFile,
  AgentInsightStorePort,
  AgentInstruction,
  AgentKeyVaultPort,
  AgentModels,
  AgentPriority,
  AgentRequestBody,
  AgentRule,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentRuntimeRecord,
  AgentSettings,
  AgentSettingsPort,
  AgentStatus,
  AgentWorkKind,
  ClockPort,
  Draft,
  DraftContent,
  DraftFor,
  DraftStorePort,
  FileTextAnswer,
  GapSuggestion,
  KindRuntimes,
  MayRun,
  MessageBodyPort,
  MessageStorePort,
  PlanLimits,
  PreparedGuidance,
  PreparedWork,
  PrepareResult,
  PromptBadge,
  PromptCount,
  PromptList,
  PromptProgress,
  PromptRunResult,
  PromptThread,
  RankedSearchPort,
  ReadingProgress,
  ReadingStatus,
  ReadingWait,
  RememberResult,
  ReplyCheck,
  RewriteHow,
  RuleScope,
  SavedViewStorePort,
  SearchIndexPort,
  TalkCarry,
  TalkChoice,
  TalkEntry,
  TalkFact,
  TalkHit,
  TalkLoopUse,
  TalkOffer,
  TalkQuote,
  TalkResult,
  TalkSummary,
  ThemeInput,
  ThreadAgentView,
  WholeFileAnswer,
} from "@matters/core";
import {
  AGENT_WORK_KINDS,
  AgentRunError,
  acceptAnswers,
  acceptCheck,
  acceptFills,
  acceptOffers,
  acceptRewrite,
  acceptTalkAll,
  acceptTalkQuotes,
  acceptVerdicts,
  acceptWrite,
  actMatches,
  addNeedsYouView,
  apiKeyProblem,
  buildAnswerQuestionsRequest,
  buildCheckReplyRequest,
  buildFillGapsRequest,
  buildPreparedRequest,
  buildPromptRequest,
  buildRememberRequest,
  buildRewriteRequest,
  buildTalkAllRequest,
  buildTalkLoopRequest,
  buildTalkPlanRequest,
  buildTalkRequest,
  buildTalkTitleRequest,
  buildThemeRequest,
  buildWriteRequest,
  CredentialsUnavailableError,
  choicesOn,
  clean,
  countQuery,
  type DraftParts,
  draftGaps,
  everyKindOn,
  type HelpRefusal,
  inputCharsFor,
  isAgentEffortSetting,
  isAgentRunError,
  isAutomatedSender,
  isEmptyQuery,
  joinDraft,
  keyReadingOn,
  kindsOn,
  kindTakesMail,
  lastFromThem,
  levelsFor,
  MAX_CARRY_QUERIES,
  MAX_CARRY_THREADS,
  MAX_DRAFT_CHARS,
  MAX_GAPS,
  MAX_GUIDANCE_CHARS,
  MAX_HELP_DRAFT_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_INSTRUCTIONS,
  MAX_TALK_QUERY_CHARS,
  MAX_TALK_THREADS,
  MAX_THEME_DESCRIPTION_CHARS,
  MAX_WRITE_WORDS_CHARS,
  matchQuery,
  mayRunOn,
  modelListed,
  modelUsesTools,
  normalizeRuleSubject,
  ONE_THREAD_EXTRA_CHARS,
  PROMPT_VERSION,
  type PreparedAnswer,
  parsePreparedAnswer,
  parseQuery,
  parseRememberAnswer,
  parseTalkAllAnswer,
  parseTalkAnswer,
  parseTalkLoop,
  parseTalkPlan,
  parseTalkTitleAnswer,
  planUseOf,
  prepareReplyDraft,
  REWRITE_HOWS,
  resolveEffort,
  runtimesInUse,
  splitDraft,
  startingChoices,
  TALK_LOOP_TIME_CAP_MS,
  TALK_LOOP_TIME_MS,
  TALK_TIME_CAP_MS,
  TALK_TITLE_QUESTIONS,
  TITLES_OFF,
  themeTextOf,
  threadRoom,
  unlistedKinds,
  wholeFilesProblem,
  wholeTypesFor,
  withEffort,
  withFiles,
  withoutSignature,
} from "@matters/core";
import {
  type AgentApi,
  AgentUnavailableError,
  InvalidAgentSettingError,
  ThingNotFoundError,
} from "./agentApi.ts";
import {
  consentedAccounts,
  MAX_TALK_SHOWN,
  otherSenderAddress,
  preparedFor,
  readInstructions,
  readJournal,
  readRuleOffer,
  readRules,
  readTalk,
  readTalkAll,
  readTalks,
  readThreadAgent,
  senderHistory,
  whoOf,
} from "./agentReads.ts";
import { type MailToolsState, openMailTools, type ReadFileRecord } from "./mailTools.ts";
import { type PromptRuntime, PromptService } from "./promptService.ts";
import { type KeyTicket, RuntimeKeys } from "./runtimeKeys.ts";
import { followTrail, type TrailResult } from "./talkTrail.ts";
import { THEME_FORMAT } from "./themeFormat.ts";

/** A turn as it begins: what stops it, and the key it runs on (ADR 0141, rule 5). */
interface Turn {
  readonly signal: AbortSignal;
  readonly ticket: KeyTicket;
}

/** The queue of the list of reading switches, apart from every runtime's own: no runtime's id. */
const READING_LIST = "\u0000reading";

/** Threads with activity in this many days are read before older ones (`P1`, else `P3`). */
export const RECENT_DAYS = 2;
export const KICK_DEBOUNCE_MS = 2000;
/** After the time the plan named, before the pass that reads again: windows reset on the minute. */
export const RETRY_MARGIN_MS = 5000;
/** The newest messages of a thread that go to a model; older ones are dropped, not clipped. */
export const MAX_PROMPT_MESSAGES = 40;
const LEDGER_SHOWN = 10;

/**
 * The made-up message of the runtime test (ADR 0051, rule 5): a constant, never mail. It is judged
 * against `TEST_PROMPT` in the verdict turn of a prompt (ADR 0116), and its quote must be found in
 * the message it names for the test to pass, which also proves the quoting rule.
 */
export const TEST_PROMPT_QUOTE = "I will send you the signed contract by Friday";
/** The prompt of the runtime test: a constant, never the person's. */
export const TEST_PROMPT = "a promise to send a signed contract";
const TEST_THREAD: PromptThread = {
  subject: "Contract",
  messages: [
    {
      key: 1,
      dateMs: Date.UTC(2026, 0, 5, 9, 0),
      from: { name: "Alex Example", address: "alex@example.invalid" },
      fromOwn: false,
      text: `Hi,\n\n${TEST_PROMPT_QUOTE}. Could you confirm the address?\n\nAlex`,
    },
  ],
};

import { textForPrompt } from "./promptText.ts";

export { textForPrompt };

const lower = (s: string) => s.trim().toLowerCase();

/** What the service asks of a runtime. */
export type AgentRuntime = Pick<
  AgentRuntimePort,
  "id" | "name" | "inspect" | "run" | "runWithTools" | "takesFiles"
>;

export interface AgentServiceDeps {
  /**
   * Every runtime the app knows, in the order it offers them (ADR 0119, rule 2). A turn runs only
   * on the runtime of its kind of work (ADR 0121, rules 1 and 3); a kind with none runs nothing.
   */
  readonly runtimes: readonly AgentRuntime[];
  /**
   * The API keys of the runtimes billed to them (ADR 0141, rule 4), in main's vault. The service
   * only saves and removes them; the runtime's adapter reads its own. Absent: no key can be kept.
   */
  readonly keys?: AgentKeyVaultPort;
  readonly store: Pick<
    MessageStorePort,
    | "listThreadsSince"
    | "getThread"
    | "listWrittenTo"
    | "listSentMail"
    | "listReceivedMail"
    | "getByKeys"
    | "listSenderCounts"
    | "changesSince"
  >;
  /**
   * The person's saved views (ADR 0102): the loop's `list_views`, and the check of the views it
   * offers; the views a prompt reads for in the background (ADR 0117, rule 3). Absent: the
   * person has none (tests that do not ask about views).
   */
  readonly views?: Pick<SavedViewStorePort, "list">;
  /**
   * Where `Needs you` is added the first time AI is on with consent (ADR 0117, rule 2). Absent:
   * it is not added (tests that do not ask about it).
   */
  readonly starterViews?: Pick<SavedViewStorePort, "list" | "put" | "setPositions">;
  /** The saved views changed here, not by a window's request: the windows read them again. */
  onViewsChanged?(): void;
  /**
   * The search index, for the search of a talk across all mail (ADR 0064, rule 7.2). It is the
   * worker's own connection: the reader connection belongs to the router, not to this process.
   */
  readonly index: Pick<SearchIndexPort, "searchChunk" | "matchesAmong"> & RankedSearchPort;
  readonly bodies: Pick<MessageBodyPort, "getBodies" | "getHtml" | "getHtmlKinds">;
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly insights: AgentInsightStorePort;
  readonly settings: AgentSettingsPort;
  /** Drafts already answering a thread (the composer opens it instead of making another). */
  readonly drafts: Pick<DraftStorePort, "findByThread">;
  /** Stores a draft and tells the windows; the existing send path (`SendService.saveDraft`). */
  saveDraft(content: DraftContent): Promise<Draft>;
  readonly clock: ClockPort;
  /**
   * The text of one attached file, for the loop's `read_file` (ADR 0087): kept text, else a
   * download through the received cache and an extraction on the file worker.
   */
  readFile?(messageKey: number, partId: string): Promise<FileTextAnswer>;
  /**
   * The bytes of a file with no text, for the answer turn (ADR 0090, rule 8), through the same
   * cache. Without it, or with a runtime that does not take files, no file goes whole.
   */
  wholeFile?(messageKey: number, partId: string): Promise<WholeFileAnswer>;
  /**
   * HTML to the text the reader's page shows (`visibleText` of the mime adapter). Text hidden from
   * the person never reaches a model (ADR 0052, rule 8).
   */
  visibleText(html: string): string;
  /** Something the windows show changed (settings, progress, prepared work, a closing). */
  onChanged(): void;
  /**
   * A step of a turn across all mail (ADR 0064, rule 12; ADR 0080): a query that ran with the
   * threads it found, what a follow turn decided (`kind` "follow", the note in `note`), or, with
   * no kind, the search is over and that many threads go to the runtime. With the loop of ADR 0083
   * a step may also be "read" (a thread the agent opened, in `note`) or "note" (a line the model
   * wrote between its steps, in `note`); with ADR 0102, "count" (a query `count_mail` counted, the
   * messages in `threads` and the count as a line in `note`) or "look" (what `list_views` or
   * `mail_overview` looked at, in `note`). Not stored; the windows show it while the turn runs.
   */
  onTalkStep?(query: string, threads: number, kind?: TalkStepKind, note?: string): void;
  /** How far a prompt in the query bar is searched and read (ADR 0116, rule 9). Not stored. */
  onPromptProgress?(progress: PromptProgress): void;
  onError?(message: string): void;
  readonly kickDebounceMs?: number;
}

/** The kinds of step a turn across all mail reports (ADR 0080, 0083, 0102). */
export type TalkStepKind = "search" | "follow" | "read" | "note" | "count" | "look";

/** What the person is told when a runtime cannot be used; fixed sentences, no mail. */
const NOT_READY = "The assistant is not ready. Check it in Settings, then try again.";
const NO_CONSENT = "This account has not been agreed to for the assistant.";
/** An account that did not agree to the runtime of a turn (ADR 0121, rule 4). */
function noConsent(runtime: Pick<AgentRuntime, "id" | "name">): string {
  return runtime.id === ""
    ? NO_CONSENT
    : `This account has not been agreed to for ${runtime.name}. Choose it in Settings › Agents.`;
}

/** No account agreed to the runtime of a question across all mail (ADR 0121, rule 4). */
function noAccount(runtime: Pick<AgentRuntime, "name">): string {
  return `No account has been agreed to for ${runtime.name}. Choose one in Settings › Agents.`;
}
const USED_UP = "Your plan's allowance is used up for now. Try again when it resets.";

/** The plan each runtime runs on, as the person knows it, for the sentences that name it. */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude plan",
  codex: "ChatGPT plan",
};
const TALK_FAILED = "The assistant could not answer this. Try again.";
/** A theme turn whose answer is not one JSON object (ADR 0134, rule 12). */
export const NOT_A_THEME = "The assistant's answer was not a theme. Try again.";
const THEME_FAILED = "The assistant could not make a theme. Try again.";
/** The model is asked to name a talk at most this often in a run of the app (ADR 0086, rule 7). */
const MAX_TITLE_TRIES = 2;
const TALK_REJECTED = "That answer did not match your mail, so it is not shown.";
const NOTHING_FOUND = "No thread matched what I searched for. Try other words, a name or a time.";
/**
 * The text of an answer that only makes offers (ADR 0102): no thread and no count to answer from,
 * or an answer turn the code did not accept. Fixed: the model wrote none of it.
 */
export const OFFERS_ONLY =
  "Here is what I would suggest. Nothing happens until you press a button.";

/** The threads a question across all mail chose to read, from the trail or from the loop. */
type Found = Pick<TrailResult, "threadIds" | "queries" | "firstQuery" | "hypothesis"> & {
  /** Nothing ran, or nothing was found worth reading. */
  readonly nothing: boolean;
  /** Only from the loop (ADR 0083): what it did, which the entry of the answer then shows. */
  readonly loop?: TalkLoopUse;
  /** Only from the loop (ADR 0087, rule 9): the files it read, for the answer turn. */
  readonly files?: readonly ReadFileRecord[];
  /** Only from the loop (ADR 0102): what it offered, as the code accepted it. */
  readonly offers?: readonly TalkOffer[];
  /** Only from the loop (ADR 0102): what its tools counted, as facts for the answer. */
  readonly facts?: readonly TalkFact[];
};

/** What the loop did, for the entry of the answer; each count only when it did any (ADR 0087, 0102). */
const loopUse = (
  state: Pick<MailToolsState, "queries" | "opened" | "files" | "counts" | "viewsListed">,
): TalkLoopUse => ({
  searches: state.queries.length,
  read: state.opened.length,
  ...(state.files.length > 0 ? { files: state.files.length } : {}),
  ...(state.counts > 0 ? { counts: state.counts } : {}),
  ...(state.viewsListed ? { views: true as const } : {}),
});

/** A line the model wrote between its steps is shown at most this long (ADR 0083). */
const MAX_LOOP_NOTE_CHARS = 200;

/** What is seen of no runtime. */
const NO_INFO: AgentRuntimeInfo = { id: "", name: "No assistant", status: "missing", models: [] };

/** What stands for "no runtime chosen": it lists nothing and runs nothing (ADR 0119, rule 3). */
const NO_RUNTIME: AgentRuntime = {
  id: "",
  name: "No assistant",
  inspect: async () => NO_INFO,
  run: async () => {
    throw new AgentRunError("failed", "No assistant is chosen.");
  },
};

/** The kinds of work in the person's words, for a sentence about a model that is gone. */
const KIND_WORDS: Readonly<Record<AgentWorkKind, string>> = {
  understand: "understanding mail",
  write: "writing",
  answer: "questions about your mail",
  titles: "talk titles",
  appearance: "making themes",
};

/** A model the runtime no longer lists (ADR 0119, rule 4): said so, and nothing is put in its place. */
export function modelGone(runtimeName: string, model: string, kind: AgentWorkKind): string {
  return `${model} is not available on ${runtimeName} now. Choose another model for ${KIND_WORDS[kind]} in Settings.`;
}

/** A runtime of a turn that cannot be used now (ADR 0121, rule 3): that work waits, and says why. */
function notReady(runtime: Pick<AgentRuntime, "id" | "name">): string {
  return runtime.id === ""
    ? NOT_READY
    : `${runtime.name} is not ready. Check it in Settings, then try again.`;
}

/** `{ inputChars }` to spread into a request's options, or nothing when the runtime says nothing. */
function withInput(inputChars: number | undefined): { readonly inputChars?: number } {
  return inputChars === undefined ? {} : { inputChars };
}

/** What a window is told of a runtime: the id of its key is for the test record only. */
function shownInfo(info: AgentRuntimeInfo): AgentRuntimeInfo {
  if (info.keyId === undefined) return info;
  const { keyId: _keyId, ...shown } = info;
  return shown;
}

/** A runtime the person can do something with now: it is there, and nothing waits on them. */
function usable(info: AgentRuntimeInfo | null): boolean {
  const status = info?.status;
  return (
    status !== undefined &&
    status !== "signedOut" &&
    status !== "missing" &&
    status !== "notRunning" &&
    status !== "noModel" &&
    status !== "noKey" &&
    status !== "keyRefused"
  );
}

export class AgentService implements AgentApi {
  private readonly deps: AgentServiceDeps;
  /** What was last seen of each runtime, by id (ADR 0119, rule 2). */
  private readonly infos = new Map<string, AgentRuntimeInfo>();
  /** The ticket of the look, test or turn whose finding of each runtime is shown. */
  private readonly infoTickets = new Map<string, KeyTicket>();
  /** The runtime of each kind of work, as last read; every read of the settings keeps it. */
  private kinds: KindRuntimes = {};
  private progress: ReadingProgress = { state: "off", reason: "disabled" };
  private pass: Promise<void> | null = null;
  private again = false;
  /** Runtimes that wait for the person: signed out, or not on the plan. */
  private readonly blocked = new Map<string, "signedOut" | "notPlan">();
  private cancelKick: (() => void) | null = null;
  /** A pass at the time the plan said the reading can go on (ADR 0117, rule 3a). */
  private cancelRetry: (() => void) | null = null;
  /** Stops everything: AI off, a consent taken back. */
  private abort = new AbortController();
  /** Stops the work of one kind, when the kind moves to another runtime (ADR 0121, rule 3). */
  private readonly kindAborts = new Map<AgentWorkKind, AbortController>();
  /**
   * The key of each runtime billed to one (ADR 0141, rules 4 to 6): its commands one at a time,
   * the ticket of the key a turn, a look or a test began on, and the stop of the turns that run on
   * it, whatever chose the runtime: the kind's runtime or a talk's own choice.
   */
  private readonly runtimeKeys = new RuntimeKeys();
  /** The talk turns running, one per thread, each with its own way to be stopped. */
  private readonly talking = new Map<string, AbortController>();
  /** The turn across all mail that is running, if any: one at a time (ADR 0064, rule 7). */
  private talkingAll: AbortController | null = null;
  /** The running turn across all mail, to wait for after stopping it. */
  private talkingAllDone: Promise<TalkResult> | null = null;
  /** The talk the running turn across all mail was asked in (ADR 0086, rule 16). */
  private talkingAllIn: number | null = null;
  /** How often the model was asked to name a talk in this run of the app (ADR 0086, rule 7). */
  private readonly titleTries = new Map<number, number>();
  private stopped = false;
  /** The person paused the reading in the background (ADR 0117, rule 3); mirrors the setting. */
  private readingPaused = false;
  /**
   * The plan refused a turn in the background on a runtime that reports no windows (ADR 0120,
   * rule 9): the reading is paused until the person continues it. `untilMs` when it said so.
   */
  private limitHeld: { untilMs?: number } | null = null;
  /** The test of each runtime, so it never runs twice at once. */
  private readonly testing = new Map<
    string,
    {
      readonly ticket: KeyTicket;
      readonly test: Promise<AgentRuntimeInfo>;
      /** A test no press of the person's started, which goes only while the switch allows it. */
      readonly background: boolean;
    }
  >();
  /** The theme turn that is running, if any: one at a time (ADR 0134, rule 15). */
  private makingTheme: AbortController | null = null;

  /** A prompt is a filter (ADR 0116): its turns, behind the same gates as every turn here. */
  private readonly prompts: PromptService;

  constructor(given: AgentServiceDeps) {
    // Every read and change of the settings says which runtime each kind of work is on now.
    const keep = (s: AgentSettings) => {
      this.kinds = s.kindRuntime;
      return s;
    };
    const base = given.settings;
    const settings: AgentSettingsPort = {
      get: async () => keep(await base.get()),
      update: async (patch) => keep(await base.update(patch)),
      grantConsent: (accountId, runtimeId, atMs) => base.grantConsent(accountId, runtimeId, atMs),
      revokeConsent: (accountId, runtimeId) => base.revokeConsent(accountId, runtimeId),
      listConsents: () => base.listConsents(),
      getRuntimeRecord: (runtimeId) => base.getRuntimeRecord(runtimeId),
      putRuntimeRecord: (record) => base.putRuntimeRecord(record),
    };
    const deps = { ...given, settings };
    this.deps = deps;
    this.prompts = new PromptService({
      understand: () => this.understandOn(),
      store: deps.store,
      index: deps.index,
      bodies: deps.bodies,
      visibleText: (html) => deps.visibleText(html),
      accounts: deps.accounts,
      insights: deps.insights,
      settings: {
        get: () => this.currentSettings(),
        listConsents: () => deps.settings.listConsents(),
      },
      ...(deps.views === undefined ? {} : { views: deps.views }),
      now: () => this.now,
      loadThread: (threadId, consented) => this.loadThread(threadId, consented),
      onProgress: (progress) => deps.onPromptProgress?.(progress),
    });
  }

  private get now(): number {
    return this.deps.clock.now();
  }

  // --- The runtime of each kind of work (ADR 0121) ---

  /**
   * A runtime by id, or one that runs nothing when none is named or this build does not know it.
   * Never another: there is no fallback (ADR 0121, rule 3).
   */
  private runtimeById(id: string | undefined): AgentRuntime {
    if (id === undefined) return NO_RUNTIME;
    return this.deps.runtimes.find((r) => r.id === id) ?? NO_RUNTIME;
  }

  /** The runtime a kind of work runs on (ADR 0121, rule 1). */
  private runtimeFor(kind: AgentWorkKind, s?: Pick<AgentSettings, "kindRuntime">): AgentRuntime {
    return this.runtimeById((s ?? { kindRuntime: this.kinds }).kindRuntime[kind]);
  }

  /** What was last seen of a runtime. */
  private infoOf(id: string): AgentRuntimeInfo | null {
    return id === "" ? null : (this.infos.get(id) ?? null);
  }

  /**
   * What a look, a test or a turn found of a runtime, shown only while the key it began on is the
   * runtime's key (ADR 0141, rule 5). Gives what is shown now.
   */
  private setInfo(ticket: KeyTicket, info: AgentRuntimeInfo): AgentRuntimeInfo {
    const id = ticket.runtimeId;
    if (id === "") return info;
    if (this.runtimeKeys.holds(ticket)) {
      this.infos.set(id, info);
      this.infoTickets.set(id, ticket);
    }
    return this.infos.get(id) ?? info;
  }

  /**
   * What is shown of the runtime of `ticket`, only when it was found on that key and the key
   * holds: what was found on a key before says nothing of it (ADR 0141, rule 5).
   */
  private infoFor(ticket: KeyTicket): AgentRuntimeInfo | null {
    const found = this.infoTickets.get(ticket.runtimeId);
    if (found === undefined || !this.runtimeKeys.holds(ticket) || !this.runtimeKeys.holds(found)) {
      return null;
    }
    return this.infoOf(ticket.runtimeId);
  }

  /**
   * That a runtime waits for the person to sign in or to be on the plan, or no longer does (null),
   * as a look, a test or a turn found it: kept only while the key it began on holds.
   */
  private block(ticket: KeyTicket, reason: "signedOut" | "notPlan" | null): void {
    const id = ticket.runtimeId;
    if (id === "" || !this.runtimeKeys.holds(ticket)) return;
    if (reason === null) this.blocked.delete(id);
    else this.blocked.set(id, reason);
  }

  /** The test a runtime passed or failed, stored only while the key it ran on holds. */
  private async putRecord(ticket: KeyTicket, record: AgentRuntimeRecord): Promise<void> {
    if (!this.runtimeKeys.holds(ticket)) return;
    await this.deps.settings.putRuntimeRecord(record);
  }

  /**
   * Stores what a turn found (a rule, an instruction, a talk entry, prepared work, a closing, a
   * talk's name) only while the key it began on is the runtime's key, checked as the write begins,
   * after every wait (ADR 0141, rule 5). Else nothing is stored, and the turn says it stopped.
   */
  private async stored<T>(ticket: KeyTicket, write: () => Promise<T>): Promise<T> {
    const kept = await this.runtimeKeys.keep(ticket, write);
    if (kept === null) throw new AgentUnavailableError("Stopped.");
    return kept.value;
  }

  /**
   * What a turn hands back to a window (help with a reply, a theme): only while the key it began
   * on holds, after the last wait, the ledger's included (ADR 0141, rule 5).
   */
  private handed<T>(ticket: KeyTicket, value: T): T {
    if (!this.runtimeKeys.holds(ticket)) throw new AgentUnavailableError("Stopped.");
    return value;
  }

  /**
   * A signal that stops a turn of this kind on this runtime: AI off, a consent gone, the kind
   * moved, or the runtime's key removed or replaced.
   */
  private signalOf(kind: AgentWorkKind, runtimeId: string): AbortSignal {
    let mine = this.kindAborts.get(kind);
    if (mine === undefined) {
      mine = new AbortController();
      this.kindAborts.set(kind, mine);
    }
    return AbortSignal.any([
      this.abort.signal,
      mine.signal,
      this.runtimeKeys.stopSignal(runtimeId),
    ]);
  }

  /**
   * A turn of this kind on this runtime, as it begins: what stops it, and the ticket of the key it
   * runs on, taken at the same moment, so a new key both stops it and makes its ticket stale.
   */
  private turnOf(kind: AgentWorkKind, runtimeId: string): Turn {
    return { signal: this.signalOf(kind, runtimeId), ticket: this.runtimeKeys.ticket(runtimeId) };
  }

  /**
   * A request of a turn the person asked for goes only on the key its gate passed for: asked with
   * nothing awaited between it and the request (ADR 0141, rule 5).
   */
  private goes(turn: Turn): void {
    if (turn.signal.aborted || !this.runtimeKeys.holds(turn.ticket)) {
      throw new AgentUnavailableError("Stopped.");
    }
  }

  /**
   * The model of `kind` for a turn on `runtime`: what that runtime keeps for the kind (ADR 0121,
   * rule 5). One the runtime no longer lists is refused with a sentence, and nothing is put in its
   * place (ADR 0119, rule 4); only a turn of another kind on this runtime, whose own model for
   * `kind` the person does not see here, goes on with `fallback`: the model of that turn's kind.
   */
  private modelFor(
    kind: AgentWorkKind,
    s: AgentSettings,
    runtime: AgentRuntime,
    fallback?: () => string,
  ): string {
    const model = choicesOn(s, runtime.id).models[kind];
    if (modelListed(this.infoOf(runtime.id), kind, model)) return model;
    if (fallback !== undefined && s.kindRuntime[kind] !== runtime.id) return fallback();
    throw new AgentUnavailableError(modelGone(runtime.name, model, kind));
  }

  /**
   * The effort a turn of `kind` on `model` sends on `runtime`, or none (ADR 0118, rules 1 and 4):
   * from the levels of that model (ADR 0119, rule 9).
   */
  private effortOn(
    kind: AgentWorkKind,
    s: AgentSettings,
    runtime: AgentRuntime,
    model: string,
  ): AgentEffort | undefined {
    return resolveEffort(
      choicesOn(s, runtime.id).efforts[kind],
      levelsFor(this.infoOf(runtime.id), model),
    );
  }

  /**
   * The room of the one thread of a turn on `model`, within what the model takes (ADR 0119, rule
   * 8); undefined when the runtime says nothing, and the app's own sizes hold.
   */
  private roomFor(runtime: AgentRuntime, model: string): number | undefined {
    return threadRoom(inputCharsFor(this.infoOf(runtime.id), model), ONE_THREAD_EXTRA_CHARS);
  }

  /**
   * The gate of the plan of `runtimeId` at this priority (ADR 0051, rule 7; ADR 0121, rule 6): its
   * own windows and our own use of it, with the one share of the week. Always open on a runtime
   * with no plan (ADR 0119, rule 7).
   */
  private planGate(runtimeId: string, priority: AgentPriority, s: AgentSettings): MayRun {
    const plan = planUseOf(s, runtimeId);
    return mayRunOn(
      this.infoOf(runtimeId),
      priority,
      plan.limits,
      {
        weekSharePercent: s.weekSharePercent,
        usedByUsPercent: plan.usedByUsPercent,
        keyReading: keyReadingOn(s, runtimeId),
      },
      this.now,
    );
  }

  /** The windows a turn on this runtime starts from, for what it used. */
  private limitsOf(runtimeId: string, s: AgentSettings): PlanLimits | undefined {
    return planUseOf(s, runtimeId).limits;
  }

  /**
   * The runtime for understanding mail, bound for one run of a prompt (ADR 0121, rule 9): every
   * turn of the run goes to it, and to no other.
   */
  private understandOn(): PromptRuntime {
    const runtime = this.runtimeFor("understand");
    const id = runtime.id;
    const own = (s: AgentSettings) => this.modelFor("understand", s, runtime);
    const modelOf = (kind: AgentWorkKind, s: AgentSettings) =>
      kind === "understand" ? own(s) : this.modelFor(kind, s, runtime, () => own(s));
    return {
      runtime,
      info: () => this.infoOf(id),
      modelOf,
      planGate: (priority, s) => this.planGate(id, priority, s),
      mayGo: (ticket, priority) =>
        priority === "P0"
          ? this.runtimeKeys.holds(ticket)
          : this.runtimeKeys.mayGoInBackground(ticket),
      keep: (ticket, write) => this.runtimeKeys.keep(ticket, write),
      putVerdicts: async (ticket, verdicts) =>
        (await this.runtimeKeys.keep(ticket, () =>
          this.deps.insights.putPromptVerdicts(verdicts),
        )) !== null,
      limits: (s) => this.limitsOf(id, s),
      gate: (s, ticket) => this.gateRuntime(runtime, s, ticket),
      afterTurn: (ticket, limits, before) => this.afterTurn(ticket, limits, before),
      effortOf: (kind, s) => {
        try {
          return this.effortOn(kind, s, runtime, modelOf(kind, s));
        } catch {
          return undefined;
        }
      },
      askFailure: (error, fallback, ticket) => this.askFailure(error, fallback, ticket),
      consented: () => consentedAccounts(this.deps, id === "" ? undefined : id),
      begin: () => this.turnOf("understand", id),
    };
  }

  // --- Starting and stopping ---

  /**
   * Looks at the runtimes in use and starts the reading in the background, when the person has
   * already turned AI on. With AI off nothing is started on this machine: no program is even asked
   * who is signed in.
   */
  async start(): Promise<void> {
    const settings = await this.deps.settings.get();
    this.readingPaused = settings.readingPaused === true;
    if (!settings.enabled) return;
    await this.addStarterView();
    this.setProgress({ state: "checking" });
    await this.inspectInUse();
    // A pause the person made before the restart still holds: the pass only says so.
    if (this.readingPaused) this.runPass();
    else this.kick();
  }

  /** Stops timers and any run in flight, and waits for the pass to end. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelKick?.();
    this.cancelKick = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.abort.abort();
    await this.pass?.catch(() => {});
  }

  // --- Looking at the runtimes ---

  /**
   * What one runtime says now, with what its last test found. One that lists models for the first
   * time gets its starting choices (ADR 0119, rule 4); windows read when looking (ADR 0120, rule 9)
   * are kept for its plan. Looking sends no mail and spends nothing.
   */
  private async inspectOne(runtime: AgentRuntime): Promise<AgentRuntimeInfo> {
    return (await this.lookOnce(runtime)).info;
  }

  /**
   * A look, with the ticket of the key it was shown for. A look that began on the key before one
   * saved or removed while it ran says what the key before was: it is not shown for the new one,
   * and the runtime is looked at again (ADR 0141, rule 5). Looks run at once, so the one that
   * ends last is not always the one of the key now.
   */
  private async lookOnce(
    runtime: AgentRuntime,
  ): Promise<{ info: AgentRuntimeInfo; ticket: KeyTicket }> {
    if (runtime === NO_RUNTIME) return { info: NO_INFO, ticket: this.runtimeKeys.ticket("") };
    for (;;) {
      const ticket = this.runtimeKeys.ticket(runtime.id);
      const info = await this.lookAt(runtime);
      if (!this.runtimeKeys.holds(ticket)) {
        // A key being saved or removed: the runtime is looked at again once that has ended.
        await this.runtimeKeys.quiet(runtime.id);
        continue;
      }
      this.setInfo(ticket, info);
      if (info.noPlan !== true && info.limits !== undefined) {
        // None of a change since the last seen is counted as ours, since no turn of ours ran.
        await this.noteRun(ticket, info.limits);
      }
      return { info: this.infoOf(runtime.id) ?? info, ticket };
    }
  }

  /** What one runtime says now, with what its last test found, not yet shown. */
  private async lookAt(runtime: AgentRuntime): Promise<AgentRuntimeInfo> {
    const { settings } = this.deps;
    let info = await runtime.inspect();
    // Whether the search in a loop can run here is the port's to say (ADR 0083; ADR 0119, rule 10).
    if (runtime.runWithTools !== undefined) info = { ...info, tools: true };
    let s = await settings.get();
    if (s.choices?.[runtime.id] === undefined) {
      const start = startingChoices(info);
      if (start !== null) s = await settings.update({ choices: { [runtime.id]: start } });
    }
    const record = await settings.getRuntimeRecord(runtime.id);
    // The test is for a model (ADR 0119). A record from before it kept one holds for what is
    // chosen now.
    const model = this.testModel(runtime.id, s, info);
    const sameModel = record?.model === undefined || record.model === model;
    // A test holds for the key it ran on and no other, by the id the key was saved with: not by
    // time, which two saves in one millisecond or a clock set back would get wrong (ADR 0141,
    // rule 5). A record that names no key holds for no key.
    const sameKey =
      info.billed !== true || (info.keyId !== undefined && record?.keyId === info.keyId);
    if (
      info.status === "found" &&
      record !== null &&
      record.plan === info.plan &&
      sameModel &&
      sameKey
    ) {
      // The same plan and model passed the test before: the program is not asked to prove it again.
      info =
        record.status === "ready"
          ? { ...info, status: "ready" }
          : {
              ...info,
              status: "failed",
              problem: record.problem ?? "The last check of the assistant failed.",
            };
    }
    return info;
  }

  /** Looks at one runtime and notes whether it waits for the person to sign in. */
  private async inspectRuntime(runtime: AgentRuntime): Promise<AgentRuntimeInfo> {
    if (runtime === NO_RUNTIME) return NO_INFO;
    const { info, ticket } = await this.lookOnce(runtime);
    this.block(
      ticket,
      info.status === "signedOut" ? (this.blocked.get(runtime.id) ?? "signedOut") : null,
    );
    return info;
  }

  /** The runtimes a kind of work names, looked at (ADR 0121, rule 2). */
  private async inspectInUse(): Promise<void> {
    const s = await this.deps.settings.get();
    for (const id of runtimesInUse(s)) {
      const runtime = this.runtimeById(id);
      await this.inspectRuntime(runtime).catch(() => {
        // A runtime that cannot be looked at keeps what was seen before.
      });
    }
  }

  async inspect(): Promise<AgentStatus> {
    const wasWaiting = this.waitingOnRuntime();
    const inUse = new Set(runtimesInUse(await this.deps.settings.get()));
    // Every runtime is looked at, so Settings shows each with its state (ADR 0121, rule 2).
    await Promise.all(
      this.deps.runtimes.map((r) =>
        (inUse.has(r.id) ? this.inspectRuntime(r) : this.inspectOne(r)).catch(() => {
          // A runtime that cannot be looked at keeps what was seen before.
        }),
      ),
    );
    // The person signed in outside the app and asked us to look again: the reading goes on by
    // itself. Looking never starts a login.
    const reading = this.runtimeFor("understand");
    if (wasWaiting && usable(this.infoOf(reading.id))) {
      this.blocked.delete(reading.id);
      this.startNow();
    } else if (wasWaiting) {
      this.setProgress(this.offProgress());
    }
    this.deps.onChanged();
    return this.status();
  }

  /** Reading stopped because its runtime is missing, signed out or off the plan. */
  private waitingOnRuntime(): boolean {
    const { state, reason } = this.progress;
    return (
      (state === "off" && (reason === "signedOut" || reason === "runtime")) ||
      (state === "paused" && (reason === "signedOut" || reason === "notPlan"))
    );
  }

  /** The state for a runtime of reading that cannot be used, with the sentence to act on. */
  private offProgress(): ReadingProgress {
    const info = this.infoOf(this.runtimeFor("understand").id);
    const problem = info?.problem;
    return {
      state: "off",
      reason: info?.status === "signedOut" ? "signedOut" : "runtime",
      ...(problem === undefined ? {} : { problem }),
    };
  }

  /**
   * ADR 0051, rule 5: one made-up message through `run`, in the verdict turn of a prompt (ADR
   * 0116). A runtime is `ready` only when the answer parses against its schema, names the thread
   * that was sent, and its quote is found in the message. Never mail. With `runtimeId`, that
   * runtime, in use or not, so it can be connected before a kind moves to it (ADR 0121, rule 2);
   * without, every runtime in use.
   */
  async testRuntime(runtimeId?: string): Promise<AgentStatus> {
    const s = await this.deps.settings.get();
    const ids = runtimeId === undefined ? runtimesInUse(s) : [runtimeId];
    const runtimes = ids.map((id) => this.runtimeById(id));
    if (runtimes.some((r) => r === NO_RUNTIME)) {
      throw new InvalidAgentSettingError("That assistant is not available.");
    }
    return this.testRuntimes(runtimes);
  }

  /**
   * The tests of these runtimes, with the reading's state while they run. With `background`, the
   * one runtime's test no press of the person's asked for, on that ticket (ADR 0141, rule 6).
   */
  private async testRuntimes(
    runtimes: readonly AgentRuntime[],
    background?: KeyTicket,
  ): Promise<AgentStatus> {
    const reading = this.runtimeFor("understand", await this.deps.settings.get());
    const withReading = runtimes.includes(reading);
    const wasOff = withReading && (this.progress.state === "off" || this.waitingOnRuntime());
    if (wasOff) this.setProgress({ state: "checking" });
    for (const runtime of runtimes) await this.sharedTest(runtime, background);
    if (wasOff) {
      if (this.infoOf(reading.id)?.status === "ready") this.startNow();
      else this.setProgress(this.offProgress());
    }
    this.deps.onChanged();
    return this.status();
  }

  /**
   * The test, once at a time per runtime: a press of Check during a pass waits for its test. A
   * test that runs on a key no longer kept is not waited for: it keeps nothing, and the key now is
   * tested by itself (ADR 0141, rule 5). With `background`, no press of the person's started it:
   * the ticket was taken before the reading switch was read, and it is sent only while the switch
   * and the key still allow it (rule 6).
   */
  private async sharedTest(
    runtime: AgentRuntime,
    background?: KeyTicket,
  ): Promise<AgentRuntimeInfo> {
    for (;;) {
      const running = this.testing.get(runtime.id);
      if (running === undefined || !this.runtimeKeys.holds(running.ticket)) break;
      if (background !== undefined || !running.background) return running.test;
      // A test the person asked for does not stand on one that goes only while the reading switch
      // stays on (ADR 0141, rule 6): it waits for it, and tests the key itself when that one did not.
      const info = await running.test.catch(() => null);
      if (info !== null && info.status !== "found") return info;
    }
    const ticket = background ?? this.runtimeKeys.ticket(runtime.id);
    const test = this.runTest(runtime, ticket, background !== undefined).finally(() => {
      if (this.testing.get(runtime.id)?.test === test) this.testing.delete(runtime.id);
    });
    this.testing.set(runtime.id, { ticket, test, background: background !== undefined });
    return test;
  }

  /**
   * The model a runtime is tested on: the one it keeps for understanding mail (ADR 0119), else the
   * first it lists of those it keeps for the kinds on it. Null when it lists none of them.
   */
  private testModel(
    runtimeId: string,
    s: AgentSettings,
    info: Pick<AgentRuntimeInfo, "models">,
  ): string | null {
    const kept = choicesOn(s, runtimeId).models;
    for (const kind of ["understand", ...kindsOn(s, runtimeId)] as const) {
      const model = kept[kind];
      if (kind === "titles" && model === TITLES_OFF) continue;
      if (info.models.length === 0 || info.models.includes(model)) return model;
    }
    return null;
  }

  private async runTest(
    runtime: AgentRuntime,
    ticket: KeyTicket,
    background: boolean,
  ): Promise<AgentRuntimeInfo> {
    const { clock } = this.deps;
    // The key the test runs on: one saved or removed while it runs stops it, and makes what it
    // found one of the key before, which is not kept (ADR 0141, rule 5). Not a kind of work: its
    // stop is AI off or the key, taken with the ticket.
    const signal = AbortSignal.any([this.abort.signal, this.runtimeKeys.stopSignal(runtime.id)]);
    const info = await this.inspectRuntime(runtime);
    if (info.status !== "found" && info.status !== "ready" && info.status !== "failed") return info;
    this.block(ticket, null);
    const settingsNow = await this.deps.settings.get();
    // A model the runtime no longer lists waits for the person to pick another (ADR 0119, rule 4).
    const model = this.testModel(runtime.id, settingsNow, info);
    // A key saved or removed during the look: no billed turn goes for a test that keeps nothing. In
    // the background, nor once the switch was turned off (rule 6). Nothing awaits from here to the
    // request.
    const goes = background
      ? this.runtimeKeys.mayGoInBackground(ticket)
      : this.runtimeKeys.holds(ticket);
    if (!goes) return this.infoOf(runtime.id) ?? info;
    if (model === null) {
      const kind = kindsOn(settingsNow, runtime.id)[0] ?? "understand";
      const gone = choicesOn(settingsNow, runtime.id).models[kind];
      return this.setInfo(ticket, {
        ...info,
        status: "failed",
        problem: modelGone(runtime.name, gone, kind),
      });
    }
    const { request } = buildPromptRequest(
      [
        {
          thread: TEST_THREAD,
          signals: { unread: true, starred: false, answered: false, messages: 1 },
        },
      ],
      TEST_PROMPT,
      clock.now(),
    );
    let status: AgentRuntimeInfo["status"] = "failed";
    let problem: string | undefined;
    try {
      // Not a kind of work: the test stays at `low`, when the runtime takes it (ADR 0118, rule 6).
      const run = await runtime.run(
        { model, ...request, ...withEffort(resolveEffort("low", levelsFor(info, model))) },
        { signal },
      );
      await this.afterTurn(ticket, run.limits);
      const verdicts = acceptVerdicts(
        run.value,
        [{ threadId: "test", lastMessageKey: 1, thread: TEST_THREAD }],
        { promptKey: "test", version: PROMPT_VERSION, atMs: clock.now() },
      );
      // A quote that was found proves the answer is in the shape and is held to the text.
      if (verdicts?.some((v) => v.quote !== undefined) === true) status = "ready";
      else problem = "The assistant answered, but not in the form the app needs.";
    } catch (error) {
      // What is kept of the answer goes through the ticket: a test on the key before keeps none.
      if (isAgentRunError(error) && (error.code === "notSignedIn" || error.code === "notPlan")) {
        this.block(ticket, error.code === "notPlan" ? "notPlan" : "signedOut");
        return this.setInfo(ticket, {
          ...info,
          status: "signedOut",
          problem:
            error.code === "notPlan"
              ? `The assistant is not using your ${PLAN_NAMES[runtime.id] ?? "plan"}.`
              : "Not signed in. Sign in with the assistant's own program, then check again.",
        });
      }
      if (isAgentRunError(error) && error.code === "refused" && info.billed === true) {
        // The provider refused the key: a sentence of the adapter's, with no words of theirs
        // (ADR 0141, rule 5). It is not kept as a test: the next look asks the provider again.
        return this.setInfo(ticket, { ...info, status: "keyRefused", problem: error.message });
      }
      problem =
        isAgentRunError(error) && error.code === "badAnswer"
          ? "The assistant answered, but not in the form the app needs."
          : "The check of the assistant did not finish.";
    }
    await this.putRecord(ticket, {
      runtimeId: runtime.id,
      status: status === "ready" ? "ready" : "failed",
      ...(info.plan === undefined ? {} : { plan: info.plan }),
      model,
      ...(problem === undefined ? {} : { problem }),
      ...(info.keyId === undefined ? {} : { keyId: info.keyId }),
      testedAtMs: clock.now(),
    });
    // A key saved while the record was written: the record names the key before, and holds for
    // no other; what is shown is the new key's.
    const { problem: _old, ...rest } = this.infoOf(runtime.id) ?? info;
    return this.setInfo(ticket, {
      ...rest,
      status,
      ...(problem === undefined ? {} : { problem }),
    });
  }

  // --- Budget bookkeeping (ADR 0051, rule 7; ADR 0121, rule 6) ---

  /**
   * Keeps the last windows we saw of this runtime's plan. Our share of its week starts again when
   * its week does (ADR 0051, rule 7): a different reset time, or a reset that has passed. Another
   * runtime's plan is not touched.
   */
  private async noteRun(
    ticket: KeyTicket,
    limits: PlanLimits | undefined,
    before?: PlanLimits,
  ): Promise<void> {
    const runtimeId = ticket.runtimeId;
    // A runtime with no plan has no windows: nothing is recorded (ADR 0119, rule 7).
    if (limits === undefined || runtimeId === "" || this.infoOf(runtimeId)?.noPlan === true) return;
    const { settings } = this.deps;
    const s = await settings.get();
    // What a turn on the key before saw is not the new key's (ADR 0141, rule 5).
    if (!this.runtimeKeys.holds(ticket)) return;
    const current = planUseOf(s, runtimeId);
    let used = current.usedByUsPercent;
    const reset = limits.week?.resetsAtMs;
    if (current.usedWeekResetsAtMs !== undefined && reset !== current.usedWeekResetsAtMs) used = 0;
    const was = before?.week;
    const now = limits.week;
    if (was !== undefined && now !== undefined && was.resetsAtMs === now.resetsAtMs) {
      used += Math.max(0, now.usedPercent - was.usedPercent);
    }
    await settings.update({
      plan: {
        runtimeId,
        limits,
        usedByUsPercent: used,
        ...(reset === undefined ? {} : { usedWeekResetsAtMs: reset }),
      },
    });
  }

  /**
   * After a turn answered: the windows it saw, then the go-ahead for what it found, which is kept
   * only while the key it ran on is the runtime's key (ADR 0141, rule 5). A key saved or removed
   * meanwhile stopped the turn: it says so, and nothing it found is kept.
   */
  private async afterTurn(
    ticket: KeyTicket,
    limits: PlanLimits | undefined,
    before?: PlanLimits,
  ): Promise<void> {
    await this.noteRun(ticket, limits, before);
    if (!this.runtimeKeys.holds(ticket)) throw new AgentUnavailableError("Stopped.");
  }

  /** A week we count in is over: start counting again, before a gate looks at the number. */
  private async currentSettings(): Promise<AgentSettings> {
    let s = await this.deps.settings.get();
    for (const [runtimeId, plan] of Object.entries(s.plans ?? {})) {
      if (plan.usedWeekResetsAtMs !== undefined && this.now >= plan.usedWeekResetsAtMs) {
        s = await this.deps.settings.update({
          plan: { runtimeId, usedByUsPercent: 0, usedWeekResetsAtMs: null },
        });
      }
    }
    return s;
  }

  // --- Choosing and loading threads ---

  private async ownAddresses(): Promise<string[]> {
    return (await this.deps.accounts.list()).map((a) => a.address);
  }

  /**
   * The files with no text of the threads that went, fetched whole and numbered in the order they
   * go (ADR 0090, rules 2, 4 and 8), and the threads again with those numbers in their notes. A
   * file that cannot be fetched stays a file with no text, and its step says why. The bytes come
   * through the cache of ADR 0043; the budget is checked again on the real bytes.
   */
  private async attachWhole(
    loaded: readonly {
      readonly base: PromptThread;
      readonly read: readonly ReadFileRecord[];
      readonly thread: PromptThread;
    }[],
    sent: readonly number[],
    records: readonly ReadFileRecord[],
  ): Promise<{ files: AgentFile[]; threads: PromptThread[]; changed: boolean }> {
    const files: AgentFile[] = [];
    const threads = loaded.map((l) => l.thread);
    const fetch = this.deps.wholeFile;
    if (fetch === undefined || !records.some((r) => r.whole !== undefined)) {
      return { files, threads, changed: false };
    }
    let changed = false;
    for (const index of sent) {
      const entry = loaded[index];
      if (entry === undefined || !entry.read.some((r) => r.whole !== undefined)) continue;
      const numbered: { messageKey: number; name: string; text: string; whole?: number }[] = [];
      for (const r of entry.read) {
        if (r.whole === undefined) {
          numbered.push({ messageKey: r.messageKey, name: r.name, text: r.text });
          continue;
        }
        const got = await fetch(r.messageKey, r.partId);
        const problem = got.kind === "ok" ? wholeFilesProblem([...files, got.file]) : got.reason;
        if (got.kind === "ok" && problem === null) {
          files.push(got.file);
          numbered.push({ messageKey: r.messageKey, name: r.name, text: "", whole: files.length });
        } else {
          const why = (problem ?? "").replace(/\.$/, "");
          this.deps.onTalkStep?.(
            "",
            1,
            "read",
            `file: ${r.name} — no text, not sent: ${why.toLowerCase()}`,
          );
          numbered.push({
            messageKey: r.messageKey,
            name: r.name,
            text: `(This file has no text, and it could not be attached: ${why}.)`,
          });
        }
      }
      threads[index] = withFiles(entry.base, numbered);
      changed = true;
    }
    return { files, threads, changed };
  }

  /** The thread as a model sees it: plain text of what the page shows, oldest last (ADR 0051, rule 8). */
  private async loadThread(
    threadId: string,
    consented: ReadonlySet<string>,
  ): Promise<{ thread: PromptThread; lastMessageKey: number; accountId: string } | null> {
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    if (view === null || view.messages.length === 0) return null;
    // Defence in depth: no mail of an account without consent is ever read for a turn.
    if (!consented.has(view.thread.accountId)) return null;
    const own = new Set((await this.ownAddresses()).map(lower));
    // Automated messages stay as context: the flag only decides whether a thread is a candidate.
    const kept = view.messages.slice(-MAX_PROMPT_MESSAGES);
    const keys = kept.map((m) => m.key);
    const [plain, kinds] = await Promise.all([
      this.deps.bodies.getBodies(keys),
      this.deps.bodies.getHtmlKinds(keys),
    ]);
    const messages = [];
    for (const m of kept) {
      // The stored text may have been made from HTML that hid words from the reader (mail stored
      // before that was left out); what the person sees is what the model gets.
      const html = kinds.has(m.key) ? await this.deps.bodies.getHtml(m.key) : undefined;
      const text = textForPrompt({
        text: plain.get(m.key) ?? "",
        ...(html === undefined ? {} : { html }),
        visibleText: this.deps.visibleText,
      });
      messages.push({
        key: m.key,
        dateMs: m.dateMs,
        from: m.from,
        fromOwn: own.has(lower(m.from.address)),
        text,
        ...(m.automated === true || isAutomatedSender(m.from.address) ? { automated: true } : {}),
      });
    }
    // What the person's own Sent mail says about this sender: counts only, no address (ADR 0066).
    const history = await senderHistory(this.deps.store, this.now, view.messages, own);
    return {
      thread: {
        subject: view.thread.subject,
        messages,
        ...(history === undefined ? {} : { history }),
      },
      lastMessageKey: view.thread.lastMessageKey,
      accountId: view.thread.accountId,
    };
  }

  // --- Reading in the background (ADR 0117, rule 3; ADR 0121, rule 9) ---

  /** Called when AI is turned on and after a committed sync batch. Debounced; one pass at a time. */
  kick(): void {
    // A sync, a timer or a setting never takes the person's pause back (ADR 0053, rule 8).
    if (this.stopped || this.readingPaused) return;
    this.cancelKick?.();
    this.cancelKick = this.deps.clock.setTimeout(() => {
      this.cancelKick = null;
      this.runPass();
    }, this.deps.kickDebounceMs ?? KICK_DEBOUNCE_MS);
  }

  /**
   * The person asked (turned AI on, pressed Look again or Try again): no quiet time first. A sync
   * waits for the debounce; a person who just pressed something does not.
   */
  private startNow(): void {
    if (this.stopped || this.readingPaused) return;
    this.cancelKick?.();
    this.cancelKick = null;
    this.runPass();
  }

  /** Resolves when the pass that is running (if any) has ended; for tests and for stopping. */
  async idle(): Promise<void> {
    while (this.pass !== null) await this.pass.catch(() => {});
  }

  private runPass(): void {
    if (this.stopped) return;
    if (this.pass !== null) {
      this.again = true;
      return;
    }
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.pass = (async () => {
      do {
        this.again = false;
        try {
          await this.passOnce();
        } catch (error) {
          this.deps.onError?.(
            `agents: a pass failed (${error instanceof Error ? error.name : "unknown"})`,
          );
          break;
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.pass = null;
      this.retryLater();
    });
  }

  /**
   * The plan said no to the reading in the background and named until when: one pass then, so a
   * line that says "until 14:00" holds (ADR 0117, rule 3a). Never while the person paused it.
   */
  private retryLater(): void {
    if (this.stopped || this.readingPaused) return;
    const at = this.prompts.nextTryMs();
    if (at === undefined) return;
    this.cancelRetry?.();
    this.cancelRetry = this.deps.clock.setTimeout(
      () => {
        this.cancelRetry = null;
        this.runPass();
      },
      Math.max(0, at - this.now) + RETRY_MARGIN_MS,
    );
    // The status says "soon" no more: the reading waits for the plan.
    this.deps.onChanged();
  }

  private setProgress(progress: ReadingProgress): void {
    this.progress = progress;
    this.deps.onChanged();
  }

  private pause(runtimeId: string, reason: "signedOut" | "notPlan"): void {
    const problem = this.infoOf(runtimeId)?.problem;
    this.setProgress({ state: "paused", reason, ...(problem === undefined ? {} : { problem }) });
  }

  /**
   * Each runtime in use that some account agreed to and that is not tested yet is tested now,
   * with the made-up message only (ADR 0051, rule 5; ADR 0121, consequences): each needs its own
   * test before it is ready. One the person must sign in to first is left alone.
   */
  private async testInUse(s: AgentSettings): Promise<void> {
    const consents = await this.deps.settings.listConsents();
    for (const id of runtimesInUse(s)) {
      const runtime = this.runtimeById(id);
      if (runtime === NO_RUNTIME || this.blocked.has(id)) continue;
      if (!this.testsAlone(id, s, consents)) continue;
      // The ticket first: whether the test may go is read for this key (ADR 0141, rule 6).
      const ticket = this.runtimeKeys.ticket(id);
      if (this.infoOf(id) === null) await this.inspectRuntime(runtime).catch(() => {});
      if (this.infoOf(id)?.status !== "found") continue;
      if (!(await this.testsInBackground(id))) continue;
      await this.sharedTest(runtime, ticket).catch(() => {});
    }
  }

  /**
   * Whether a runtime may be tested with no press of the person's: always, except one billed to
   * the person's key while its reading in the background is off. The test is a billed turn, and
   * with the switch off nothing billed goes in the background (ADR 0141, rule 6): that key is
   * tested when the person presses Check, or with the first thing they ask for on it.
   */
  private async testsInBackground(runtimeId: string): Promise<boolean> {
    if (this.infoOf(runtimeId)?.billed !== true) return true;
    return keyReadingOn(await this.deps.settings.get(), runtimeId);
  }

  /**
   * Whether a runtime in use may be tested by itself, with the made-up message: an account agreed
   * to it, or a kind of work on it takes no mail and so needs no account (ADR 0134, rule 14). A
   * runtime in use only for making themes is tested like any other in use (ADR 0121, rule 2).
   */
  private testsAlone(
    runtimeId: string,
    s: Pick<AgentSettings, "kindRuntime">,
    consents: readonly { readonly runtimeId: string }[],
  ): boolean {
    return (
      consents.some((c) => c.runtimeId === runtimeId) ||
      kindsOn(s, runtimeId).some((k) => !kindTakesMail(k))
    );
  }

  /**
   * One pass behind the gates of background work: AI on, a runtime for understanding mail, an
   * account that agreed to it, the person's pause, that runtime ready (tested by itself once the
   * person agreed). Then the saved views with a prompt read their new mail on it (ADR 0121, rule
   * 9); they give way to a run the person starts and stop with the person's pause. The other
   * runtimes in use are tested here too, so each kind of work is ready when it is asked for.
   */
  private async passOnce(): Promise<void> {
    const first = await this.currentSettings();
    const runtime = this.runtimeFor("understand", first);
    if (!first.enabled || runtime === NO_RUNTIME) {
      this.setProgress({ state: "off", reason: "disabled" });
      return;
    }
    if ((await consentedAccounts(this.deps, runtime.id)).size === 0) {
      // Nothing is read in the background; a runtime of another kind may still need its test.
      this.setProgress({ state: "off", reason: "consent" });
      await this.testInUse(first);
      return;
    }
    if (this.readingPaused) {
      this.setProgress({ state: "paused", reason: "pausedByPerson" });
      return;
    }
    const waits = this.blocked.get(runtime.id);
    if (waits !== undefined) {
      // It waits for the person, not for the clock.
      this.pause(runtime.id, waits);
      return;
    }
    const info = this.infoOf(runtime.id);
    if (info === null || info.status === "found") this.setProgress({ state: "checking" });
    if (info === null) await this.inspectRuntime(runtime);
    // The person agreed, so the test with a made-up message may run by itself (ADR 0051, rule 5),
    // except on a key whose reading in the background is off (ADR 0141, rule 6).
    await this.testInUse(first);
    const waitsNow = this.blocked.get(runtime.id);
    if (waitsNow !== undefined) {
      this.pause(runtime.id, waitsNow);
      return;
    }
    // On a runtime billed to the person's key, nothing is read in the background until they
    // turn that on (ADR 0141, rule 6), the test of a key not checked yet included: what they ask
    // for still runs. A key that is neither ready nor waiting for its check says its own state.
    const reader = this.infoOf(runtime.id);
    if (
      reader?.billed === true &&
      (reader.status === "ready" || reader.status === "found") &&
      !keyReadingOn(await this.currentSettings(), runtime.id)
    ) {
      this.setProgress({ state: "off", reason: "keyOff" });
      return;
    }
    if (this.infoOf(runtime.id)?.status !== "ready") {
      this.setProgress(this.offProgress());
      return;
    }
    // Reading runs on the model for understanding mail: gone, it waits for the person (rule 4).
    const now = await this.currentSettings();
    const model = choicesOn(now, runtime.id).models.understand;
    if (!modelListed(this.infoOf(runtime.id), "understand", model)) {
      this.setProgress({
        state: "off",
        reason: "runtime",
        problem: modelGone(runtime.name, model, "understand"),
      });
      return;
    }
    // Windows read apart from turns can be stale: the first refusal for the limit pauses the
    // background (ADR 0120, rule 9).
    const pausesOnLimit = this.infoOf(runtime.id)?.pausesOnLimit === true;
    this.limitHeld = null;
    try {
      const more = await this.prompts.readInBackground({
        recentDays: RECENT_DAYS,
        stopWhen: () => this.readingPaused || this.stopped,
        ...(pausesOnLimit
          ? {
              onLimit: (untilMs: number | undefined) => {
                this.limitHeld = untilMs === undefined ? {} : { untilMs };
              },
            }
          : {}),
      });
      // A view has threads left that one pass did not take: the next pass reads on.
      if (more && !this.readingPaused) this.again = true;
    } catch (error) {
      this.deps.onError?.(
        `agents: a prompt's reading failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    if (this.stopped || this.abort.signal.aborted) return;
    // Set while the pass ran, by the callback above.
    const held = this.limitHeld as { untilMs?: number } | null;
    if (held !== null && !this.readingPaused) {
      // Paused as the person pauses it, so it holds until they continue it, across restarts.
      this.readingPaused = true;
      await this.deps.settings.update({ readingPaused: true });
      this.setProgress({
        state: "paused",
        reason: "limit",
        ...(held.untilMs === undefined ? {} : { untilMs: held.untilMs }),
      });
      return;
    }
    this.setProgress(
      this.readingPaused ? { state: "paused", reason: "pausedByPerson" } : { state: "idle" },
    );
  }

  /**
   * Runs the model for one thread and stores what it prepared under the thread's last message.
   * When the person typed words and the model answers `closed`, nothing is stored as prepared
   * work: it is recorded as a closing (ADR 0054).
   */
  private async prepareFor(
    threadId: string,
    runtime: AgentRuntime,
    model: string,
    guidance: PreparedGuidance | undefined,
    effort: AgentEffort | undefined,
    turn: Turn,
  ): Promise<PrepareResult> {
    const { insights, settings } = this.deps;
    const consented = await consentedAccounts(this.deps, runtime.id);
    const loaded = await this.loadThread(threadId, consented);
    if (loaded === null)
      throw new ThingNotFoundError("That thread is not available to the assistant");
    const accountId = loaded.accountId;
    // What is prepared belongs to the thread as it stands now.
    const lastMessageKey = loaded.lastMessageKey;
    const request = buildPreparedRequest(
      loaded.thread,
      this.now,
      guidance,
      { list: await insights.listInstructions(), threadId },
      this.roomFor(runtime, model),
    );
    const before = this.limitsOf(runtime.id, await settings.get());
    this.goes(turn);
    try {
      const run = await runtime.run(
        { model, ...request, ...withEffort(effort) },
        { signal: turn.signal },
      );
      await this.afterTurn(turn.ticket, run.limits, before);
      const answer = parsePreparedAnswer(run.value);
      // The schema asks; this decides. `closed` needs the person's own words; a direction chosen
      // from the ones offered is not enough, since a model wrote those after reading the mail.
      const hasWords = (guidance?.answer ?? "").trim() !== "";
      const allowed =
        answer !== null &&
        (answer.kind === "draft" ||
          (answer.kind === "closed" && hasWords) ||
          (answer.kind === "needs" && guidance === undefined));
      if (answer === null || !allowed) {
        throw new AgentUnavailableError("The assistant's answer could not be used.");
      }
      if (answer.kind === "closed") {
        await this.recordClosing(
          turn.ticket,
          threadId,
          lastMessageKey,
          answer.reason,
          clean(loaded.thread.subject).slice(0, 200),
          (guidance?.answer ?? "").trim(),
        );
        return { kind: "closed", reason: answer.reason };
      }
      const work = workOf(answer);
      await this.storePrepared(turn.ticket, threadId, lastMessageKey, work);
      return work;
    } finally {
      // What was sent is counted whether or not it worked: counts only, no text.
      await insights.appendLedger([
        {
          atMs: this.now,
          runtimeId: runtime.id,
          accountId,
          purpose: "prepare",
          threads: 1,
          ...withEffort(effort),
        },
      ]);
    }
  }

  /**
   * A closing the person's own words asked for (ADR 0054): kept in the journal with an Undo, and
   * counted toward a rule for its sender (ADR 0058, rule 4). Only while the key of the turn that
   * closed it holds (ADR 0141, rule 5).
   */
  private async recordClosing(
    ticket: KeyTicket,
    threadId: string,
    lastMessageKey: number,
    reason: string,
    headline: string,
    words: string,
  ): Promise<void> {
    const senderAddress = await this.senderOf(threadId);
    await this.stored(ticket, () =>
      this.deps.insights.recordFeedback(
        {
          threadId,
          lastMessageKey,
          senderAddress,
          kind: "closed",
          atMs: this.now,
          reason,
          outcome: "done",
        },
        {
          actor: "agent",
          headline,
          words: words.slice(0, MAX_GUIDANCE_CHARS),
        },
      ),
    );
    this.deps.onChanged();
  }

  /** Prepared work, kept only while the key of the turn that prepared it holds (ADR 0141, rule 5). */
  private async storePrepared(
    ticket: KeyTicket,
    threadId: string,
    lastMessageKey: number,
    work: PreparedWork,
  ): Promise<void> {
    await this.stored(ticket, () =>
      this.deps.insights.putPrepared([{ threadId, lastMessageKey, work, preparedAtMs: this.now }]),
    );
    this.deps.onChanged();
  }

  private readDeps() {
    return {
      insights: this.deps.insights,
      settings: this.deps.settings,
      store: this.deps.store,
      accounts: this.deps.accounts,
    };
  }

  // --- AgentApi: reads ---

  threadAgent(threadId: string): Promise<ThreadAgentView> {
    return readThreadAgent(this.readDeps(), threadId);
  }

  journal(limit?: number) {
    return readJournal(this.readDeps(), limit);
  }

  rules() {
    return readRules(this.readDeps());
  }

  ruleOffer(threadId: string) {
    return readRuleOffer(this.readDeps(), threadId);
  }

  instructions() {
    return readInstructions(this.readDeps());
  }

  async status(): Promise<AgentStatus> {
    const [settings, consents, ledger] = await Promise.all([
      this.deps.settings.get(),
      this.deps.settings.listConsents(),
      this.deps.insights.listLedger(LEDGER_SHOWN),
    ]);
    // With AI off no program is asked who is signed in just because a window wants to know
    // whether AI is on (ADR 0051, refinement 4): the person asks with `inspect`.
    const unseen = runtimesInUse(settings).some((id) => this.infoOf(id) === null);
    if (unseen && settings.enabled) await this.inspectInUse();
    // Looking may have given a runtime its starting choices: the settings are read again then.
    const after = unseen ? await this.deps.settings.get() : settings;
    return {
      settings: after,
      runtimes: this.deps.runtimes.map((r) => {
        const info = this.infoOf(r.id);
        // A runtime on a plan carries the windows kept for it (ADR 0121, rule 6).
        const limits = info?.noPlan === true ? undefined : planUseOf(after, r.id).limits;
        const told = info === null ? null : shownInfo(info);
        return {
          id: r.id,
          name: r.name,
          info: told === null || limits === undefined ? told : { ...told, limits },
        };
      }),
      unlisted: unlistedKinds(after, (id) => this.infoOf(id)),
      consents,
      progress: this.progress,
      ledger,
    };
  }

  /**
   * ADR 0117, rule 2: `Needs you` goes in front of the saved views once, the first time AI is on
   * with an account that agreed to the runtime for understanding mail, and that it went is kept
   * with the agent's settings. A view of that name already there counts as added. A full list adds
   * nothing and keeps no record, so it is added once there is room. Never fails what called it.
   */
  private async addStarterView(): Promise<void> {
    const views = this.deps.starterViews;
    if (views === undefined) return;
    try {
      const s = await this.deps.settings.get();
      if (!s.enabled || s.needsYouAdded === true) return;
      const reading = this.runtimeFor("understand", s);
      if (reading === NO_RUNTIME) return;
      if ((await consentedAccounts(this.deps, reading.id)).size === 0) return;
      const added = await addNeedsYouView({ views, now: () => this.now });
      if (added === "full") return;
      await this.deps.settings.update({ needsYouAdded: true });
      if (added === "added") this.deps.onViewsChanged?.();
    } catch (error) {
      this.deps.onError?.(
        `agents: the starter view was not added (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
  }

  // --- AgentApi: the person pauses ---

  /**
   * ADR 0053, rule 8; ADR 0117, rule 3: the reading in the background stops. Saved, so it holds
   * after a restart; nothing that is running is cut short (turns that run finish and keep their
   * results), and no new turn starts in the background. What the person asks for still works.
   */
  async pauseReading(): Promise<AgentStatus> {
    this.readingPaused = true;
    await this.deps.settings.update({ readingPaused: true });
    this.cancelKick?.();
    this.cancelKick = null;
    const { enabled } = await this.deps.settings.get();
    if (enabled && this.progress.state !== "off") {
      this.setProgress({ state: "paused", reason: "pausedByPerson" });
    }
    this.deps.onChanged();
    return this.status();
  }

  async resumeReading(): Promise<AgentStatus> {
    this.readingPaused = false;
    await this.deps.settings.update({ readingPaused: false });
    const { enabled } = await this.deps.settings.get();
    if (enabled) {
      // Not debounced: the person pressed Continue and expects it to move.
      if (
        this.progress.state === "paused" &&
        (this.progress.reason === "pausedByPerson" || this.progress.reason === "limit")
      ) {
        this.setProgress({ state: "checking" });
      }
      this.runPass();
    }
    this.deps.onChanged();
    return this.status();
  }

  // --- AgentApi: settings and consent ---

  /**
   * The person agreed that these accounts' mail goes to this runtime (ADR 0051, rule 6; ADR 0121,
   * rule 4), and AI is on. Agreeing moves no kind of work, except the first time: until the person
   * chooses otherwise, every kind is on the first runtime they connect (rule 12).
   */
  async setEnabled(input: {
    accountIds: readonly string[];
    runtimeId: string;
  }): Promise<AgentStatus> {
    const { settings, insights } = this.deps;
    const runtime = this.runtimeById(input.runtimeId);
    if (runtime === NO_RUNTIME) {
      throw new InvalidAgentSettingError("That assistant is not available.");
    }
    const known = new Set((await this.deps.accounts.list()).map((a) => a.id));
    const accountIds = [...new Set(input.accountIds)];
    if (accountIds.length === 0 || accountIds.some((id) => !known.has(id))) {
      throw new InvalidAgentSettingError("Choose at least one of your accounts.");
    }
    const atMs = this.now;
    // Each account's line says what the person agreed to; no thread goes with a consent.
    const lines = [];
    for (const accountId of accountIds) {
      await settings.grantConsent(accountId, runtime.id, atMs);
      lines.push({
        atMs,
        runtimeId: runtime.id,
        accountId,
        purpose: "consent" as const,
        threads: 0,
      });
    }
    const first = runtimesInUse(await settings.get()).length === 0;
    await settings.update({
      enabled: true,
      ...(first ? { kindRuntime: everyKindOn(runtime.id) } : {}),
    });
    await insights.appendLedger(lines);
    await this.addStarterView();
    this.blocked.delete(runtime.id);
    this.setProgress({ state: "checking" });
    await this.inspectRuntime(runtime);
    this.deps.onChanged();
    this.startNow();
    return this.status();
  }

  /**
   * The person moves kinds of work to a runtime (ADR 0121, rule 1). What runs for those kinds
   * stops first and keeps nothing half done; the other kinds go on (rule 3). Each runtime keeps
   * its own models and efforts, and a runtime that keeps none for a kind starts it on its starting
   * values (rule 5). Consent is not carried over: the turns of a kind work with the accounts that
   * agreed to its runtime (rule 4), and the person is asked before, in the window. Nothing is
   * sent: the runtime is only looked at, and tested by itself when an account agreed to it.
   */
  async setKindRuntime(kinds: readonly AgentWorkKind[], runtimeId: string): Promise<AgentStatus> {
    const runtime = this.runtimeById(runtimeId);
    if (runtime === NO_RUNTIME) {
      throw new InvalidAgentSettingError("That assistant is not available.");
    }
    const asked = [...new Set(kinds)];
    if (asked.length === 0 || asked.some((k) => !AGENT_WORK_KINDS.includes(k))) {
      throw new InvalidAgentSettingError("Choose a kind of work.");
    }
    const s = await this.deps.settings.get();
    const moved = asked.filter((k) => s.kindRuntime[k] !== runtime.id);
    if (moved.length > 0) {
      await this.stopKinds(moved);
      await this.deps.settings.update({
        kindRuntime: Object.fromEntries(moved.map((k) => [k, runtime.id])),
      });
      if (moved.includes("understand")) {
        this.progress = { state: "off", reason: "disabled" };
      }
      await this.inspectRuntime(runtime).catch(() => {});
      if ((await this.deps.settings.get()).enabled) this.startNow();
    }
    this.deps.onChanged();
    return this.status();
  }

  /** Stops every turn of these kinds, and the pass when it is one of them. */
  private async stopKinds(kinds: readonly AgentWorkKind[]): Promise<void> {
    for (const kind of kinds) {
      this.kindAborts.get(kind)?.abort();
      this.kindAborts.set(kind, new AbortController());
    }
    if (kinds.includes("understand")) {
      this.cancelKick?.();
      this.cancelKick = null;
      await this.pass?.catch(() => {});
    }
  }

  async disable(): Promise<AgentStatus> {
    const { settings, insights } = this.deps;
    this.cancelKick?.();
    this.cancelKick = null;
    // A run in flight is cut short: nothing more is sent once the person says no, on any runtime.
    this.abort.abort();
    await this.pass?.catch(() => {});
    this.abort = new AbortController();
    const atMs = this.now;
    const consents = await settings.listConsents();
    // Turning AI off ends the person's pause too: the next time starts fresh.
    this.readingPaused = false;
    await settings.update({ enabled: false, readingPaused: false });
    for (const c of consents) {
      await settings.revokeConsent(c.accountId, c.runtimeId);
    }
    if (consents.length > 0) {
      await insights.appendLedger(
        consents.map((c) => ({
          atMs,
          runtimeId: c.runtimeId,
          accountId: c.accountId,
          purpose: "revoke" as const,
          threads: 0,
        })),
      );
    }
    this.progress = { state: "off", reason: "disabled" };
    this.deps.onChanged();
    return this.status();
  }

  /** Takes an account's consent back: for one runtime, or without one for every runtime. */
  async revokeConsent(accountId: string, runtimeId?: string): Promise<AgentStatus> {
    const { settings, insights } = this.deps;
    const had = (await settings.listConsents()).filter(
      (c) => c.accountId === accountId && (runtimeId === undefined || c.runtimeId === runtimeId),
    );
    if (had.length === 0) return this.status();
    this.cancelKick?.();
    this.cancelKick = null;
    // A run in flight may hold this account's mail: it is cut short, then the others go on.
    this.abort.abort();
    await this.pass?.catch(() => {});
    this.abort = new AbortController();
    const atMs = this.now;
    for (const c of had) await settings.revokeConsent(c.accountId, c.runtimeId);
    await insights.appendLedger(
      had.map((c) => ({
        atMs,
        runtimeId: c.runtimeId,
        accountId: c.accountId,
        purpose: "revoke" as const,
        threads: 0,
      })),
    );
    this.deps.onChanged();
    this.kick();
    return this.status();
  }

  /**
   * The model and the effort of each kind of work (ADR 0051, rule 6; ADR 0118, rule 1), kept by
   * the runtime the kind is on (ADR 0121, rule 5). A kind left out keeps what it has. A model is
   * checked against what that runtime lists; an effort against the levels, not against what the
   * runtime lists: a stored level the runtime does not list is sent as `default` (rule 4).
   */
  async setModels(
    models: Partial<AgentModels>,
    efforts: Partial<AgentEfforts> = {},
  ): Promise<AgentStatus> {
    const current = await this.deps.settings.get();
    type Change = {
      models: Partial<Record<AgentWorkKind, string>>;
      efforts: Partial<Record<AgentWorkKind, AgentEffortSetting>>;
    };
    const change: Record<string, Change> = {};
    const on = (kind: AgentWorkKind): { id: string; entry: Change } => {
      const id = current.kindRuntime[kind];
      if (id === undefined) throw new InvalidAgentSettingError("Choose who does this work first.");
      const entry = change[id] ?? { models: {}, efforts: {} };
      change[id] = entry;
      return { id, entry };
    };
    for (const key of AGENT_WORK_KINDS) {
      const value = efforts[key];
      if (value === undefined) continue;
      if (!isAgentEffortSetting(value)) {
        throw new InvalidAgentSettingError("That effort is not one of the levels.");
      }
      on(key).entry.efforts[key] = value;
    }
    for (const key of AGENT_WORK_KINDS) {
      const value = models[key];
      if (value === undefined) continue;
      const { id, entry } = on(key);
      const known = this.infoOf(id)?.models ?? [];
      const ok =
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 64 &&
        ((key === "titles" && value === TITLES_OFF) || known.length === 0 || known.includes(value));
      if (!ok) throw new InvalidAgentSettingError("That model is not available.");
      entry.models[key] = value;
    }
    const before = Object.fromEntries(
      Object.keys(change).map((id) => [id, this.testModel(id, current, { models: [] })]),
    );
    // The model or effort for understanding mail changed: the turns of the old choice stop, and
    // the reading goes on at once on the new one (ADR 0117, rule 3a), with no ↵ and no sync.
    const reader = current.kindRuntime.understand;
    const was = reader === undefined ? undefined : choicesOn(current, reader);
    const understandChanged =
      reader !== undefined &&
      was !== undefined &&
      ((models.understand !== undefined && models.understand !== was.models.understand) ||
        (efforts.understand !== undefined && efforts.understand !== was.efforts.understand));
    if (understandChanged) await this.stopKinds(["understand"]);
    const next = await this.deps.settings.update({ choices: change });
    // The test is for a model (ADR 0119): a runtime whose model for the test changed is not checked
    // yet. With AI on and an account agreed to it, it is tested by itself, with the made-up message.
    for (const id of Object.keys(change)) {
      if (this.testModel(id, next, { models: [] }) === before[id] || this.infoOf(id) === null) {
        continue;
      }
      const runtime = this.runtimeById(id);
      // No press of the person's asks for this test: its ticket comes before the switch is read
      // (ADR 0141, rule 6).
      const ticket = this.runtimeKeys.ticket(id);
      const info = await this.inspectRuntime(runtime);
      if (
        info.status === "found" &&
        next.enabled &&
        runtimesInUse(next).includes(id) &&
        this.testsAlone(id, next, await this.deps.settings.listConsents()) &&
        (await this.testsInBackground(id))
      ) {
        // Once the new choice passed its check, the reading starts on it at once.
        void this.testRuntimes([runtime], ticket)
          .then(() => {
            if (understandChanged && id === reader) this.startNow();
          })
          .catch(() => {});
      }
    }
    this.deps.onChanged();
    if (understandChanged) this.startNow();
    else this.kick();
    return this.status();
  }

  async setWeekShare(percent: number): Promise<AgentStatus> {
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new InvalidAgentSettingError("The share of the week is 0 to 100 percent.");
    }
    await this.deps.settings.update({ weekSharePercent: percent });
    this.deps.onChanged();
    this.kick();
    return this.status();
  }

  // --- AgentApi: the person's own API key (ADR 0141) ---

  /** A runtime billed to the person's key, by id; refused for any other. */
  private async keyedRuntime(runtimeId: string): Promise<AgentRuntime> {
    const runtime = this.runtimeById(runtimeId);
    if (runtime === NO_RUNTIME || this.deps.keys === undefined) {
      throw new InvalidAgentSettingError("That assistant is not available.");
    }
    // What it is is the runtime's to say: one not looked at yet is looked at first.
    const info = this.infoOf(runtime.id) ?? (await this.inspectOne(runtime).catch(() => null));
    if (info?.billed !== true) {
      throw new InvalidAgentSettingError("That assistant does not take an API key.");
    }
    return runtime;
  }

  /**
   * The runtime has a new key, or none: every turn, look and test on the key before stops, and
   * nothing it found is kept (ADR 0141, rules 4 and 5); the pass stops when it reads there. Once
   * before the vault is written, and once more as its write ends (`change`), so what began before
   * or while it was written holds for neither key.
   */
  private async nextKey(runtimeId: string): Promise<void> {
    this.runtimeKeys.next(runtimeId);
    await this.stopKinds(kindsOn(await this.deps.settings.get(), runtimeId));
  }

  /**
   * Keeps the key the person pasted for a runtime, in the vault as a mail password is kept (rule
   * 4), replacing one kept before, and looks at the runtime with it: the provider lists its models
   * or refuses the key. Nothing is sent but that look, and the key is not tested yet (rule 5). The
   * answer, as every answer to a window, says only whether a key is kept. One at a time with the
   * other commands of the runtime's key.
   */
  saveKey(runtimeId: string, key: string): Promise<AgentStatus> {
    return this.runtimeKeys.serial(runtimeId, () => this.saveKeyNow(runtimeId, key));
  }

  private async saveKeyNow(runtimeId: string, key: string): Promise<AgentStatus> {
    const runtime = await this.keyedRuntime(runtimeId);
    const keys = this.deps.keys as AgentKeyVaultPort;
    const trimmed = typeof key === "string" ? key.trim() : "";
    const problem = apiKeyProblem(trimmed);
    if (problem !== null) throw new InvalidAgentSettingError(problem);
    // A saved key is a new key, the same text saved again too: nothing reads on it in the
    // background until the person turns that on for it (rule 6). That is undone first, so a key
    // is never kept with the switch of the one before: if it cannot be, nothing new is kept. No
    // press of the switch runs until this command has ended.
    let s: AgentSettings;
    try {
      s = await this.setReading(runtime.id, false);
    } catch {
      throw new InvalidAgentSettingError("The key could not be saved. Try again.");
    }
    // Turns that run on the old key stop: nothing new goes on it, and nothing they find is kept
    // for this one. A test that ran on it is not kept either; its stored record names the old
    // key's id. A look or a test that began while the vault was written may have read the key
    // before: its ticket holds for neither key.
    await this.nextKey(runtime.id);
    await this.runtimeKeys.change(runtime.id, async () => {
      try {
        await keys.set(runtime.id, { key: trimmed, savedAtMs: this.now, id: randomUUID() });
      } catch (error) {
        // The vault's reasons never hold the key; a refusal there says why secrets cannot be kept.
        throw new InvalidAgentSettingError(
          error instanceof CredentialsUnavailableError
            ? error.message
            : "The key could not be saved. Try again.",
        );
      }
    });
    this.blocked.delete(runtime.id);
    await this.inspectRuntime(runtime).catch(() => {});
    this.deps.onChanged();
    if (s.enabled) this.kick();
    return this.status();
  }

  /**
   * Removes the key of a runtime (rule 4). Its turns stop; every account's consent to it is taken
   * back, with a line in the ledger, and it no longer reads in the background: a key added later
   * is agreed to again. The kinds of work on it stay there and wait (no fallback). One at a time
   * with the other commands of the runtime's key.
   */
  removeKey(runtimeId: string): Promise<AgentStatus> {
    return this.runtimeKeys.serial(runtimeId, () => this.removeKeyNow(runtimeId));
  }

  private async removeKeyNow(runtimeId: string): Promise<AgentStatus> {
    const runtime = await this.keyedRuntime(runtimeId);
    const keys = this.deps.keys as AgentKeyVaultPort;
    const { settings, insights } = this.deps;
    await this.nextKey(runtime.id);
    // A look or a test that began while the vault was written may have read the key.
    await this.runtimeKeys.change(runtime.id, () => keys.delete(runtime.id));
    const had = (await settings.listConsents()).filter((c) => c.runtimeId === runtime.id);
    for (const c of had) await settings.revokeConsent(c.accountId, c.runtimeId);
    if (had.length > 0) {
      await insights.appendLedger(
        had.map((c) => ({
          atMs: this.now,
          runtimeId: c.runtimeId,
          accountId: c.accountId,
          purpose: "revoke" as const,
          threads: 0,
        })),
      );
    }
    await this.setReading(runtime.id, false);
    await this.inspectRuntime(runtime).catch(() => {});
    this.deps.onChanged();
    this.kick();
    return this.status();
  }

  /**
   * Lets a runtime billed to the person's key work in the background, or stops it (rule 6). Off,
   * which is where it starts, only what the person asks for runs on it. One at a time with the
   * other commands of the runtime's key: a press during a save or a removal runs once that has
   * ended, for the key then kept, and reads the settings as they are then.
   */
  setKeyReading(runtimeId: string, on: boolean): Promise<AgentStatus> {
    return this.runtimeKeys.serial(runtimeId, () => this.setKeyReadingNow(runtimeId, on));
  }

  private async setKeyReadingNow(runtimeId: string, on: boolean): Promise<AgentStatus> {
    const runtime = await this.keyedRuntime(runtimeId);
    if (!on && (await this.deps.settings.get()).kindRuntime.understand === runtime.id) {
      await this.stopKinds(["understand"]);
    }
    const s = await this.setReading(runtime.id, on === true);
    this.deps.onChanged();
    if (on === true && s.enabled) this.startNow();
    return this.status();
  }

  /**
   * Writes one runtime's reading switch into the list of them all. The list is shared by every
   * runtime, whose commands run at once, so each change of it reads and writes it alone. Turned
   * off, no background work whose ticket was taken before goes, nor one taken while it is written,
   * though it read the switch still on (rule 6).
   */
  private setReading(runtimeId: string, on: boolean): Promise<AgentSettings> {
    return this.runtimeKeys.serial(READING_LIST, async () => {
      const s = await this.deps.settings.get();
      if (keyReadingOn(s, runtimeId) === on) return s;
      const others = (s.keyReading ?? []).filter((id) => id !== runtimeId);
      if (on) return this.deps.settings.update({ keyReading: [...others, runtimeId] });
      this.runtimeKeys.readingOff(runtimeId);
      try {
        return await this.deps.settings.update({ keyReading: others });
      } finally {
        this.runtimeKeys.readingOff(runtimeId);
      }
    });
  }

  async setTalkLoop(on: boolean): Promise<AgentStatus> {
    await this.deps.settings.update({ talkLoop: on === true });
    this.deps.onChanged();
    return this.status();
  }

  // --- AgentApi: the person asks ---

  /**
   * The gates of a turn of `kind` the person asked for about a thread (ADR 0063), in order: AI on,
   * the thread exists, its account agreed to the runtime of the turn (ADR 0121, rule 4), that
   * runtime ready, its plan has room. Gives the settings, the runtime and the turn the gates
   * passed for; the one turn works from the thread alone.
   */
  private async gateForAsk(threadId: string, kind: AgentWorkKind, runtime?: AgentRuntime) {
    const { s, on, turn } = await this.gateOn(kind, runtime);
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    if (view === null) throw new ThingNotFoundError();
    const accountId = view.thread.accountId;
    await this.gateAccount(accountId, on, s, turn);
    return { s, accountId, runtime: on, turn };
  }

  /**
   * The gates of a turn for a message with no thread (ADR 0132): the same as `gateForAsk`, by the
   * account the message goes out from instead of a thread's account.
   */
  private async gateForAccount(accountId: string, kind: AgentWorkKind) {
    const { s, on, turn } = await this.gateOn(kind);
    await this.gateAccount(accountId, on, s, turn);
    return { s, accountId, runtime: on, turn };
  }

  /** The gates of help with a message: by its thread when it answers one, else by its account. */
  private gateForDraft(about: DraftFor, kind: AgentWorkKind) {
    return "threadId" in about
      ? this.gateForAsk(about.threadId, kind)
      : this.gateForAccount(about.accountId, kind);
  }

  /**
   * The first gates of a turn the person asked for: AI on, and a runtime for the work. The turn is
   * taken as soon as the runtime is known, before any gate after it waits, so every gate is about
   * the key of that turn and the turn goes on no other (ADR 0141, rule 5).
   */
  private async gateOn(kind: AgentWorkKind, runtime?: AgentRuntime) {
    const s = await this.currentSettings();
    const on = runtime ?? this.runtimeFor(kind, s);
    if (!s.enabled) throw new AgentUnavailableError(NOT_READY);
    if (on === NO_RUNTIME) throw new AgentUnavailableError(NOT_READY);
    return { s, on, turn: this.turnOf(kind, on.id) };
  }

  /** The account agreed to the runtime (ADR 0121, rule 4), then the runtime's own gates. */
  private async gateAccount(accountId: string, on: AgentRuntime, s: AgentSettings, turn: Turn) {
    if (!(await consentedAccounts(this.deps, on.id)).has(accountId)) {
      throw new AgentUnavailableError(noConsent(on));
    }
    await this.gateRuntime(on, s, turn.ticket);
  }

  /**
   * The last gates of a turn the person asked for: the runtime is ready and its plan has room. A
   * runtime not tested yet is tested first, with the made-up message only: the person agreed to it
   * and asked for this turn. Each is decided for the key of `ticket`, the turn's, taken before
   * the gates: what was found on a key before is not looked at, and a key saved or removed while
   * they wait stops the turn (ADR 0141, rule 5).
   */
  private async gateRuntime(
    runtime: AgentRuntime,
    s: AgentSettings,
    ticket: KeyTicket,
  ): Promise<void> {
    if (runtime === NO_RUNTIME) throw new AgentUnavailableError(NOT_READY);
    if (this.infoFor(ticket) === null) await this.inspectRuntime(runtime);
    if (this.infoFor(ticket)?.status === "found" && !this.blocked.has(runtime.id)) {
      await this.sharedTest(runtime);
    }
    if (!this.runtimeKeys.holds(ticket)) throw new AgentUnavailableError("Stopped.");
    if (this.infoFor(ticket)?.status !== "ready") {
      throw new AgentUnavailableError(notReady(runtime));
    }
    if (!this.planGate(runtime.id, "P0", s).ok) throw new AgentUnavailableError(USED_UP);
  }

  /**
   * The runtime and model of a talk (ADR 0121, rule 8): the person's choice in that talk, when it
   * names a runtime this build knows, a model that runtime lists, and an account agreed to it;
   * else the choice for its kind of work.
   */
  private talkOn(
    kind: "write" | "answer",
    s: AgentSettings,
    choice: TalkChoice | undefined,
  ): { runtime: AgentRuntime; model: string } {
    if (choice === undefined) {
      const runtime = this.runtimeFor(kind, s);
      if (runtime === NO_RUNTIME) throw new AgentUnavailableError(NOT_READY);
      return { runtime, model: this.modelFor(kind, s, runtime) };
    }
    const runtime = this.runtimeById(choice.runtimeId);
    if (runtime === NO_RUNTIME) {
      throw new InvalidAgentSettingError("That assistant is not available.");
    }
    if (!modelListed(this.infoOf(runtime.id), kind, choice.model) || choice.model === TITLES_OFF) {
      throw new InvalidAgentSettingError("That model is not available.");
    }
    return { runtime, model: choice.model };
  }

  /**
   * What the person is told when a turn they asked for fails; the error is not shown as it is.
   * What it says of the runtime (signed out, a refused key) is kept only while the key of `ticket`,
   * taken when the turn began, is the runtime's key (ADR 0141, rule 5).
   */
  private askFailure(error: unknown, fallback: string, ticket: KeyTicket): Error {
    if (error instanceof AgentUnavailableError || error instanceof ThingNotFoundError) return error;
    if (error instanceof InvalidAgentSettingError) return error;
    if (isAgentRunError(error) && (error.code === "notSignedIn" || error.code === "notPlan")) {
      this.block(ticket, error.code === "notPlan" ? "notPlan" : "signedOut");
      return new AgentUnavailableError(
        "The assistant is signed out or not using your plan. Check it in Settings.",
      );
    }
    if (isAgentRunError(error) && error.code === "limit") return new AgentUnavailableError(USED_UP);
    // The provider refused the person's key (ADR 0141, rule 5): the adapter's sentence says why
    // in its class, and Settings shows the same until the key is looked at again.
    if (isAgentRunError(error) && error.code === "refused") {
      const info = this.infoOf(ticket.runtimeId);
      // A refusal of the key before says nothing of the key now.
      if (info?.billed === true && this.runtimeKeys.holds(ticket)) {
        this.setInfo(ticket, { ...info, status: "keyRefused", problem: error.message });
        this.deps.onChanged();
      }
      return new AgentUnavailableError(error.message);
    }
    // The model does not take the effort set for this work: said as the runtime said it, which
    // is a sentence of the adapter's naming the model and the level (ADR 0118, rule 5).
    if (isAgentRunError(error) && error.code === "effortRefused") {
      return new AgentUnavailableError(error.message);
    }
    // Too long for the model: a sentence of the adapter's naming the model (ADR 0119, rule 8).
    if (isAgentRunError(error) && error.code === "tooLong") {
      return new AgentUnavailableError(error.message);
    }
    return new AgentUnavailableError(fallback);
  }

  async prepare(threadId: string, guidance?: PreparedGuidance): Promise<PrepareResult> {
    const { s, runtime, turn } = await this.gateForAsk(threadId, "write");
    try {
      const model = this.modelFor("write", s, runtime);
      return await this.prepareFor(
        threadId,
        runtime,
        model,
        guidance !== undefined && (guidance.direction ?? guidance.answer) !== undefined
          ? guidance
          : undefined,
        this.effortOn("write", s, runtime, model),
        turn,
      );
    } catch (error) {
      throw this.askFailure(error, "The assistant could not prepare this. Try again.", turn.ticket);
    }
  }

  // --- Help with a reply (ADR 0098) ---

  /** The model for writing of a reply helper's turn, on the runtime for writing. */
  private writeModel(s: AgentSettings, runtime: AgentRuntime): string {
    return this.modelFor("write", s, runtime);
  }

  /**
   * The model of a reply helper's turn that reads (check, fill gaps): help with a reply is writing
   * (ADR 0121), so it runs on the runtime for writing, on the model that runtime keeps for reading.
   */
  private readingModel(s: AgentSettings, runtime: AgentRuntime): string {
    return this.modelFor("understand", s, runtime, () => this.writeModel(s, runtime));
  }

  /** The person's lines of the composer's text, refused before any gate when they cannot go. */
  private ownLines(text: string, needWords: boolean): DraftParts {
    const parts = splitDraft(text);
    if (needWords && parts.own.trim() === "") {
      throw new InvalidAgentSettingError("Write something in the reply first.");
    }
    if (parts.own.length > MAX_HELP_DRAFT_CHARS) {
      throw new InvalidAgentSettingError("The reply is too long for the assistant.");
    }
    return parts;
  }

  /** The thread as the model sees it, after the gates. */
  private async helpThread(threadId: string, runtime: AgentRuntime): Promise<PromptThread> {
    const consented = await consentedAccounts(this.deps, runtime.id);
    const loaded = await this.loadThread(threadId, consented);
    if (loaded === null) {
      throw new ThingNotFoundError("That thread is not available to the assistant");
    }
    return loaded.thread;
  }

  /**
   * One `P0` turn for help with a reply. Counted in the ledger as `prepare` whether or not it
   * worked; `threads` is 0 when no mail went (a rewrite gets only the person's lines).
   */
  private async helpTurn(
    turn: Turn,
    runtime: AgentRuntime,
    accountId: string,
    threads: number,
    run: { model: string; request: AgentRequestBody; effort: AgentEffort | undefined },
    failed: string,
  ): Promise<unknown> {
    const { insights, settings } = this.deps;
    const before = this.limitsOf(runtime.id, await settings.get());
    // The turn its gate passed for, handed down: a key saved since stops it here, before anything
    // went, so no line in the ledger.
    this.goes(turn);
    let value: unknown;
    try {
      const result = await runtime.run(
        {
          model: run.model,
          ...run.request,
          ...withEffort(run.effort),
        },
        { signal: turn.signal },
      );
      await this.afterTurn(turn.ticket, result.limits, before);
      value = result.value;
    } catch (error) {
      throw this.askFailure(error, failed, turn.ticket);
    } finally {
      await insights.appendLedger([
        {
          atMs: this.now,
          runtimeId: runtime.id,
          accountId,
          purpose: "prepare",
          threads,
          ...withEffort(run.effort),
        },
      ]);
    }
    // After the ledger's wait too: the answer of the key before is not handed back.
    return this.handed(turn.ticket, value);
  }

  async rewriteDraft(about: DraftFor, text: string, how: RewriteHow): Promise<{ text: string }> {
    if (!REWRITE_HOWS.includes(how)) {
      throw new InvalidAgentSettingError("The draft can be made shorter, formal or English.");
    }
    const parts = this.ownLines(text, true);
    const { s, accountId, runtime, turn } = await this.gateForDraft(about, "write");
    const standing = {
      list: await this.deps.insights.listInstructions(),
      threadId: threadOf(about),
    };
    const model = this.writeModel(s, runtime);
    const value = await this.helpTurn(
      turn,
      runtime,
      accountId,
      0,
      {
        model,
        request: buildRewriteRequest(parts.own, how, standing),
        effort: this.effortOn("write", s, runtime, model),
      },
      "The assistant could not rewrite this. Try again.",
    );
    const got = acceptRewrite(value, parts.own);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return { text: joinDraft(got.value, parts.quote, parts.signature) };
  }

  async writeDraft(
    about: DraftFor,
    subject: string,
    text: string,
    words: string,
  ): Promise<{ text: string }> {
    const asked = words.replace(/\s+/g, " ").trim();
    if (asked === "") throw new InvalidAgentSettingError("Tell the agent what to write first.");
    if (asked.length > MAX_WRITE_WORDS_CHARS) {
      throw new InvalidAgentSettingError("That is too long to ask the agent. Say it shorter.");
    }
    const parts = this.ownLines(text, false);
    const { s, accountId, runtime, turn } = await this.gateForDraft(about, "write");
    const threadId = threadOf(about);
    const model = this.writeModel(s, runtime);
    // Only a reply sends its thread with it; a new message sends no mail.
    const room = this.roomFor(runtime, model);
    const thread =
      threadId === ""
        ? undefined
        : {
            thread: await this.helpThread(threadId, runtime),
            nowMs: this.now,
            ...(room === undefined ? {} : { room }),
          };
    const standing = { list: await this.deps.insights.listInstructions(), threadId };
    const value = await this.helpTurn(
      turn,
      runtime,
      accountId,
      thread === undefined ? 0 : 1,
      {
        model,
        request: buildWriteRequest(
          {
            words: asked,
            subject,
            own: parts.own,
            ...(thread === undefined ? {} : { thread }),
          },
          standing,
        ),
        effort: this.effortOn("write", s, runtime, model),
      },
      "The assistant could not write this. Try again.",
    );
    const got = acceptWrite(value, parts.own, subject);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return {
      text:
        got.value === parts.own.trim() ? text : joinDraft(got.value, parts.quote, parts.signature),
    };
  }

  // --- A theme from a description (ADR 0134, rules 12 to 15) ---

  async makeThemeStop(): Promise<void> {
    this.makingTheme?.abort();
  }

  /**
   * One turn of the kind `appearance` on its own runtime, model and effort (rule 13), and on no
   * other (rule 15). Its gates are AI on, the runtime ready and room in its plan as work the person
   * asked for (`P0`); no account is asked, since no mail goes (rule 14). The ledger names the turn
   * with its kind, with no account and no thread. The answer is the theme's text: it is not
   * checked, stored or applied here, but handed back for main's check (rule 12).
   */
  async makeTheme(input: ThemeInput): Promise<{ text: string }> {
    const description = input.description.replace(/\s+/g, " ").trim();
    if (description === "") throw new InvalidAgentSettingError("Describe the theme first.");
    if (description.length > MAX_THEME_DESCRIPTION_CHARS) {
      throw new InvalidAgentSettingError("That description is too long. Say it in fewer words.");
    }
    if (this.makingTheme !== null) {
      throw new AgentUnavailableError("The assistant is still making a theme.");
    }
    // Taken before the first wait, so a second call cannot slip in during the gates.
    const mine = new AbortController();
    this.makingTheme = mine;
    // The kind's stop, also taken before the gates: moving the kind to another runtime while they
    // wait aborts this one and stores a new one, and the turn must not then run on the runtime the
    // person moved it from (rule 15).
    let stop = AbortSignal.any([this.signalOf("appearance", ""), mine.signal]);
    let ticket = this.runtimeKeys.ticket("");
    try {
      const { s, on, turn } = await this.gateOn("appearance");
      ticket = turn.ticket;
      stop = AbortSignal.any([stop, turn.signal]);
      await this.gateRuntime(on, s, ticket);
      const model = this.modelFor("appearance", s, on);
      const effort = this.effortOn("appearance", s, on, model);
      const request = buildThemeRequest(
        {
          description,
          ...(input.current === undefined ? {} : { current: input.current }),
          ...(input.retry === undefined ? {} : { retry: input.retry }),
        },
        THEME_FORMAT,
      );
      const before = this.limitsOf(on.id, await this.deps.settings.get());
      // Stopped before anything left: no turn, so no line in the ledger.
      if (stop.aborted) throw new AgentUnavailableError("Stopped.");
      this.goes(turn);
      let value: unknown;
      try {
        const run = await on.run({ model, ...request, ...withEffort(effort) }, { signal: stop });
        await this.afterTurn(ticket, run.limits, before);
        value = run.value;
      } finally {
        // Counted whether or not it worked; no account and no thread went (rule 15).
        await this.deps.insights.appendLedger([
          {
            atMs: this.now,
            runtimeId: on.id,
            accountId: "",
            purpose: "appearance",
            threads: 0,
            ...withEffort(effort),
          },
        ]);
      }
      if (stop.aborted) throw new AgentUnavailableError("Stopped.");
      const text = themeTextOf(value, THEME_FORMAT);
      if (text === null) throw new AgentUnavailableError(NOT_A_THEME);
      return { text: this.handed(ticket, text) };
    } catch (error) {
      if (stop.aborted) throw new AgentUnavailableError("Stopped.");
      throw this.askFailure(error, THEME_FAILED, ticket);
    } finally {
      this.makingTheme = null;
    }
  }

  async answerQuestions(
    threadId: string,
    text: string,
    missing: readonly string[] = [],
  ): Promise<{ text: string }> {
    const parts = this.ownLines(text, false);
    const { s, accountId, runtime, turn } = await this.gateForAsk(threadId, "write");
    const thread = await this.helpThread(threadId, runtime);
    const last = lastFromThem(thread);
    // Nobody else wrote, or a list or a program did: there is nothing to answer, and no turn.
    if (last === null || last.message.automated === true) return { text };
    const standing = { list: await this.deps.insights.listInstructions(), threadId };
    const model = this.writeModel(s, runtime);
    const value = await this.helpTurn(
      turn,
      runtime,
      accountId,
      1,
      {
        model,
        request: buildAnswerQuestionsRequest(
          thread,
          last,
          parts.own,
          this.now,
          standing,
          missing,
          this.roomFor(runtime, model),
        ),
        effort: this.effortOn("write", s, runtime, model),
      },
      "The assistant could not answer the questions. Try again.",
    );
    const got = acceptAnswers(value, parts.own);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return {
      text: got.value === parts.own ? text : joinDraft(got.value, parts.quote, parts.signature),
    };
  }

  async checkReply(threadId: string, text: string): Promise<ReplyCheck> {
    const parts = this.ownLines(text, false);
    const { s, accountId, runtime, turn } = await this.gateForAsk(threadId, "write");
    const last = lastFromThem(await this.helpThread(threadId, runtime));
    // Mail from a list or a program asks nothing of the person (ADR 0098 addendum): no turn.
    if (last === null || last.text === "" || last.message.automated === true) {
      return { asked: 0, answered: 0, missing: [] };
    }
    const model = this.readingModel(s, runtime);
    const value = await this.helpTurn(
      turn,
      runtime,
      accountId,
      1,
      {
        model,
        request: buildCheckReplyRequest(last, parts.own),
        effort: this.effortOn("understand", s, runtime, model),
      },
      "The assistant could not check the reply. Try again.",
    );
    const got = acceptCheck(value);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return got.value;
  }

  async fillGaps(threadId: string, text: string): Promise<readonly GapSuggestion[]> {
    const parts = this.ownLines(text, false);
    const { s, accountId, runtime, turn } = await this.gateForAsk(threadId, "write");
    const tokens = draftGaps(parts.own).slice(0, MAX_GAPS);
    // No gap to fill: no turn.
    if (tokens.length === 0) return [];
    const thread = await this.helpThread(threadId, runtime);
    const model = this.readingModel(s, runtime);
    const value = await this.helpTurn(
      turn,
      runtime,
      accountId,
      1,
      {
        model,
        request: buildFillGapsRequest(
          thread,
          parts.own,
          tokens,
          this.now,
          this.roomFor(runtime, model),
        ),
        effort: this.effortOn("understand", s, runtime, model),
      },
      "The assistant could not look for the missing values. Try again.",
    );
    const got = acceptFills(value, tokens, thread.messages);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return got.value;
  }

  // --- The talk about a thread (ADR 0064) ---

  async talkEntries(threadId: string): Promise<readonly TalkEntry[]> {
    return readTalk(this.readDeps(), threadId);
  }

  async talkStop(threadId: string): Promise<void> {
    this.talking.get(threadId)?.abort();
  }

  async talk(threadId: string, words: string, choice?: TalkChoice): Promise<TalkResult> {
    const typed = words.trim().slice(0, MAX_GUIDANCE_CHARS);
    if (typed === "") throw new InvalidAgentSettingError("Write something to ask or say first.");
    if (this.talking.has(threadId)) {
      throw new AgentUnavailableError("The assistant is still working on this thread.");
    }
    // Taken before the first wait, so a second call cannot slip in during the gates.
    const mine = new AbortController();
    this.talking.set(threadId, mine);
    let ticket = this.runtimeKeys.ticket("");
    try {
      const first = this.talkOn("write", await this.currentSettings(), choice);
      // The gates may look at the runtime and test it: what they find there they keep themselves.
      ticket = this.runtimeKeys.ticket(first.runtime.id);
      const { s, turn } = await this.gateForAsk(threadId, "write", first.runtime);
      ticket = turn.ticket;
      // Once the runtime is looked at, its model is checked against what it lists now. The turn
      // goes on the runtime its gates passed for, or on none.
      const picked = this.talkOn("write", s, choice);
      if (picked.runtime !== first.runtime) throw new AgentUnavailableError("Stopped.");
      return await this.talkNow(
        threadId,
        typed,
        picked.runtime,
        picked.model,
        this.effortOn("write", s, picked.runtime, picked.model),
        mine.signal,
        turn,
      );
    } catch (error) {
      if (mine.signal.aborted && !(error instanceof ThingNotFoundError)) {
        throw new AgentUnavailableError("Stopped.");
      }
      throw this.askFailure(error, TALK_FAILED, ticket);
    } finally {
      this.talking.delete(threadId);
    }
  }

  /** One turn: the thread and its talk go out, and only an answer the code accepts is kept. */
  private async talkNow(
    threadId: string,
    words: string,
    runtime: AgentRuntime,
    model: string,
    effort: AgentEffort | undefined,
    stop: AbortSignal,
    turn: Turn,
  ): Promise<TalkResult> {
    const { insights, settings } = this.deps;
    const consented = await consentedAccounts(this.deps, runtime.id);
    const loaded = await this.loadThread(threadId, consented);
    if (loaded === null)
      throw new ThingNotFoundError("That thread is not available to the assistant");
    const { accountId, lastMessageKey } = loaded;
    // The question the agent left open goes with the turn, so words typed as its answer have it.
    const open = await preparedFor(this.readDeps(), threadId);
    const request = buildTalkRequest(
      loaded.thread,
      this.now,
      await insights.listTalk(threadId, MAX_TALK_SHOWN),
      words,
      { list: await insights.listInstructions(), threadId },
      open?.kind === "needs" ? open : null,
      this.roomFor(runtime, model),
    );
    const before = this.limitsOf(runtime.id, await settings.get());
    // Stopped before anything left: no mail went, so no line in the ledger.
    if (stop.aborted) throw new AgentUnavailableError("Stopped.");
    this.goes(turn);
    try {
      // The service's own signal still cuts the turn short when AI is turned off or consent goes.
      const run = await runtime.run(
        { model, ...request, ...withEffort(effort) },
        { signal: AbortSignal.any([turn.signal, stop]) },
      );
      await this.afterTurn(turn.ticket, run.limits, before);
      if (stop.aborted) throw new AgentUnavailableError("Stopped.");
      const answer = parseTalkAnswer(run.value);
      const quotes =
        answer?.kind === "answer" ? acceptTalkQuotes(answer.quotes, loaded.thread.messages) : [];
      // One quote that is not in the mail rejects the whole answer (ADR 0064, rule 11).
      if (answer === null || quotes === null) throw new AgentUnavailableError(TALK_REJECTED);
      const atMs = this.now;
      const from = { threadId, atMs };
      const agent = {
        ...from,
        role: "agent" as const,
        quotes,
        runtimeName: runtime.name,
        model,
        threads: 1,
      };
      let reply: Omit<Extract<TalkEntry, { role: "agent" }>, "id">;
      if (answer.kind === "answer") {
        reply = { ...agent, kind: "answer", text: answer.text };
      } else if (answer.kind === "closed") {
        // The person's words are there, since a blank ask is refused; mail cannot ask for this.
        await this.recordClosing(
          turn.ticket,
          threadId,
          lastMessageKey,
          answer.reason,
          clean(loaded.thread.subject).slice(0, 200),
          words,
        );
        reply = { ...agent, kind: "closed", text: answer.reason };
      } else {
        await this.storePrepared(turn.ticket, threadId, lastMessageKey, workOf(answer));
        reply = { ...agent, kind: answer.kind === "draft" ? "draft" : "question", text: "" };
      }
      const entries = await this.stored(turn.ticket, () =>
        insights.appendTalk([{ ...from, role: "you", text: words }, reply]),
      );
      this.deps.onChanged();
      return { entries };
    } finally {
      // What was sent is counted whether or not it worked: counts only, no text.
      await insights.appendLedger([
        {
          atMs: this.now,
          runtimeId: runtime.id,
          accountId,
          purpose: "talk",
          threads: 1,
          ...withEffort(effort),
        },
      ]);
    }
  }

  // --- A prompt is a filter (ADR 0116) ---

  promptCount(query: string): Promise<PromptCount> {
    return this.prompts.count(query);
  }

  promptVerdicts(query: string): Promise<PromptList> {
    return this.prompts.verdicts(query);
  }

  promptBadge(query: string): Promise<PromptBadge> {
    return this.prompts.badge(query);
  }

  async promptRun(query: string, again?: boolean, readAll?: boolean): Promise<PromptRunResult> {
    try {
      return await this.prompts.run(query, again === true, readAll === true);
    } finally {
      // What the run left unread of a saved view is read on in the background (ADR 0117, rule 3),
      // at once, also after a run that was stopped or refused: the person just asked, and the line
      // must not stand on a count that waits.
      this.startNow();
    }
  }

  async promptStop(): Promise<void> {
    this.prompts.stop();
  }

  /**
   * ADR 0117, rule 3a: the reading in the background as a window shows it. No model; the counts
   * are the ones last computed unless `fresh`. Why nothing reads comes from the gates the last pass
   * met and the state of the runtime, never from a guess.
   */
  async readingStatus(fresh = false): Promise<ReadingStatus> {
    const s = await this.currentSettings();
    const runtime = this.runtimeFor("understand", s);
    const paused = s.readingPaused === true;
    if (!s.enabled || runtime === NO_RUNTIME) return { ai: "off", runtime: "", paused, views: [] };
    const base = { ai: "on" as const, runtime: runtime.name, paused };
    // Consent is read as it is now: the progress says it only once a pass has looked.
    if ((await consentedAccounts(this.deps, runtime.id)).size === 0) {
      return { ...base, wait: { kind: "consent" }, views: [] };
    }
    const wait = this.waitOf();
    const views = (await this.prompts.readingViews(fresh)) ?? [];
    if (views.some((v) => v.state === "reading")) return { ...base, views };
    // A view with threads left and no reason of its own waits for the pass the runtime's state
    // holds back, or for the next pass: one that is due, or one this read starts, so "soon" holds.
    const pending = this.cancelKick !== null || this.pass !== null;
    const own = wait ?? (pending ? ({ kind: "soon" } as const) : undefined);
    let started = false;
    const shown = views.map((v) => {
      if (v.state !== "waiting") return v;
      // The runtime's state or the person's pause comes before what the last pass met.
      const why = wait ?? v.wait ?? own;
      if (why !== undefined) return { ...v, wait: why };
      started = true;
      return { ...v, wait: { kind: "soon" } as const };
    });
    if (started && !paused) this.kick();
    const first = shown.find((v) => v.state === "waiting")?.wait;
    return { ...base, ...(first === undefined ? {} : { wait: first }), views: shown };
  }

  /** Why the reading in the background does not read, from its progress; none while it can. */
  private waitOf(): ReadingWait | undefined {
    const { state, reason, untilMs, problem } = this.progress;
    const until = untilMs === undefined ? {} : { untilMs };
    switch (state) {
      case "checking":
        return { kind: "checking" };
      case "paused":
        if (reason === "pausedByPerson") return { kind: "pausedByPerson" };
        if (reason === "limit") return { kind: "limit", ...until };
        if (reason === "signedOut" || reason === "notPlan") return { kind: reason };
        if (
          reason === "sessionLimit" ||
          reason === "weekLimit" ||
          reason === "overage" ||
          reason === "budget"
        ) {
          return { kind: "plan", reason, ...until };
        }
        return { kind: "pausedByPerson" };
      case "off":
        // Consent is read as it stands by the caller.
        if (reason === "signedOut") return { kind: "signedOut" };
        if (reason === "runtime")
          return { kind: "runtime", ...(problem === undefined ? {} : { problem }) };
        if (reason === "keyOff") return { kind: "keyOff" };
        return undefined;
      default:
        // The person's pause holds even while the progress says nothing of it.
        return this.readingPaused ? { kind: "pausedByPerson" } : undefined;
    }
  }

  // --- The talk across all mail (ADR 0064, rule 7) ---

  async talkAllEntries(talkId?: number, beforeId?: number): Promise<readonly TalkEntry[]> {
    return readTalkAll(this.readDeps(), talkId, beforeId);
  }

  async talks(): Promise<readonly TalkSummary[]> {
    return readTalks(this.readDeps());
  }

  async renameTalk(talkId: number, title: string): Promise<void> {
    if (!Number.isSafeInteger(talkId) || typeof title !== "string") return;
    await this.deps.insights.nameTalk(talkId, title.slice(0, MAX_GUIDANCE_CHARS), "person");
    this.deps.onChanged();
  }

  async deleteTalk(talkId: number): Promise<void> {
    if (!Number.isSafeInteger(talkId)) return;
    // A turn running in it is stopped first, so its answer never lands in a talk that is gone.
    if (this.talkingAllIn === talkId) await this.stopTalkAllAndWait();
    await this.deps.insights.deleteTalk(talkId);
    this.titleTries.delete(talkId);
    this.deps.onChanged();
  }

  async deleteAllTalks(): Promise<number> {
    await this.stopTalkAllAndWait();
    const n = await this.deps.insights.deleteAllTalks();
    this.titleTries.clear();
    this.deps.onChanged();
    return n;
  }

  /** Stops the running turn across all mail and waits until it has let go. */
  private async stopTalkAllAndWait(): Promise<void> {
    const running = this.talkingAllDone;
    if (running === null) return;
    this.talkingAll?.abort();
    await running.catch(() => {});
  }

  async talkAllStop(): Promise<void> {
    this.talkingAll?.abort();
  }

  async talkAll(words: string, talkId?: number | null, choice?: TalkChoice): Promise<TalkResult> {
    // A call refused because a turn is running must not stand for that turn.
    const busy = this.talkingAll !== null;
    const running = this.talkAllOnce(words, talkId ?? null, choice);
    if (!busy) this.talkingAllDone = running;
    try {
      return await running;
    } finally {
      if (this.talkingAllDone === running) this.talkingAllDone = null;
    }
  }

  private async talkAllOnce(
    words: string,
    talkId: number | null,
    choice: TalkChoice | undefined,
  ): Promise<TalkResult> {
    const typed = words.trim().slice(0, MAX_GUIDANCE_CHARS);
    if (typed === "") throw new InvalidAgentSettingError("Write something to ask first.");
    if (this.talkingAll !== null) {
      throw new AgentUnavailableError(
        "The assistant is still working on a question about all mail.",
      );
    }
    // Taken before the first wait, so a second call cannot slip in during the gates.
    const mine = new AbortController();
    this.talkingAll = mine;
    let ticket = this.runtimeKeys.ticket("");
    try {
      const s = await this.currentSettings();
      if (!s.enabled) throw new AgentUnavailableError(NOT_READY);
      // Questions run on the runtime for questions, or on the one chosen in this talk (ADR 0121,
      // rules 1 and 8), with the accounts that agreed to it (rule 4).
      const { runtime } = this.talkOn("answer", s, choice);
      // The turn is taken before the gates, which are decided for its key (ADR 0141, rule 5).
      const turn = this.turnOf("answer", runtime.id);
      ticket = turn.ticket;
      if ((await consentedAccounts(this.deps, runtime.id)).size === 0) {
        throw new AgentUnavailableError(noAccount(runtime));
      }
      await this.gateRuntime(runtime, s, ticket);
      // Once the runtime is looked at, its model is checked against what it lists now.
      const { model } = this.talkOn("answer", s, choice);
      // The talk it is asked in; one that is gone, or none, is started now (ADR 0086).
      const known = talkId === null ? null : await this.deps.insights.getTalk(talkId);
      const talk = known ?? (await this.deps.insights.createTalk(this.now));
      this.talkingAllIn = talk.id;
      const result = await this.talkAllNow(typed, s, mine.signal, talk.id, runtime, model, turn);
      const named = await this.deps.insights.getTalk(talk.id);
      if (named !== null) void this.nameTalkSoon(named);
      return { ...result, talkId: talk.id };
    } catch (error) {
      if (mine.signal.aborted) throw new AgentUnavailableError("Stopped.");
      throw this.askFailure(error, TALK_FAILED, ticket);
    } finally {
      this.talkingAll = null;
      this.talkingAllIn = null;
    }
  }

  /**
   * Names a talk after an answer (ADR 0086, rules 6 and 7): one `P3` turn on the model for titles,
   * with the person's first questions of that talk only. Twice at most per talk in a run of the
   * app, never for a talk the model or the person already named, never while titles are off.
   * Everything that goes wrong leaves the first question as the name. Never awaited by a turn.
   */
  private async nameTalkSoon(talk: TalkSummary): Promise<void> {
    if (talk.titleBy !== undefined) return;
    const tries = this.titleTries.get(talk.id) ?? 0;
    if (tries >= MAX_TITLE_TRIES) return;
    try {
      // Background work: the ticket of the key is taken before the settings it decides from are
      // read, so the reading switch it reads is that key's (ADR 0141, rule 6).
      const runtime = this.runtimeFor("titles", await this.deps.settings.get());
      if (runtime === NO_RUNTIME) return;
      const turn = this.turnOf("titles", runtime.id);
      const s = await this.currentSettings();
      if (!s.enabled || s.kindRuntime.titles !== runtime.id) return;
      if (s.models.titles === TITLES_OFF) return;
      // Only on the runtime for titles, ready, and agreed to by some account (ADR 0121, rule 3).
      if (this.infoOf(runtime.id)?.status !== "ready") return;
      if ((await consentedAccounts(this.deps, runtime.id)).size === 0) return;
      // A model for titles the runtime no longer lists names nothing (ADR 0119, rule 4).
      if (!modelListed(this.infoOf(runtime.id), "titles", s.models.titles)) return;
      if (!this.planGate(runtime.id, "P3", s).ok) {
        this.titleTries.set(talk.id, tries + 1);
        return;
      }
      const questions = (
        await this.deps.insights.listTalk(null, MAX_TALK_SHOWN, { talkId: talk.id })
      )
        .flatMap((e) => (e.role === "you" ? [e.text] : []))
        .slice(0, TALK_TITLE_QUESTIONS);
      if (questions.length === 0) return;
      // Sent only while the key holds and its switch was not turned off since; nothing awaits from
      // here to the request.
      if (!this.runtimeKeys.mayGoInBackground(turn.ticket)) return;
      this.titleTries.set(talk.id, tries + 1);
      const model = s.models.titles;
      const run = await runtime.run(
        {
          model,
          ...buildTalkTitleRequest(questions),
          ...withEffort(this.effortOn("titles", s, runtime, model)),
        },
        { signal: turn.signal },
      );
      await this.afterTurn(turn.ticket, run.limits, this.limitsOf(runtime.id, s));
      const title = parseTalkTitleAnswer(run.value);
      if (title === null) return;
      const named = await this.stored(turn.ticket, () =>
        this.deps.insights.nameTalk(talk.id, title, "model"),
      );
      if (named) this.deps.onChanged();
    } catch {
      // The first question stays the name.
    }
  }

  /**
   * One question across all mail (ADR 0064, rule 7; ADR 0080). A plan turn sees only the person's
   * words, today's date and the earlier talk, and writes the trails to follow; the code runs their
   * queries here; follow turns see short summaries of what was found (as data) and choose what to
   * read and where to look next; the answer turn reads the chosen threads in full. Mail never
   * reaches the plan turn, so it cannot choose where to look first. Only an answer the code
   * accepts is kept (rule 11).
   */
  private async talkAllNow(
    words: string,
    s: AgentSettings,
    stop: AbortSignal,
    talkId: number,
    runtime: AgentRuntime,
    answerModel: string,
    turn: Turn,
  ): Promise<TalkResult> {
    const { insights, settings } = this.deps;
    const startedAt = performance.now();
    // Every turn of a question runs on its runtime (ADR 0121, rule 1): the plan and follow turns
    // on the model that runtime keeps for reading, the loop on the one it keeps for writing, the
    // answer on the model of the question.
    const modelOf = (kind: "understand" | "write") =>
      this.modelFor(kind, s, runtime, () => answerModel);
    const info = this.infoOf(runtime.id);
    // The loop of ADR 0083 when the person turned it on and the model for writing can use tools
    // (ADR 0119, rule 10); else the turns without tools.
    const loop =
      s.talkLoop === true &&
      modelUsesTools({ ...info, tools: runtime.runWithTools !== undefined }, modelOf("write"))
        ? runtime.runWithTools
        : undefined;
    const cap = loop === undefined ? TALK_TIME_CAP_MS : TALK_LOOP_TIME_CAP_MS;
    const over = () => performance.now() - startedAt > cap;
    const signal = AbortSignal.any([turn.signal, stop, AbortSignal.timeout(cap)]);
    const check = () => {
      if (stop.aborted) throw new AgentUnavailableError("Stopped.");
    };
    const consented = await consentedAccounts(this.deps, runtime.id);
    // Only this talk: another talk is never sent with a turn, nor its carried state (ADR 0086).
    const history = await insights.listTalk(null, MAX_TALK_SHOWN, { talkId });
    const carry = [...history]
      .reverse()
      .flatMap((e) => (e.role === "agent" && e.carry !== undefined ? [e.carry] : []))[0];
    const accounts = await this.deps.accounts.list();
    const nothing = async (
      query: string,
      carryOver?: TalkCarry,
      model: string = modelOf("understand"),
      used?: TalkLoopUse,
    ): Promise<TalkResult> => {
      const atMs = this.now;
      const entries = await this.stored(turn.ticket, () =>
        insights.appendTalk([
          { threadId: null, talkId, atMs, role: "you", text: words },
          {
            threadId: null,
            talkId,
            atMs,
            role: "agent",
            kind: "found",
            text: NOTHING_FOUND,
            quotes: [],
            runtimeName: runtime.name,
            model,
            threads: 0,
            query,
            hits: [],
            ...(carryOver === undefined ? {} : { carry: carryOver }),
            ...(used === undefined ? {} : { loop: used }),
          },
        ]),
      );
      this.deps.onChanged();
      return { entries };
    };
    const efforts = {
      understand: this.effortOn("understand", s, runtime, modelOf("understand")),
      write: this.effortOn("write", s, runtime, modelOf("write")),
      answer: this.effortOn("answer", s, runtime, answerModel),
    };
    /** One turn of the understanding model: counted against the plan, stopped by Stop. */
    const understand = async (request: AgentRequestBody): Promise<unknown> => {
      const before = this.limitsOf(runtime.id, await settings.get());
      this.goes(turn);
      const run = await runtime.run(
        { model: modelOf("understand"), ...request, ...withEffort(efforts.understand) },
        { signal },
      );
      await this.afterTurn(turn.ticket, run.limits, before);
      check();
      return run.value;
    };

    /** ADR 0080: a plan turn without mail, then the trail by code with follow turns on summaries. */
    const runTrail = async (): Promise<Found> => {
      // 1. The plan turn: the person's words, the earlier talk and today's date, no mail.
      const plan = parseTalkPlan(
        await understand(buildTalkPlanRequest(history, words, this.now, carry)),
      );
      if (plan === null) throw new AgentUnavailableError(TALK_REJECTED);

      // 2. The trail, here, by code: rounds of queries and follow turns on summaries.
      const trail = await followTrail(
        {
          store: this.deps.store,
          index: this.deps.index,
          bodies: this.deps.bodies,
          visibleText: this.deps.visibleText,
          nowMs: this.now,
          words,
          consented,
          accounts: accounts.map((a) => ({
            id: a.id,
            address: a.address,
            displayName: a.displayName,
          })),
          rules: await insights.listRules(),
          olderThanDays: plan.olderThanDays,
          carry,
          follow: understand,
          sent: (perAccount) => this.recordTalkSent(runtime.id, perAccount, efforts.understand),
          step: (step) =>
            step.kind === "search"
              ? this.deps.onTalkStep?.(step.query, step.threads, "search")
              : this.deps.onTalkStep?.("", step.threads, "follow", step.note),
          check,
          over,
        },
        plan,
      );
      return { ...trail, nothing: trail.nothingRan || trail.threadIds.length === 0 };
    };

    /**
     * ADR 0083: one turn with two read-only tools of ours. The model searches, opens threads and
     * searches again; the tool server writes the steps the person sees as the calls run, and the
     * model's own lines are shown apart, as its notes.
     */
    const runLoop = async (withTools: NonNullable<typeof runtime.runWithTools>): Promise<Found> => {
      const tools = await openMailTools({
        store: this.deps.store,
        index: this.deps.index,
        bodies: this.deps.bodies,
        visibleText: this.deps.visibleText,
        nowMs: this.now,
        consented,
        accounts: accounts.map((a) => ({
          id: a.id,
          address: a.address,
          displayName: a.displayName,
        })),
        rules: await insights.listRules(),
        olderThanDays: undefined,
        carry: undefined,
        // A question about a whole history counts old mail as much as new; the model has after: and before:.
        time: "any",
        ...(this.deps.readFile === undefined ? {} : { readFile: this.deps.readFile }),
        // What goes whole is what the answer's model takes (ADR 0090; ADR 0119, rule 10).
        ...(this.deps.wholeFile !== undefined
          ? {
              wholeFiles: wholeTypesFor(info, runtime.takesFiles === true, answerModel),
            }
          : {}),
        listViews: () => this.deps.views?.list() ?? Promise.resolve([]),
        step: (step) => {
          switch (step.kind) {
            case "search":
              return this.deps.onTalkStep?.(step.query, step.threads, "search");
            case "count":
              return this.deps.onTalkStep?.(step.query, step.matches, "count", step.text);
            case "look":
              return this.deps.onTalkStep?.("", 0, "look", step.text);
            default:
              return this.deps.onTalkStep?.("", 1, "read", step.text);
          }
        },
      });
      try {
        const before = this.limitsOf(runtime.id, await settings.get());
        this.goes(turn);
        let run: AgentRunResult;
        try {
          run = await withTools.call(
            runtime,
            {
              model: modelOf("write"),
              ...buildTalkLoopRequest(history, words, this.now),
              ...withEffort(efforts.write),
            },
            {
              signal,
              server: tools.server,
              timeoutMs: TALK_LOOP_TIME_MS,
              onEvent: (event) => {
                if (event.kind !== "text") return;
                // A note must not pass for a fact: a leading "Searched" or "Read" is taken off.
                const line = clean(event.text)
                  .replace(/\s+/g, " ")
                  .trim()
                  .replace(/^(?:searched|read)\b[\s:—-]*/i, "");
                if (line === "") return;
                const note =
                  line.length > MAX_LOOP_NOTE_CHARS
                    ? `${line.slice(0, MAX_LOOP_NOTE_CHARS - 1)}…`
                    : line;
                this.deps.onTalkStep?.("", 0, "note", note);
              },
            },
          );
        } catch (error) {
          // A loop that ends badly (its time, no result, the program ending) does not fail the
          // question when it has read threads: the answer turn goes on with them. Stop stays a stop.
          const { opened, queries } = tools.state;
          if (stop.aborted || signal.aborted || opened.length === 0) throw error;
          return {
            threadIds: opened.slice(0, MAX_TALK_THREADS),
            queries,
            firstQuery: queries[0] ?? "",
            hypothesis: "",
            nothing: false,
            loop: loopUse(tools.state),
            files: tools.state.files,
            facts: tools.state.facts,
          };
        }
        await this.afterTurn(turn.ticket, run.limits, before);
        check();
        const answer = parseTalkLoop(run.value);
        const { listed, opened, queries } = tools.state;
        // The threads it named; numbers no search gave are ignored. None left: the ones it opened,
        // unless it said that nothing answers (an empty list), and an unreadable result.
        const named = (answer?.threads ?? []).flatMap((n) => listed.get(n) ?? []);
        const chosen =
          answer !== null && answer.threads.length === 0 ? [] : named.length > 0 ? named : opened;
        const threadIds = [...new Set(chosen)].slice(0, MAX_TALK_THREADS);
        // What it offers, each checked by the rule of its kind and counted by code (ADR 0102).
        const offers = await this.acceptOffersOf(answer?.offers, consented, accounts);
        return {
          threadIds,
          queries,
          firstQuery: queries[0] ?? "",
          hypothesis: answer?.hypothesis ?? "",
          nothing: queries.length === 0 || threadIds.length === 0,
          loop: loopUse(tools.state),
          files: tools.state.files,
          facts: tools.state.facts,
          ...(offers.length === 0 ? {} : { offers }),
        };
      } finally {
        await tools.close();
        // What the tools returned left this machine, counted whether or not the turn worked (rule
        // 10). A line that cannot be written does not hide the error of the turn.
        await this.recordTalkSent(runtime.id, tools.state.sent, efforts.write).catch(
          (error: unknown) =>
            this.deps.onError?.(
              `the ledger of a talk could not be written: ${error instanceof Error ? error.message : "failed"}`,
            ),
        );
      }
    };

    const trail = loop === undefined ? await runTrail() : await runLoop(loop);
    const offers = trail.offers ?? [];
    const facts = trail.facts ?? [];
    const kept = {
      ...(offers.length === 0 ? {} : { offers }),
      ...(facts.length === 0 ? {} : { facts }),
    };
    /**
     * Offers and nothing to answer from, or an answer the code did not accept: no "nothing found",
     * and the offers are not lost. The code writes one fixed sentence (ADR 0102).
     */
    const offersOnly = async (): Promise<TalkResult> => {
      const atMs = this.now;
      const entries = await this.stored(turn.ticket, () =>
        insights.appendTalk([
          { threadId: null, talkId, atMs, role: "you", text: words },
          {
            threadId: null,
            talkId,
            atMs,
            role: "agent",
            kind: "found",
            text: OFFERS_ONLY,
            quotes: [],
            runtimeName: runtime.name,
            model: modelOf("write"),
            threads: 0,
            query: trail.firstQuery,
            hits: [],
            carry: {
              hypothesis: trail.hypothesis,
              threadIds: [],
              queries: trail.queries.slice(0, MAX_CARRY_QUERIES),
            },
            ...(trail.loop === undefined ? {} : { loop: trail.loop }),
            ...kept,
          },
        ]),
      );
      this.deps.onChanged();
      return { entries };
    };

    // 3. The answer turn.
    const loaded = [];
    for (const id of trail.nothing ? [] : trail.threadIds) {
      const one = await this.loadThread(id, consented);
      // The files the loop read go with their thread, inside its share (ADR 0087, rule 9).
      if (one !== null) {
        const read = (trail.files ?? []).filter((f) => f.threadId === id);
        // Before the files go whole, a file with no text is listed with no text (ADR 0090).
        const listed = read.map((r) => ({ messageKey: r.messageKey, name: r.name, text: r.text }));
        loaded.push({
          ...one,
          base: one.thread,
          read,
          thread: withFiles(one.thread, listed),
          threadId: id,
        });
      }
    }
    // Counts are something to answer from, with no thread at all (ADR 0102).
    if (loaded.length === 0 && facts.length === 0) {
      if (offers.length > 0) return offersOnly();
      return trail.nothing
        ? nothing(
            trail.firstQuery,
            undefined,
            loop === undefined ? undefined : modelOf("write"),
            trail.loop,
          )
        : nothing(trail.firstQuery, undefined, undefined, trail.loop);
    }
    const standing = { list: await insights.listInstructions(), threadId: "" };
    const build = (threads: readonly PromptThread[]) =>
      buildTalkAllRequest(threads, this.now, history, words, standing, trail.queries, {
        offers,
        facts,
        ...withInput(inputCharsFor(info, answerModel)),
      });
    let built = build(loaded.map((l) => l.thread));
    // Files with no text go whole, only for the threads that went (ADR 0090, rules 2 and 4).
    const whole = await this.attachWhole(loaded, built.sent, trail.files ?? []);
    let threadsSent = loaded.map((l) => l.thread);
    if (whole.changed) {
      const again = build(whole.threads);
      // The note of a file is a few characters longer; if that changes what goes, none goes whole.
      if (again.sent.join() === built.sent.join()) {
        built = again;
        threadsSent = whole.threads;
      } else {
        whole.files.length = 0;
      }
    }
    // The threads that went, in the order they were numbered: `[Thread n]` is `sent[n - 1]`.
    const wentIndexes = new Set(built.sent);
    // Quotes are checked against the threads as they went, files and all.
    const sent = loaded.flatMap((l, i) =>
      wentIndexes.has(i) ? [{ ...l, thread: threadsSent[i] ?? l.thread }] : [],
    );
    check();
    if (sent.length > 0) this.deps.onTalkStep?.(trail.firstQuery, sent.length);
    const answerBefore = this.limitsOf(runtime.id, await settings.get());
    // Nothing went yet: a key saved since stops the turn with no line in the ledger.
    this.goes(turn);
    try {
      const run = await runtime.run(
        {
          model: answerModel,
          ...built.request,
          ...withEffort(efforts.answer),
          ...(whole.files.length === 0 ? {} : { files: whole.files }),
        },
        { signal },
      );
      await this.afterTurn(turn.ticket, run.limits, answerBefore);
      check();
      const answer = parseTalkAllAnswer(run.value);
      const accepted =
        answer === null
          ? null
          : acceptTalkAll(
              answer,
              sent.map((l) => l.thread),
            );
      // A thread that was not sent, or a quote that is not in the mail, rejects the whole answer.
      // The offers do not rest on it, so they stay (ADR 0102).
      if (answer === null || accepted === null) {
        if (offers.length > 0) return await offersOnly();
        throw new AgentUnavailableError(TALK_REJECTED);
      }
      const own = new Set(accounts.map((a) => lower(a.address)));
      const hits: TalkHit[] = [];
      const quotes: TalkQuote[] = [];
      for (const item of accepted) {
        const one = sent[item.thread - 1];
        if (one === undefined) continue;
        const view = await this.deps.store.getThread(one.threadId, { visibleOnly: true });
        if (view === null) throw new AgentUnavailableError(TALK_REJECTED);
        hits.push({
          threadId: one.threadId,
          who: whoOf(view.messages, own),
          subject: view.thread.subject,
          note: item.note,
          lastMessageMs: view.messages.at(-1)?.dateMs ?? 0,
        });
        quotes.push(...item.quotes.map((q) => ({ ...q, threadId: one.threadId })));
      }
      const atMs = this.now;
      const entries = await this.stored(turn.ticket, () =>
        insights.appendTalk([
          { threadId: null, talkId, atMs, role: "you", text: words },
          {
            threadId: null,
            talkId,
            atMs,
            role: "agent",
            kind: "found",
            text: answer.text,
            quotes,
            runtimeName: runtime.name,
            model: answerModel,
            threads: sent.length,
            query: trail.firstQuery,
            hits,
            carry: {
              hypothesis: trail.hypothesis,
              threadIds: sent.map((l) => l.threadId).slice(0, MAX_CARRY_THREADS),
              queries: trail.queries.slice(0, MAX_CARRY_QUERIES),
            },
            ...(trail.loop === undefined ? {} : { loop: trail.loop }),
            ...kept,
          },
        ]),
      );
      this.deps.onChanged();
      return { entries };
    } finally {
      // What was sent is counted whether or not it worked: counts per account, no text (rule 10).
      const perAccount = new Map<string, number>();
      for (const l of sent) perAccount.set(l.accountId, (perAccount.get(l.accountId) ?? 0) + 1);
      await this.recordTalkSent(runtime.id, perAccount, efforts.answer);
    }
  }

  /**
   * The offers of the loop that the code stands behind (ADR 0102): each checked by the rule of its
   * kind against the person's views and the addresses they have written to, and counted here, in
   * the accounts agreed to and without the threads the rules cover. A count that fails drops its
   * offer; nothing of this goes to a model.
   */
  private async acceptOffersOf(
    proposed: Parameters<typeof acceptOffers>[0],
    consented: ReadonlySet<string>,
    accounts: readonly { id: string; address: string; displayName: string }[],
  ): Promise<TalkOffer[]> {
    if (proposed === undefined || proposed.length === 0) return [];
    const scope = {
      consented,
      rules: await this.deps.insights.listRules(),
      ownAddresses: accounts.map((a) => a.address),
    };
    const writtenTo = proposed.some((p) => p.kind === "message")
      ? new Set((await this.deps.store.listWrittenTo()).keys())
      : new Set<string>();
    return acceptOffers(proposed, {
      existing: (await this.deps.views?.list()) ?? [],
      nowMs: this.now,
      accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
      writtenTo,
      count: (parsed) =>
        countQuery({ index: this.deps.index, store: this.deps.store }, parsed, scope).catch(
          () => null,
        ),
    });
  }

  /**
   * What the press of a clean-up offer acts on (ADR 0102, rule 7): the query parsed as `count_mail`
   * parses it, matched in the scope its count was made in (the accounts agreed to, without the
   * threads the person's rules cover), up to the cap. Read-only: no text, no model, nothing changes.
   */
  async matchAct(query: string): Promise<ActMatches> {
    const none: ActMatches = { messages: [], capped: false };
    const text = typeof query === "string" ? query.trim() : "";
    if (text === "" || text.length > MAX_TALK_QUERY_CHARS) return none;
    // An offer comes from a question: it counts in the accounts agreed to the runtime for questions.
    const s = await this.deps.settings.get();
    const consented = await consentedAccounts(this.deps, s.kindRuntime.answer);
    if (consented.size === 0) return none;
    const accounts = await this.deps.accounts.list();
    const parsed = parseQuery(text, {
      nowMs: this.now,
      accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
    });
    if (parsed.diagnostics.length > 0 || isEmptyQuery(parsed)) return none;
    const match = await matchQuery({ index: this.deps.index, store: this.deps.store }, parsed, {
      consented,
      rules: await this.deps.insights.listRules(),
      ownAddresses: accounts.map((a) => a.address),
    });
    return actMatches(match);
  }

  /** Lines in the ledger for mail that went to a model in a talk across all mail (rule 10). */
  private async recordTalkSent(
    runtimeId: string,
    perAccount: ReadonlyMap<string, number>,
    effort: AgentEffort | undefined,
  ): Promise<void> {
    await this.deps.insights.appendLedger(
      [...perAccount].map(([accountId, threads]) => ({
        atMs: this.now,
        runtimeId,
        accountId,
        purpose: "talk" as const,
        threads,
        ...withEffort(effort),
      })),
    );
  }

  /** The address of the other person in a thread: who it is about, for a rule for the sender. */
  private async senderOf(threadId: string): Promise<string> {
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    const own = new Set((await this.ownAddresses()).map(lower));
    const other = [...(view?.messages ?? [])]
      .reverse()
      .find((m) => !own.has(lower(m.from.address)));
    return lower(other?.from.address ?? view?.messages.at(-1)?.to[0]?.address ?? "");
  }

  /**
   * Undo of the latest closing of a thread, from the tray or the journal; `notImportant` and
   * `later` are lines of the journal kept from earlier versions.
   */
  async undoFeedback(threadId: string, kind: "notImportant" | "later" | "closed"): Promise<void> {
    await this.deps.insights.withdrawFeedback(threadId, kind, this.now);
    this.deps.onChanged();
  }

  async addInstruction(input: AddInstructionInput): Promise<AgentInstruction> {
    const scope: unknown = input?.scope;
    if (scope !== "general" && scope !== "understand" && scope !== "write") {
      throw new InvalidAgentSettingError("Choose where the instruction applies.");
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text === "") throw new InvalidAgentSettingError("Write the instruction first.");
    if (text.length > MAX_INSTRUCTION_CHARS) {
      throw new InvalidAgentSettingError(
        `An instruction is at most ${MAX_INSTRUCTION_CHARS} characters.`,
      );
    }
    const active = await this.deps.insights.listInstructions();
    const same = active.find((i) => i.scope === scope && i.text === text);
    if (same !== undefined) return same;
    if (active.filter((i) => i.scope !== "thread").length >= MAX_INSTRUCTIONS) {
      throw new InvalidAgentSettingError(
        `There are already ${MAX_INSTRUCTIONS} instructions. Remove one first.`,
      );
    }
    // No reading is started: new instructions apply to what is read from now on (ADR 0054, rule 10).
    const instruction = await this.deps.insights.addInstruction(
      { scope, text, actor: "person" },
      this.now,
    );
    this.deps.onChanged();
    return instruction;
  }

  async removeInstruction(id: number): Promise<void> {
    if (!Number.isInteger(id) || id < 1) {
      throw new InvalidAgentSettingError("That instruction is not there.");
    }
    await this.deps.insights.removeInstruction(id, this.now);
    this.deps.onChanged();
  }

  /**
   * The turn that keeps what the person typed (ADR 0054, rules 7 to 10). Its request is built from
   * the words alone, so no mail can reach it; if the answer is a rule for a sender, the address
   * comes from the store here, never from the model. It is background work on the plan's allowance
   * (`P1`): when anything refuses, it skips quietly and nothing is retried. It never throws, so it
   * cannot spoil the reply the person is waiting on.
   */
  async remember(threadId: string, words: string): Promise<RememberResult> {
    const none: RememberResult = { items: [] };
    try {
      return await this.rememberNow(threadId, words);
    } catch {
      return none;
    }
  }

  private async rememberNow(threadId: string, words: string): Promise<RememberResult> {
    const none: RememberResult = { items: [] };
    const typed = typeof words === "string" ? words.trim().slice(0, MAX_GUIDANCE_CHARS) : "";
    if (typed === "") return none;
    const { insights } = this.deps;
    // Background work on the runtime for understanding mail, on its model (ADR 0121, rule 1). The
    // ticket of its key is taken before the settings it decides from are read, so the reading
    // switch it reads is that key's (ADR 0141, rule 6).
    const runtime = this.runtimeFor("understand", await this.deps.settings.get());
    if (runtime === NO_RUNTIME) return none;
    const turn = this.turnOf("understand", runtime.id);
    const s = await this.currentSettings();
    if (!s.enabled || s.kindRuntime.understand !== runtime.id) return none;
    if (this.infoOf(runtime.id) === null) await this.inspectRuntime(runtime);
    const info = this.infoOf(runtime.id);
    if (info?.status !== "ready") return none;
    if (!modelListed(info, "understand", s.models.understand)) return none;
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    if (view === null) return none;
    const accountId = view.thread.accountId;
    if (!(await consentedAccounts(this.deps, runtime.id)).has(accountId)) return none;
    if (!this.planGate(runtime.id, "P1", s).ok) return none;

    let answer: ReturnType<typeof parseRememberAnswer> = null;
    // Not a kind of work: it stays at `low`, when the runtime takes it (ADR 0118, rule 6).
    const effort = resolveEffort("low", levelsFor(info, s.models.understand));
    // Sent only while the key holds and its switch was not turned off since; nothing awaits from
    // here to the request.
    if (!this.runtimeKeys.mayGoInBackground(turn.ticket)) return none;
    try {
      const run = await runtime.run(
        { model: s.models.understand, ...buildRememberRequest(typed), ...withEffort(effort) },
        { signal: turn.signal },
      );
      await this.afterTurn(turn.ticket, run.limits, this.limitsOf(runtime.id, s));
      answer = parseRememberAnswer(run.value);
    } catch {
      answer = null;
    } finally {
      // Counted whether or not it worked. No thread's mail went, so no threads.
      await insights.appendLedger([
        {
          atMs: this.now,
          runtimeId: runtime.id,
          accountId,
          purpose: "remember",
          threads: 0,
          ...withEffort(effort),
        },
      ]);
    }
    if (answer === null || answer.items.length === 0) return none;

    // Each item is stored only while the key of the turn holds as it is written, after the reads
    // below (ADR 0141, rule 5); the turn is counted above whether or not.
    const keep = <T>(write: () => Promise<T>) => this.runtimeKeys.keep(turn.ticket, write);
    const items: RememberResult["items"][number][] = [];
    const active = await insights.listInstructions();
    const rules = await insights.listRules();
    let general = active.filter((i) => i.scope !== "thread").length;
    const own = new Set((await this.ownAddresses()).map(lower));
    for (const item of answer.items) {
      if (item.scope === "sender") {
        // The address comes from the store by thread id, never from the model.
        const address = normalizeRuleSubject("sender", otherSenderAddress(view.messages, own));
        if (address === null || own.has(address)) continue;
        if (rules.some((r) => r.scope === "sender" && r.subject === address)) continue;
        const rule = await keep(() =>
          insights.addRule(
            { scope: "sender", subject: address, action: "noReply", actor: "agent", words: typed },
            this.now,
          ),
        );
        if (rule === null) break;
        items.push({ kind: "rule", rule: rule.value });
        continue;
      }
      const text = (item.text ?? "").trim().slice(0, MAX_INSTRUCTION_CHARS);
      if (text === "") continue;
      const here = item.scope === "thread" ? threadId : undefined;
      if (active.some((i) => i.scope === item.scope && i.threadId === here && i.text === text)) {
        continue;
      }
      if (item.scope !== "thread") {
        if (general >= MAX_INSTRUCTIONS) continue;
        general++;
      }
      const scope = item.scope;
      const instruction = await keep(() =>
        insights.addInstruction(
          {
            scope,
            text,
            ...(here === undefined ? {} : { threadId: here }),
            actor: "agent",
            words: typed,
          },
          this.now,
        ),
      );
      if (instruction === null) break;
      items.push({ kind: "instruction", instruction: instruction.value });
    }
    if (items.length > 0) {
      this.deps.onChanged();
      if (items.some((i) => i.kind === "rule")) this.kick();
    }
    return { items };
  }

  async addRule(input: AddRuleInput): Promise<AgentRule> {
    const own = new Set((await this.ownAddresses()).map(lower));
    let subject: string | null;
    let scope: RuleScope = input.scope;
    if ("threadId" in input) {
      // The address comes from the store, never from the page.
      scope = "sender";
      const view = await this.deps.store.getThread(input.threadId, { visibleOnly: true });
      subject = normalizeRuleSubject(scope, otherSenderAddress(view?.messages ?? [], own));
      if (subject === null)
        throw new InvalidAgentSettingError("There is no sender to make a rule for.");
    } else {
      subject = normalizeRuleSubject(scope, input.subject);
      if (subject === null) {
        throw new InvalidAgentSettingError(
          scope === "sender"
            ? "That is not an email address."
            : scope === "domain"
              ? "That is not a domain, such as example.com."
              : scope === "category"
                ? "That is not a kind of mail."
                : "That is not a type of address.",
        );
      }
    }
    if (scope === "sender" && own.has(subject)) {
      throw new InvalidAgentSettingError("That is one of your own addresses.");
    }
    const rule = await this.deps.insights.addRule(
      { scope, subject, action: "noReply", actor: "person" },
      this.now,
    );
    this.deps.onChanged();
    this.kick();
    return rule;
  }

  async removeRule(id: number): Promise<void> {
    if (!Number.isInteger(id) || id < 1)
      throw new InvalidAgentSettingError("That rule is not there.");
    await this.deps.insights.removeRule(id, this.now);
    this.deps.onChanged();
    this.kick();
  }

  async draftFromPrepared(
    threadId: string,
    body: string,
  ): Promise<{ draftId: string; existing: boolean }> {
    if (typeof body !== "string" || body.trim() === "" || body.length > MAX_DRAFT_CHARS) {
      throw new InvalidAgentSettingError("The reply is empty or too long.");
    }
    // The words are all the agent's, so every signature block in them goes (ADR 0142, rule 6). A
    // body that was only a block is empty once cut, and makes no draft, as a helper's answer that
    // is empty once kept is refused. A `>` line the model wrote (a line it answers) stays in the
    // reply's own part: the quote is only the app's, under the signature (rule 4).
    const words = withoutSignature(body.replace(/\r\n?/g, "\n"));
    if (words.trim() === "") throw new InvalidAgentSettingError("The reply is empty or too long.");
    // The reply rules of the composer (ADR 0020, 0042) decide who it goes to and what it quotes.
    const prepared = await prepareReplyDraft(
      {
        accounts: this.deps.accounts,
        store: this.deps.store,
        bodies: this.deps.bodies,
        drafts: this.deps.drafts,
      },
      threadId,
      "reply",
    );
    if (prepared === null) throw new ThingNotFoundError("There is no message to reply to");
    // A draft the person already started is theirs: the composer opens it, nothing is overwritten.
    if (prepared.existing !== null) return { draftId: prepared.existing.id, existing: true };
    // The agent's words above the account's signature and the quote, as the composer starts a
    // reply.
    const start = splitDraft(prepared.content.bodyMarkdown);
    const joined = joinDraft(words, start.quote, start.signature);
    const draft = await this.deps.saveDraft({
      ...prepared.content,
      bodyMarkdown: start.quote === "" && start.signature === "" ? `${joined}\n` : joined,
    });
    return { draftId: draft.id, existing: false };
  }
}

/** What the person is told when a reply helper's answer is not used. */
function helpRefused(reason: HelpRefusal): string {
  switch (reason) {
    case "gaps":
      return "The assistant's answer lost a gap in [brackets], so it was not used. Try again.";
    case "quote":
      return "The assistant's answer changed the quoted mail, so it was not used. Try again.";
    case "dropped":
      return "The assistant's answer left out part of your reply, so it was not used. Try again.";
    case "subject":
      return "The assistant's answer put the subject in the text, so it was not used. Try again.";
    case "shape":
      return "The assistant's answer could not be used. Try again.";
  }
}

/** The thread help is for; empty for a new message, which has none (ADR 0132). */
function threadOf(about: DraftFor): string {
  return "threadId" in about ? about.threadId : "";
}

/** The prepared work a draft or a question answer stands for. */
function workOf(answer: Exclude<PreparedAnswer, { kind: "closed" }>): PreparedWork {
  return answer.kind === "draft"
    ? { kind: "draft", body: answer.body, nudge: answer.nudge }
    : { kind: "needs", missing: answer.missing, directions: answer.directions };
}
