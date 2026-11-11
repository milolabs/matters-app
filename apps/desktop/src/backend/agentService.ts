// Agents in the sync worker (ADR 0051, rule 10). Everything here is injected, so a test
// runs it over `FakeAgentRuntime` and the in-memory stores. Nothing logs mail text, subjects or
// addresses: errors carry fixed sentences only.
import type {
  AccountStorePort,
  ActMatches,
  AddInstructionInput,
  AddRuleInput,
  AgentConsent,
  AgentEffort,
  AgentEfforts,
  AgentFile,
  AgentInsightStorePort,
  AgentInstruction,
  AgentModels,
  AgentRequestBody,
  AgentRule,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentSettings,
  AgentSettingsPort,
  AgentStatus,
  AgentWorkKind,
  ClockPort,
  Draft,
  DraftContent,
  DraftStorePort,
  FileTextAnswer,
  GapSuggestion,
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
  RememberResult,
  ReplyCheck,
  RewriteHow,
  RuleScope,
  SavedViewStorePort,
  SearchIndexPort,
  TalkCarry,
  TalkEntry,
  TalkFact,
  TalkHit,
  TalkLoopUse,
  TalkOffer,
  TalkQuote,
  TalkResult,
  TalkSummary,
  ThreadAgentView,
  WholeFileAnswer,
} from "@matters/core";
import {
  AGENT_WORK_KINDS,
  acceptAnswers,
  acceptCheck,
  acceptFills,
  acceptOffers,
  acceptRewrite,
  acceptTalkAll,
  acceptTalkQuotes,
  acceptVerdicts,
  actMatches,
  addNeedsYouView,
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
  clean,
  countQuery,
  type DraftParts,
  draftGaps,
  effortFor,
  type HelpRefusal,
  isAgentEffortSetting,
  isAgentRunError,
  isAutomatedSender,
  isEmptyQuery,
  joinDraft,
  lastFromThem,
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
  matchQuery,
  mayRun,
  normalizeRuleSubject,
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
  prepareReplyDraft,
  REWRITE_HOWS,
  resolveEffort,
  splitDraft,
  TALK_LOOP_TIME_CAP_MS,
  TALK_LOOP_TIME_MS,
  TALK_TIME_CAP_MS,
  TALK_TITLE_QUESTIONS,
  TITLES_OFF,
  wholeFilesProblem,
  withEffort,
  withFiles,
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
import { PromptService } from "./promptService.ts";
import { followTrail, type TrailResult } from "./talkTrail.ts";

/** Threads with activity in this many days are read before older ones (`P1`, else `P3`). */
export const RECENT_DAYS = 2;
export const KICK_DEBOUNCE_MS = 2000;
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

export interface AgentServiceDeps {
  readonly runtime: Pick<
    AgentRuntimePort,
    "id" | "name" | "inspect" | "run" | "runWithTools" | "takesFiles"
  >;
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
const USED_UP = "Your plan's allowance is used up for now. Try again when it resets.";
const TALK_FAILED = "The assistant could not answer this. Try again.";
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

export class AgentService implements AgentApi {
  private readonly deps: AgentServiceDeps;
  private info: AgentRuntimeInfo | null = null;
  private progress: ReadingProgress = { state: "off", reason: "disabled" };
  private pass: Promise<void> | null = null;
  private again = false;
  private blocked: "signedOut" | "notPlan" | null = null;
  private cancelKick: (() => void) | null = null;
  private abort = new AbortController();
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
  /** The test and the inspection must not run twice at once. */
  private testing: Promise<AgentRuntimeInfo> | null = null;

  /** A prompt is a filter (ADR 0116): its turns, behind the same gates as every turn here. */
  private readonly prompts: PromptService;

  constructor(deps: AgentServiceDeps) {
    this.deps = deps;
    this.prompts = new PromptService({
      runtime: deps.runtime,
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
      gateRuntime: (s) => this.gateRuntime(s),
      loadThread: (threadId, consented) => this.loadThread(threadId, consented),
      noteRun: (limits, before) => this.noteRun(limits, before),
      effortOf: (kind, s) => this.effortOf(kind, s),
      askFailure: (error, fallback) => this.askFailure(error, fallback),
      stopAll: () => this.abort.signal,
      onProgress: (progress) => deps.onPromptProgress?.(progress),
    });
  }

  private get now(): number {
    return this.deps.clock.now();
  }

  /** The effort a turn on the model of `kind` sends, or none (ADR 0118, rules 1 and 4). */
  private effortOf(kind: AgentWorkKind, s: AgentSettings): AgentEffort | undefined {
    return effortFor(kind, s, this.info?.efforts);
  }

  // --- Starting and stopping ---

  /**
   * Looks at the runtime and starts the reading in the background, when the person has already
   * turned AI on. With AI off nothing is started on this machine: the program is not even asked
   * who is signed in.
   */
  async start(): Promise<void> {
    const settings = await this.deps.settings.get();
    this.readingPaused = settings.readingPaused === true;
    if (!settings.enabled) return;
    await this.addStarterView();
    this.setProgress({ state: "checking" });
    await this.inspectRuntime();
    // A pause the person made before the restart still holds: the pass only says so.
    if (this.readingPaused) this.runPass();
    else this.kick();
  }

  /** Stops timers and any run in flight, and waits for the pass to end. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelKick?.();
    this.cancelKick = null;
    this.abort.abort();
    await this.pass?.catch(() => {});
  }

  // --- Looking at the runtime ---

  /** What the program says now, with what the last test found and the last limits seen. */
  private async inspectRuntime(): Promise<AgentRuntimeInfo> {
    const { runtime, settings } = this.deps;
    let info = await runtime.inspect();
    const record = await settings.getRuntimeRecord(runtime.id);
    if (info.status === "found" && record !== null && record.plan === info.plan) {
      // The same plan passed the test before: the program is not asked to prove it again.
      info =
        record.status === "ready"
          ? { ...info, status: "ready" }
          : {
              ...info,
              status: "failed",
              problem: record.problem ?? "The last check of the assistant failed.",
            };
    }
    const limits = (await settings.get()).limits;
    this.info = limits !== undefined && info.limits === undefined ? { ...info, limits } : info;
    if (info.status === "signedOut") this.blocked = this.blocked ?? "signedOut";
    else this.blocked = null;
    return this.info;
  }

  async inspect(): Promise<AgentStatus> {
    const wasWaiting = this.waitingOnRuntime();
    await this.inspectRuntime();
    // The person signed in outside the app and asked us to look again: the reading goes on by
    // itself. Looking never starts a login.
    if (wasWaiting && this.info?.status !== "signedOut" && this.info?.status !== "missing") {
      this.blocked = null;
      this.startNow();
    } else if (wasWaiting) {
      this.setProgress(this.offProgress());
    }
    this.deps.onChanged();
    return this.status();
  }

  /** Reading stopped because the program is missing, signed out or off the plan. */
  private waitingOnRuntime(): boolean {
    const { state, reason } = this.progress;
    return (
      (state === "off" && (reason === "signedOut" || reason === "runtime")) ||
      (state === "paused" && (reason === "signedOut" || reason === "notPlan"))
    );
  }

  /** The state for a runtime that cannot be used, with the sentence the person can act on. */
  private offProgress(): ReadingProgress {
    const status = this.info?.status;
    const problem = this.info?.problem;
    return {
      state: "off",
      reason: status === "signedOut" ? "signedOut" : "runtime",
      ...(problem === undefined ? {} : { problem }),
    };
  }

  /**
   * ADR 0051, rule 5: one made-up message through `run`, in the verdict turn of a prompt (ADR
   * 0116). The runtime is `ready` only when the answer parses against its schema, names the thread
   * that was sent, and its quote is found in the message. Never mail.
   */
  async testRuntime(): Promise<AgentStatus> {
    const wasOff = this.progress.state === "off" || this.waitingOnRuntime();
    if (wasOff) this.setProgress({ state: "checking" });
    this.testing ??= this.runTest().finally(() => {
      this.testing = null;
    });
    await this.testing;
    if (wasOff) {
      if (this.info?.status === "ready") this.startNow();
      else this.setProgress(this.offProgress());
    }
    this.deps.onChanged();
    return this.status();
  }

  private async runTest(): Promise<AgentRuntimeInfo> {
    const { runtime, settings, clock } = this.deps;
    const info = await this.inspectRuntime();
    if (info.status !== "found" && info.status !== "ready" && info.status !== "failed") return info;
    this.blocked = null;
    const settingsNow = await settings.get();
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
    const model = settingsNow.models.understand;
    let status: AgentRuntimeInfo["status"] = "failed";
    let problem: string | undefined;
    try {
      // Not a kind of work: the test stays at `low`, when the runtime takes it (ADR 0118, rule 6).
      const run = await runtime.run(
        { model, ...request, ...withEffort(resolveEffort("low", info.efforts)) },
        { signal: this.abort.signal },
      );
      await this.noteRun(run.limits);
      const verdicts = acceptVerdicts(
        run.value,
        [{ threadId: "test", lastMessageKey: 1, thread: TEST_THREAD }],
        { promptKey: "test", version: PROMPT_VERSION, atMs: clock.now() },
      );
      // A quote that was found proves the answer is in the shape and is held to the text.
      if (verdicts?.some((v) => v.quote !== undefined) === true) status = "ready";
      else problem = "The assistant answered, but not in the form the app needs.";
    } catch (error) {
      if (isAgentRunError(error) && (error.code === "notSignedIn" || error.code === "notPlan")) {
        this.blocked = error.code === "notPlan" ? "notPlan" : "signedOut";
        this.info = {
          ...info,
          status: "signedOut",
          problem:
            error.code === "notPlan"
              ? "The assistant is not using your Claude plan."
              : "Not signed in. Sign in with the assistant's own program, then check again.",
        };
        return this.info;
      }
      problem = "The check of the assistant did not finish.";
    }
    await settings.putRuntimeRecord({
      runtimeId: runtime.id,
      status: status === "ready" ? "ready" : "failed",
      ...(info.plan === undefined ? {} : { plan: info.plan }),
      ...(problem === undefined ? {} : { problem }),
      testedAtMs: clock.now(),
    });
    const limits = (await settings.get()).limits;
    const { problem: _old, ...rest } = info;
    this.info = {
      ...rest,
      status,
      ...(problem === undefined ? {} : { problem }),
      ...(limits === undefined ? {} : { limits }),
    };
    return this.info;
  }

  // --- Budget bookkeeping ---

  /**
   * Keeps the last plan windows we saw. Our share of the week starts again when the week does
   * (ADR 0051, rule 7): a different reset time, or a reset that has passed.
   */
  private async noteRun(limits: PlanLimits | undefined, before?: PlanLimits): Promise<void> {
    if (limits === undefined) return;
    const { settings } = this.deps;
    const current = await settings.get();
    let used = current.usedByUsPercent;
    const reset = limits.week?.resetsAtMs;
    if (current.usedWeekResetsAtMs !== undefined && reset !== current.usedWeekResetsAtMs) used = 0;
    const was = before?.week;
    const now = limits.week;
    if (was !== undefined && now !== undefined && was.resetsAtMs === now.resetsAtMs) {
      used += Math.max(0, now.usedPercent - was.usedPercent);
    }
    await settings.update({
      limits,
      usedByUsPercent: used,
      ...(reset === undefined ? {} : { usedWeekResetsAtMs: reset }),
    });
    if (this.info !== null) this.info = { ...this.info, limits };
  }

  /** The week we count in is over: start counting again, before a gate looks at the number. */
  private async currentSettings(): Promise<AgentSettings> {
    const s = await this.deps.settings.get();
    if (s.usedWeekResetsAtMs !== undefined && this.now >= s.usedWeekResetsAtMs) {
      return this.deps.settings.update({ usedByUsPercent: 0, usedWeekResetsAtMs: null });
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
    // Defence in depth: no mail of an account without consent is ever read for a prompt.
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

  // --- Reading in the background (ADR 0117, rule 3) ---

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
    });
  }

  private setProgress(progress: ReadingProgress): void {
    this.progress = progress;
    this.deps.onChanged();
  }

  private pause(reason: "signedOut" | "notPlan"): void {
    const problem = this.info?.problem;
    this.setProgress({ state: "paused", reason, ...(problem === undefined ? {} : { problem }) });
  }

  /**
   * One pass behind the gates of background work: AI on for this runtime, an account with consent,
   * the person's pause, a runtime that is ready (tested by itself once the person agreed). Then
   * the saved views with a prompt read their new mail; they give way to a run the person starts
   * and stop with the person's pause.
   */
  private async passOnce(): Promise<void> {
    const { runtime } = this.deps;
    const first = await this.currentSettings();
    if (!first.enabled || first.runtimeId !== runtime.id) {
      this.setProgress({ state: "off", reason: "disabled" });
      return;
    }
    if ((await consentedAccounts(this.deps, runtime.id)).size === 0) {
      this.setProgress({ state: "off", reason: "consent" });
      return;
    }
    if (this.readingPaused) {
      this.setProgress({ state: "paused", reason: "pausedByPerson" });
      return;
    }
    if (this.blocked !== null) {
      // It waits for the person, not for the clock.
      this.pause(this.blocked);
      return;
    }
    if (this.info === null || this.info.status === "found") this.setProgress({ state: "checking" });
    if (this.info === null) await this.inspectRuntime();
    // The person agreed, so the test with a made-up message may run by itself (ADR 0051, rule 5).
    if (this.info?.status === "found") await this.runTest();
    if (this.info?.status !== "ready") {
      this.setProgress(this.offProgress());
      return;
    }
    try {
      await this.prompts.readInBackground({
        recentDays: RECENT_DAYS,
        stopWhen: () => this.readingPaused || this.stopped,
      });
    } catch (error) {
      this.deps.onError?.(
        `agents: a prompt's reading failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    if (this.stopped || this.abort.signal.aborted) return;
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
    model: string,
    guidance: PreparedGuidance | undefined,
    effort: AgentEffort | undefined,
  ): Promise<PrepareResult> {
    const { runtime, insights, settings } = this.deps;
    const consented = await consentedAccounts(this.deps, runtime.id);
    const loaded = await this.loadThread(threadId, consented);
    if (loaded === null)
      throw new ThingNotFoundError("That thread is not available to the assistant");
    const accountId = loaded.accountId;
    // What is prepared belongs to the thread as it stands now.
    const lastMessageKey = loaded.lastMessageKey;
    const request = buildPreparedRequest(loaded.thread, this.now, guidance, {
      list: await insights.listInstructions(),
      threadId,
    });
    const before = (await settings.get()).limits;
    try {
      const run = await runtime.run(
        { model, ...request, ...withEffort(effort) },
        { signal: this.abort.signal },
      );
      await this.noteRun(run.limits, before);
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
          threadId,
          lastMessageKey,
          answer.reason,
          clean(loaded.thread.subject).slice(0, 200),
          (guidance?.answer ?? "").trim(),
        );
        return { kind: "closed", reason: answer.reason };
      }
      const work = workOf(answer);
      await this.storePrepared(threadId, lastMessageKey, work);
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
   * counted toward a rule for its sender (ADR 0058, rule 4).
   */
  private async recordClosing(
    threadId: string,
    lastMessageKey: number,
    reason: string,
    headline: string,
    words: string,
  ): Promise<void> {
    const senderAddress = await this.senderOf(threadId);
    await this.deps.insights.recordFeedback(
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
    );
    this.deps.onChanged();
  }

  private async storePrepared(
    threadId: string,
    lastMessageKey: number,
    work: PreparedWork,
  ): Promise<void> {
    await this.deps.insights.putPrepared([
      { threadId, lastMessageKey, work, preparedAtMs: this.now },
    ]);
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
    // With AI off the program is not asked who is signed in just because a window wants to know
    // whether AI is on (ADR 0051, refinement 4): the person asks with `inspect`.
    if (this.info === null && settings.enabled) await this.inspectRuntime();
    return {
      settings,
      runtime: this.info,
      consents: consents.filter((c: AgentConsent) => c.runtimeId === this.deps.runtime.id),
      progress: this.progress,
      ledger,
    };
  }

  /**
   * ADR 0117, rule 2: `Needs you` goes in front of the saved views once, the first time AI is on
   * with an account that has consent, and that it went is kept with the agent's settings. A view
   * of that name already there counts as added. A full list adds nothing and keeps no record, so
   * it is added once there is room. Never fails what called it.
   */
  private async addStarterView(): Promise<void> {
    const views = this.deps.starterViews;
    if (views === undefined) return;
    try {
      const s = await this.deps.settings.get();
      if (!s.enabled || s.needsYouAdded === true) return;
      if ((await consentedAccounts(this.deps, this.deps.runtime.id)).size === 0) return;
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
      if (this.progress.state === "paused" && this.progress.reason === "pausedByPerson") {
        this.setProgress({ state: "checking" });
      }
      this.runPass();
    }
    this.deps.onChanged();
    return this.status();
  }

  // --- AgentApi: settings and consent ---

  async setEnabled(input: {
    accountIds: readonly string[];
    runtimeId: string;
  }): Promise<AgentStatus> {
    const { runtime, settings, insights } = this.deps;
    if (input.runtimeId !== runtime.id) {
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
    await settings.update({ enabled: true, runtimeId: runtime.id });
    await insights.appendLedger(lines);
    await this.addStarterView();
    this.blocked = null;
    this.setProgress({ state: "checking" });
    await this.inspectRuntime();
    this.deps.onChanged();
    this.startNow();
    return this.status();
  }

  async disable(): Promise<AgentStatus> {
    const { settings, insights } = this.deps;
    this.cancelKick?.();
    this.cancelKick = null;
    // A run in flight is cut short: nothing more is sent once the person says no.
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

  async revokeConsent(accountId: string): Promise<AgentStatus> {
    const { settings, insights } = this.deps;
    const had = (await settings.listConsents()).filter((c) => c.accountId === accountId);
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
   * The model and the effort of each kind of work (ADR 0051, rule 6; ADR 0118, rule 1). A kind
   * left out keeps what it has. An effort is checked against the levels, not against what the
   * runtime lists: a stored level the runtime does not list is sent as `default` (rule 4).
   */
  async setModels(
    models: Partial<AgentModels>,
    efforts: Partial<AgentEfforts> = {},
  ): Promise<AgentStatus> {
    const current = await this.deps.settings.get();
    const next = { ...current.models };
    const nextEfforts = { ...current.efforts };
    for (const key of AGENT_WORK_KINDS) {
      const value = efforts[key];
      if (value === undefined) continue;
      if (!isAgentEffortSetting(value)) {
        throw new InvalidAgentSettingError("That effort is not one of the levels.");
      }
      nextEfforts[key] = value;
    }
    const known = this.info?.models ?? [];
    for (const key of ["understand", "write", "answer", "titles"] as const) {
      const value = models[key];
      if (value === undefined) continue;
      const ok =
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 64 &&
        ((key === "titles" && value === TITLES_OFF) || known.length === 0 || known.includes(value));
      if (!ok) throw new InvalidAgentSettingError("That model is not available.");
      next[key] = value;
    }
    await this.deps.settings.update({ models: next, efforts: nextEfforts });
    this.deps.onChanged();
    this.kick();
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

  async setTalkLoop(on: boolean): Promise<AgentStatus> {
    await this.deps.settings.update({ talkLoop: on === true });
    this.deps.onChanged();
    return this.status();
  }

  // --- AgentApi: the person asks ---

  /**
   * The gates of a turn the person asked for (ADR 0063), in order: AI on for this runtime, the
   * thread exists, its account agreed, the runtime ready, the plan has room. Gives the settings;
   * the one turn works from the thread alone.
   */
  private async gateForAsk(threadId: string) {
    const { runtime } = this.deps;
    const s = await this.currentSettings();
    if (!s.enabled || s.runtimeId !== runtime.id) throw new AgentUnavailableError(NOT_READY);
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    if (view === null) throw new ThingNotFoundError();
    const accountId = view.thread.accountId;
    if (!(await consentedAccounts(this.deps, runtime.id)).has(accountId)) {
      throw new AgentUnavailableError(NO_CONSENT);
    }
    await this.gateRuntime(s);
    return { s, accountId };
  }

  /** The last gates of a turn the person asked for: the runtime is ready and the plan has room. */
  private async gateRuntime(s: AgentSettings): Promise<void> {
    if (this.info === null) await this.inspectRuntime();
    if (this.info?.status !== "ready") throw new AgentUnavailableError(NOT_READY);
    const gate = mayRun(
      "P0",
      s.limits,
      { weekSharePercent: s.weekSharePercent, usedByUsPercent: s.usedByUsPercent },
      this.now,
    );
    if (!gate.ok) throw new AgentUnavailableError(USED_UP);
  }

  /** What the person is told when a turn they asked for fails; the error is not shown as it is. */
  private askFailure(error: unknown, fallback: string): Error {
    if (error instanceof AgentUnavailableError || error instanceof ThingNotFoundError) return error;
    if (isAgentRunError(error) && (error.code === "notSignedIn" || error.code === "notPlan")) {
      this.blocked = error.code === "notPlan" ? "notPlan" : "signedOut";
      return new AgentUnavailableError(
        "The assistant is signed out or not using your plan. Check it in Settings.",
      );
    }
    if (isAgentRunError(error) && error.code === "limit") return new AgentUnavailableError(USED_UP);
    // The model does not take the effort set for this work: said as the runtime said it, which
    // is a sentence of the adapter's naming the model and the level (ADR 0118, rule 5).
    if (isAgentRunError(error) && error.code === "effortRefused") {
      return new AgentUnavailableError(error.message);
    }
    return new AgentUnavailableError(fallback);
  }

  async prepare(threadId: string, guidance?: PreparedGuidance): Promise<PrepareResult> {
    const { s } = await this.gateForAsk(threadId);
    try {
      return await this.prepareFor(
        threadId,
        s.models.write,
        guidance !== undefined && (guidance.direction ?? guidance.answer) !== undefined
          ? guidance
          : undefined,
        this.effortOf("write", s),
      );
    } catch (error) {
      throw this.askFailure(error, "The assistant could not prepare this. Try again.");
    }
  }

  // --- Help with a reply (ADR 0098) ---

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
  private async helpThread(threadId: string): Promise<PromptThread> {
    const consented = await consentedAccounts(this.deps, this.deps.runtime.id);
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
    accountId: string,
    threads: number,
    run: { model: string; request: AgentRequestBody; effort: AgentEffort | undefined },
    failed: string,
  ): Promise<unknown> {
    const { runtime, insights, settings } = this.deps;
    const before = (await settings.get()).limits;
    try {
      const result = await runtime.run(
        {
          model: run.model,
          ...run.request,
          ...withEffort(run.effort),
        },
        { signal: this.abort.signal },
      );
      await this.noteRun(result.limits, before);
      return result.value;
    } catch (error) {
      throw this.askFailure(error, failed);
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
  }

  async rewriteDraft(threadId: string, text: string, how: RewriteHow): Promise<{ text: string }> {
    if (!REWRITE_HOWS.includes(how)) {
      throw new InvalidAgentSettingError("The draft can be made shorter, formal or English.");
    }
    const parts = this.ownLines(text, true);
    const { s, accountId } = await this.gateForAsk(threadId);
    const standing = { list: await this.deps.insights.listInstructions(), threadId };
    const value = await this.helpTurn(
      accountId,
      0,
      {
        model: s.models.write,
        request: buildRewriteRequest(parts.own, how, standing),
        effort: this.effortOf("write", s),
      },
      "The assistant could not rewrite this. Try again.",
    );
    const got = acceptRewrite(value, parts.own);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return { text: joinDraft(got.value, parts.quote) };
  }

  async answerQuestions(
    threadId: string,
    text: string,
    missing: readonly string[] = [],
  ): Promise<{ text: string }> {
    const parts = this.ownLines(text, false);
    const { s, accountId } = await this.gateForAsk(threadId);
    const thread = await this.helpThread(threadId);
    const last = lastFromThem(thread);
    // Nobody else wrote, or a list or a program did: there is nothing to answer, and no turn.
    if (last === null || last.message.automated === true) return { text };
    const standing = { list: await this.deps.insights.listInstructions(), threadId };
    const value = await this.helpTurn(
      accountId,
      1,
      {
        model: s.models.write,
        request: buildAnswerQuestionsRequest(thread, last, parts.own, this.now, standing, missing),
        effort: this.effortOf("write", s),
      },
      "The assistant could not answer the questions. Try again.",
    );
    const got = acceptAnswers(value, parts.own);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return { text: got.value === parts.own ? text : joinDraft(got.value, parts.quote) };
  }

  async checkReply(threadId: string, text: string): Promise<ReplyCheck> {
    const parts = this.ownLines(text, false);
    const { s, accountId } = await this.gateForAsk(threadId);
    const last = lastFromThem(await this.helpThread(threadId));
    // Mail from a list or a program asks nothing of the person (ADR 0098 addendum): no turn.
    if (last === null || last.text === "" || last.message.automated === true) {
      return { asked: 0, answered: 0, missing: [] };
    }
    const value = await this.helpTurn(
      accountId,
      1,
      {
        model: s.models.understand,
        request: buildCheckReplyRequest(last, parts.own),
        effort: this.effortOf("understand", s),
      },
      "The assistant could not check the reply. Try again.",
    );
    const got = acceptCheck(value);
    if (!got.ok) throw new AgentUnavailableError(helpRefused(got.reason));
    return got.value;
  }

  async fillGaps(threadId: string, text: string): Promise<readonly GapSuggestion[]> {
    const parts = this.ownLines(text, false);
    const { s, accountId } = await this.gateForAsk(threadId);
    const tokens = draftGaps(parts.own).slice(0, MAX_GAPS);
    // No gap to fill: no turn.
    if (tokens.length === 0) return [];
    const thread = await this.helpThread(threadId);
    const value = await this.helpTurn(
      accountId,
      1,
      {
        model: s.models.understand,
        request: buildFillGapsRequest(thread, parts.own, tokens, this.now),
        effort: this.effortOf("understand", s),
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

  async talk(threadId: string, words: string): Promise<TalkResult> {
    const typed = words.trim().slice(0, MAX_GUIDANCE_CHARS);
    if (typed === "") throw new InvalidAgentSettingError("Write something to ask or say first.");
    if (this.talking.has(threadId)) {
      throw new AgentUnavailableError("The assistant is still working on this thread.");
    }
    // Taken before the first wait, so a second call cannot slip in during the gates.
    const mine = new AbortController();
    this.talking.set(threadId, mine);
    try {
      const { s } = await this.gateForAsk(threadId);
      return await this.talkNow(
        threadId,
        typed,
        s.models.write,
        this.effortOf("write", s),
        mine.signal,
      );
    } catch (error) {
      if (mine.signal.aborted && !(error instanceof ThingNotFoundError)) {
        throw new AgentUnavailableError("Stopped.");
      }
      throw this.askFailure(error, TALK_FAILED);
    } finally {
      this.talking.delete(threadId);
    }
  }

  /** One turn: the thread and its talk go out, and only an answer the code accepts is kept. */
  private async talkNow(
    threadId: string,
    words: string,
    model: string,
    effort: AgentEffort | undefined,
    stop: AbortSignal,
  ): Promise<TalkResult> {
    const { runtime, insights, settings } = this.deps;
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
    );
    // Stopped before anything left: no mail went, so no line in the ledger.
    if (stop.aborted) throw new AgentUnavailableError("Stopped.");
    const before = (await settings.get()).limits;
    try {
      // The service's own signal still cuts the turn short when AI is turned off or consent goes.
      const run = await runtime.run(
        { model, ...request, ...withEffort(effort) },
        { signal: AbortSignal.any([this.abort.signal, stop]) },
      );
      await this.noteRun(run.limits, before);
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
          threadId,
          lastMessageKey,
          answer.reason,
          clean(loaded.thread.subject).slice(0, 200),
          words,
        );
        reply = { ...agent, kind: "closed", text: answer.reason };
      } else {
        await this.storePrepared(threadId, lastMessageKey, workOf(answer));
        reply = { ...agent, kind: answer.kind === "draft" ? "draft" : "question", text: "" };
      }
      const entries = await insights.appendTalk([{ ...from, role: "you", text: words }, reply]);
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

  promptRun(query: string, again?: boolean, readAll?: boolean): Promise<PromptRunResult> {
    return this.prompts.run(query, again === true, readAll === true);
  }

  async promptStop(): Promise<void> {
    this.prompts.stop();
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

  async talkAll(words: string, talkId?: number | null): Promise<TalkResult> {
    // A call refused because a turn is running must not stand for that turn.
    const busy = this.talkingAll !== null;
    const running = this.talkAllOnce(words, talkId ?? null);
    if (!busy) this.talkingAllDone = running;
    try {
      return await running;
    } finally {
      if (this.talkingAllDone === running) this.talkingAllDone = null;
    }
  }

  private async talkAllOnce(words: string, talkId: number | null): Promise<TalkResult> {
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
    try {
      const s = await this.currentSettings();
      if (!s.enabled || s.runtimeId !== this.deps.runtime.id) {
        throw new AgentUnavailableError(NOT_READY);
      }
      if ((await consentedAccounts(this.deps, this.deps.runtime.id)).size === 0) {
        throw new AgentUnavailableError(NO_CONSENT);
      }
      await this.gateRuntime(s);
      // The talk it is asked in; one that is gone, or none, is started now (ADR 0086).
      const known = talkId === null ? null : await this.deps.insights.getTalk(talkId);
      const talk = known ?? (await this.deps.insights.createTalk(this.now));
      this.talkingAllIn = talk.id;
      const result = await this.talkAllNow(typed, s, mine.signal, talk.id);
      const named = await this.deps.insights.getTalk(talk.id);
      if (named !== null) void this.nameTalkSoon(named);
      return { ...result, talkId: talk.id };
    } catch (error) {
      if (mine.signal.aborted) throw new AgentUnavailableError("Stopped.");
      throw this.askFailure(error, TALK_FAILED);
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
      const s = await this.currentSettings();
      if (!s.enabled || s.runtimeId !== this.deps.runtime.id) return;
      if (s.models.titles === TITLES_OFF) return;
      const gate = mayRun(
        "P3",
        s.limits,
        { weekSharePercent: s.weekSharePercent, usedByUsPercent: s.usedByUsPercent },
        this.now,
      );
      if (!gate.ok) {
        this.titleTries.set(talk.id, tries + 1);
        return;
      }
      const questions = (
        await this.deps.insights.listTalk(null, MAX_TALK_SHOWN, { talkId: talk.id })
      )
        .flatMap((e) => (e.role === "you" ? [e.text] : []))
        .slice(0, TALK_TITLE_QUESTIONS);
      if (questions.length === 0) return;
      this.titleTries.set(talk.id, tries + 1);
      // A model this runtime does not offer (a choice made for another runtime) reads with the
      // cheap model for understanding mail instead.
      const offered = this.info?.models ?? [];
      const model =
        offered.length === 0 || offered.includes(s.models.titles)
          ? s.models.titles
          : s.models.understand;
      const run = await this.deps.runtime.run(
        { model, ...buildTalkTitleRequest(questions), ...withEffort(this.effortOf("titles", s)) },
        { signal: this.abort.signal },
      );
      await this.noteRun(run.limits, s.limits);
      const title = parseTalkTitleAnswer(run.value);
      if (title === null) return;
      if (await this.deps.insights.nameTalk(talk.id, title, "model")) this.deps.onChanged();
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
  ): Promise<TalkResult> {
    const { runtime, insights, settings } = this.deps;
    const startedAt = performance.now();
    // The loop of ADR 0083 when the person turned it on and the runtime can run tools.
    const loop = s.talkLoop === true ? runtime.runWithTools : undefined;
    const cap = loop === undefined ? TALK_TIME_CAP_MS : TALK_LOOP_TIME_CAP_MS;
    const over = () => performance.now() - startedAt > cap;
    const signal = AbortSignal.any([this.abort.signal, stop, AbortSignal.timeout(cap)]);
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
      model: string = s.models.understand,
      used?: TalkLoopUse,
    ): Promise<TalkResult> => {
      const atMs = this.now;
      const entries = await insights.appendTalk([
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
      ]);
      this.deps.onChanged();
      return { entries };
    };
    const efforts = {
      understand: this.effortOf("understand", s),
      write: this.effortOf("write", s),
      answer: this.effortOf("answer", s),
    };
    /** One turn of the understanding model: counted against the plan, stopped by Stop. */
    const understand = async (request: AgentRequestBody): Promise<unknown> => {
      const before = (await settings.get()).limits;
      const run = await runtime.run(
        { model: s.models.understand, ...request, ...withEffort(efforts.understand) },
        { signal },
      );
      await this.noteRun(run.limits, before);
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
          sent: (perAccount) => this.recordTalkSent(perAccount, efforts.understand),
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
        ...(runtime.takesFiles === true && this.deps.wholeFile !== undefined
          ? { wholeFiles: true }
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
        const before = (await settings.get()).limits;
        let run: AgentRunResult;
        try {
          run = await withTools.call(
            runtime,
            {
              model: s.models.write,
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
          if (stop.aborted || this.abort.signal.aborted || opened.length === 0) throw error;
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
        await this.noteRun(run.limits, before);
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
        await this.recordTalkSent(tools.state.sent, efforts.write).catch((error: unknown) =>
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
      const entries = await insights.appendTalk([
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
          model: s.models.write,
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
      ]);
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
            loop === undefined ? undefined : s.models.write,
            trail.loop,
          )
        : nothing(trail.firstQuery, undefined, undefined, trail.loop);
    }
    const standing = { list: await insights.listInstructions(), threadId: "" };
    const build = (threads: readonly PromptThread[]) =>
      buildTalkAllRequest(threads, this.now, history, words, standing, trail.queries, {
        offers,
        facts,
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
    try {
      const answerBefore = (await settings.get()).limits;
      const run = await runtime.run(
        {
          model: s.models.answer,
          ...built.request,
          ...withEffort(efforts.answer),
          ...(whole.files.length === 0 ? {} : { files: whole.files }),
        },
        { signal },
      );
      await this.noteRun(run.limits, answerBefore);
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
      const entries = await insights.appendTalk([
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
          model: s.models.answer,
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
      ]);
      this.deps.onChanged();
      return { entries };
    } finally {
      // What was sent is counted whether or not it worked: counts per account, no text (rule 10).
      const perAccount = new Map<string, number>();
      for (const l of sent) perAccount.set(l.accountId, (perAccount.get(l.accountId) ?? 0) + 1);
      await this.recordTalkSent(perAccount, efforts.answer);
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
    const consented = await consentedAccounts(this.deps, this.deps.runtime.id);
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
    perAccount: ReadonlyMap<string, number>,
    effort: AgentEffort | undefined,
  ): Promise<void> {
    await this.deps.insights.appendLedger(
      [...perAccount].map(([accountId, threads]) => ({
        atMs: this.now,
        runtimeId: this.deps.runtime.id,
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
    const { runtime, insights } = this.deps;
    const s = await this.currentSettings();
    if (!s.enabled || s.runtimeId !== runtime.id) return none;
    if (this.info === null) await this.inspectRuntime();
    if (this.info?.status !== "ready") return none;
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    if (view === null) return none;
    const accountId = view.thread.accountId;
    if (!(await consentedAccounts(this.deps, runtime.id)).has(accountId)) return none;
    const gate = mayRun(
      "P1",
      s.limits,
      { weekSharePercent: s.weekSharePercent, usedByUsPercent: s.usedByUsPercent },
      this.now,
    );
    if (!gate.ok) return none;

    let answer: ReturnType<typeof parseRememberAnswer> = null;
    // Not a kind of work: it stays at `low`, when the runtime takes it (ADR 0118, rule 6).
    const effort = resolveEffort("low", this.info?.efforts);
    try {
      const run = await runtime.run(
        { model: s.models.understand, ...buildRememberRequest(typed), ...withEffort(effort) },
        { signal: this.abort.signal },
      );
      await this.noteRun(run.limits, s.limits);
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
        const rule = await insights.addRule(
          { scope: "sender", subject: address, action: "noReply", actor: "agent", words: typed },
          this.now,
        );
        items.push({ kind: "rule", rule });
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
      const instruction = await insights.addInstruction(
        {
          scope: item.scope,
          text,
          ...(here === undefined ? {} : { threadId: here }),
          actor: "agent",
          words: typed,
        },
        this.now,
      );
      items.push({ kind: "instruction", instruction });
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
    const draft = await this.deps.saveDraft({
      ...prepared.content,
      bodyMarkdown: `${body.replace(/\r\n?/g, "\n").trimEnd()}${prepared.content.bodyMarkdown === "" ? "\n" : prepared.content.bodyMarkdown}`,
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
    case "shape":
      return "The assistant's answer could not be used. Try again.";
  }
}

/** The prepared work a draft or a question answer stands for. */
function workOf(answer: Exclude<PreparedAnswer, { kind: "closed" }>): PreparedWork {
  return answer.kind === "draft"
    ? { kind: "draft", body: answer.body, nudge: answer.nudge }
    : { kind: "needs", missing: answer.missing, directions: answer.directions };
}
