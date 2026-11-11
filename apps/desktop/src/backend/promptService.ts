// A prompt is a filter (ADR 0116), in the sync worker. A run starts with a search by the agent
// (rule 4): the loop of ADR 0083 with two read-only tools, or the plan turn and trail of ADR 0080
// for a runtime without tools, every query ANDed with the query's mail filters in code. What the
// search wrote is kept, so coming back runs the same queries here with no model, and only threads
// with no verdict go to the batches of rule 9. The candidates are everything those queries match
// (promptCandidates.ts); above `PROMPT_ASK_ABOVE` to read, the reading waits for the person.
// Under `limit:` they are read in the order of `sort:` and the reading stops once that many fit
// (rules 4a and 4b); the order is never part of a key. A saved view with a prompt that was run
// once also reads its new mail in the background (ADR 0117, rule 3): `readInBackground`, with no
// search and no question. Nothing here logs mail text, subjects, addresses or the prompt: errors
// carry fixed sentences only.
import type {
  AccountStorePort,
  AgentEffort,
  AgentInsightStorePort,
  AgentPriority,
  AgentRequestBody,
  AgentRunResult,
  AgentRuntimePort,
  AgentSettings,
  AgentSettingsPort,
  AgentWorkKind,
  MessageStorePort,
  ParsedQuery,
  PlanLimits,
  PromptBadge,
  PromptCandidate,
  PromptCount,
  PromptList,
  PromptPhase,
  PromptProgress,
  PromptRow,
  PromptRunResult,
  PromptSearch,
  PromptStep,
  PromptThread,
  PromptVerdict,
  QuerySortValue,
  SavedViewStorePort,
  SearchIndexPort,
} from "@matters/core";
import {
  acceptVerdicts,
  buildPromptRequest,
  buildPromptSearchRequest,
  buildTalkPlanRequest,
  isAgentRunError,
  MAX_PARALLEL_TURNS,
  MAX_PROMPT_BATCH_THREADS,
  mayRun,
  orderPromptRows,
  PROMPT_ASK_ABOVE,
  PROMPT_KEEP_DAYS,
  PROMPT_VERSION,
  parseQuery,
  parseTalkLoop,
  parseTalkPlan,
  promptFilters,
  promptKey,
  promptWindow,
  readOrder,
  sortOf,
  TALK_LOOP_TIME_CAP_MS,
  TALK_LOOP_TIME_MS,
  TALK_TIME_CAP_MS,
  withEffort,
} from "@matters/core";
import { AgentUnavailableError, InvalidAgentSettingError } from "./agentApi.ts";
import { consentedAccounts } from "./agentReads.ts";
import { type MailToolsContext, openMailTools } from "./mailTools.ts";
import { PromptCandidates, type PromptCandidateThread } from "./promptCandidates.ts";
import { sha256Hex } from "./promptFits.ts";
import { followTrail } from "./talkTrail.ts";
import type { PoolContext } from "./trailPool.ts";

const DAY_MS = 86_400_000;

export { sha256Hex };

/** Fixed sentences for the person; none holds mail. */
const NO_PROMPT = "There is no prompt in this query.";
const BUSY = "The assistant is still working on a prompt.";
const USED_UP = "Your plan's allowance is used up for now. The threads read so far are kept.";
const FAILED = "The assistant could not read some threads. Try again.";
const SEARCH_FAILED = "The assistant could not search for this prompt. Try again.";
const STOPPED = "Stopped.";

/** The thread as a model sees it, as the agent service loads it. */
export interface LoadedThread {
  readonly thread: PromptThread;
  readonly lastMessageKey: number;
  readonly accountId: string;
}

export interface PromptServiceDeps {
  readonly runtime: Pick<AgentRuntimePort, "id" | "run" | "runWithTools">;
  /** The candidate pipeline of ADR 0081 and 0082, and the tools of the loop (ADR 0083). */
  readonly store: MailToolsContext["store"] & Pick<MessageStorePort, "changesSince">;
  /** The ranked search of the agent, and the person's own matching for the mail filters. */
  readonly index: MailToolsContext["index"] & Pick<SearchIndexPort, "matchesAmong">;
  readonly bodies: PoolContext["bodies"];
  visibleText(html: string): string;
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly insights: Pick<
    AgentInsightStorePort,
    | "listRules"
    | "getPromptVerdicts"
    | "putPromptVerdicts"
    | "prunePromptVerdicts"
    | "getPromptSearch"
    | "putPromptSearch"
    | "appendLedger"
  >;
  readonly settings: Pick<AgentSettingsPort, "get" | "listConsents">;
  /** The saved views: a prompt one of them holds is never pruned (rule 12). */
  readonly views?: Pick<SavedViewStorePort, "list">;
  now(): number;
  /** The last gates of a turn the person asked for (`P0`): the runtime is ready, the plan has room. */
  gateRuntime(s: AgentSettings): Promise<void>;
  /** The thread as the model reads it, clipped, with its History line (ADR 0066, rule 1). */
  loadThread(threadId: string, consented: ReadonlySet<string>): Promise<LoadedThread | null>;
  /** Records the plan's windows a turn saw. */
  noteRun(limits: PlanLimits | undefined, before?: PlanLimits): Promise<void>;
  /** The effort a turn on the model of `kind` sends, or none (ADR 0118, rules 1 and 4). */
  effortOf(kind: AgentWorkKind, s: AgentSettings): AgentEffort | undefined;
  /** What the person is told when a turn they asked for cannot be done. */
  askFailure(error: unknown, fallback: string): Error;
  /** Aborted when AI is turned off: nothing more goes once the person says no. */
  stopAll(): AbortSignal;
  /** How far a run is, as it goes (rule 9). */
  onProgress?(progress: PromptProgress): void;
}

type Candidate = PromptCandidateThread;

/** The prompt of a query, its key, and the mail filters it goes with. */
interface Asked {
  readonly text: string;
  readonly parsed: ParsedQuery;
  readonly key: string;
  readonly filters: string;
  /** The person's `limit:` (rule 4a): reading stops once this many fit; only they are listed. */
  readonly limit: number | undefined;
  /** The order of reading and of the list (rules 4a and 4b). Not part of any key. */
  readonly sort: QuerySortValue;
}

/** A run going on (rule 9): one at a time. */
interface Running {
  readonly key: string;
  readonly filters: string;
  readonly stop: AbortController;
  phase: PromptPhase;
  done: number;
  total: number;
  step?: PromptStep;
  /** Under a limit: the threads that fit so far (rule 4a). */
  fits?: number;
  /** Once the search is known: all candidates, so the list does not search again meanwhile. */
  candidates: readonly Candidate[] | null;
  /** A reading in the background for a saved view (ADR 0117, rule 3): no window waits for it. */
  readonly background?: true;
}

/** How `readBatches` goes: `P0` for what the person asked, unless told otherwise. */
interface BatchOptions {
  /** Under a limit (rule 4a): after each batch, whether that many fit; then no batch more starts. */
  readonly enough?: (tried: readonly string[], accepted: readonly PromptVerdict[]) => boolean;
  /** The priority each batch is gated at (ADR 0051, rule 7). */
  readonly priority?: AgentPriority;
  /** Checked before each batch: true, and no batch more starts (the person's pause). */
  readonly stopWhen?: () => boolean;
}

/** What the reading in the background is told by the pass it runs in (ADR 0117, rule 3). */
export interface BackgroundOptions {
  /** Mail of this many days is `P1`, older `P3` (ADR 0051, rule 7), as for the reading of a window. */
  readonly recentDays: number;
  /** True once the person paused reading or the pass ends: no batch more starts. */
  readonly stopWhen: () => boolean;
}

/** How the search ended: what it wrote, or why nothing is kept. */
type Searched =
  | { readonly kind: "found"; readonly queries: readonly string[]; readonly threadIds: string[] }
  | { readonly kind: "stopped" }
  | { readonly kind: "problem"; readonly problem: string };

/** A thread the background sent this often with no verdict back is left until it changes. */
const BACKGROUND_TRIES = 2;
/** Threads the background remembers trying: more than a pass ever sends. */
const MAX_TRIED = 5000;

const triedKey = (key: string, c: Pick<Candidate, "threadId" | "lastMessageKey">): string =>
  `${key}\n${c.threadId}\n${c.lastMessageKey}`;

/** The candidates in the order they are read in (rule 4a). */
const inReadingOrder = (all: readonly Candidate[], sort: QuerySortValue): readonly Candidate[] =>
  readOrder(
    all.map((c) => ({
      c,
      threadId: c.threadId,
      lastMessageKey: c.lastMessageKey,
      lastDateMs: c.newest.dateMs,
    })),
    sort,
  ).map((x) => x.c);

const OFF: PromptList = {
  ai: "off",
  promptKey: "",
  searched: false,
  found: 0,
  read: 0,
  fits: 0,
  rows: [],
};

export class PromptService {
  private readonly deps: PromptServiceDeps;
  private running: Running | null = null;
  /**
   * The reading in the background, if one goes on (ADR 0117, rule 3). It never runs beside a run
   * the person started: it does not start while one goes on, and once one starts it starts no
   * batch more. The run joins it: it waits for the turns already sent to answer, keeps their
   * verdicts, and only then looks at what is left to read. So no thread is sent twice, and one
   * prompt never has two readings at once. Turning AI off stops both at once.
   */
  private back: { readonly done: Promise<void> } | null = null;
  /** Threads the background sent and got no verdict for, by prompt, thread and last message. */
  private readonly tried = new Map<string, number>();
  private readonly candidates: PromptCandidates;

  constructor(deps: PromptServiceDeps) {
    this.deps = deps;
    this.candidates = new PromptCandidates({ store: deps.store, index: deps.index });
  }

  /**
   * What the kept search of the prompt finds now and how many of those have a verdict (rule 4).
   * No model: before the first search nothing is known.
   */
  async count(query: string): Promise<PromptCount> {
    const { rows: _rows, ...count } = await this.list(query, false);
    return count;
  }

  /** The stored verdicts for a query, ordered as the list shows them (rule 7). No model. */
  async verdicts(query: string): Promise<PromptList> {
    return this.list(query, true);
  }

  /**
   * The number on the tab of a view with a prompt (ADR 0117, rule 4): the unread threads among
   * those the list shows, so under the view's mail filters, fit 2 or 3, and within its `limit:`
   * as the list keeps it. From stored verdicts and the kept search, no model. A view never run
   * has no kept search and shows none (`unread` null).
   */
  async badge(query: string): Promise<PromptBadge> {
    const l = await this.list(query, true);
    if (l.ai === "off") return { ai: "off", unread: null };
    if (!l.searched) return { ai: "on", unread: null };
    return { ai: "on", unread: l.rows.filter((r) => r.unread > 0).length };
  }

  /**
   * Cuts the running run short. In the search nothing is kept; in the reading the batches that
   * finished are kept. Nothing running: nothing.
   */
  stop(): void {
    this.running?.stop.abort();
  }

  /**
   * Runs the prompt of `query` (rule 3), `P0`. Without a kept search, or with `again`, the agent
   * searches first (rule 4); then the threads found that have no verdict are read in batches on
   * the model for understanding mail (rule 9), each batch kept as it returns. Refused with a
   * sentence while another run goes on. While AI is off it answers `off` and sends nothing. More
   * than `PROMPT_ASK_ABOVE` to read are read only with `readAll`; else the run ends with `ask`.
   */
  async run(query: string, again = false, readAll = false): Promise<PromptRunResult> {
    const asked = await this.ask(query);
    const s = await this.deps.settings.get();
    const consented = await this.consented(s);
    if (consented.size === 0) return { ...OFF, stopped: false, rejected: 0 };
    if (this.running !== null) throw new AgentUnavailableError(BUSY);
    const mine: Running = {
      key: asked.key,
      filters: asked.filters,
      stop: new AbortController(),
      phase: "searching",
      done: 0,
      total: 0,
      candidates: null,
    };
    this.running = mine;
    const startedAt = this.deps.now();
    let stopped = false;
    let problem: string | undefined;
    let rejected = 0;
    let ask = false;
    let gated = false;
    const gate = async () => {
      if (gated) return;
      try {
        await this.deps.gateRuntime(s);
      } catch (error) {
        throw this.deps.askFailure(error, FAILED);
      }
      gated = true;
    };
    try {
      // A reading in the background gives way: its turns answer before anything is counted here.
      await this.joinBackground();
      await this.prune();
      const signal = AbortSignal.any([mine.stop.signal, this.deps.stopAll()]);
      let search = again
        ? null
        : await this.deps.insights.getPromptSearch(asked.key, asked.filters);
      let candidates: readonly Candidate[] | null =
        search === null ? null : await this.candidatesOf(asked, search, consented);
      // A kept whole match whose filters now match more no longer stands: it searches (rule 4).
      if (candidates === null) search = null;
      if (search === null && asked.parsed.root !== null) {
        // Rule 4: mail filters that alone match few threads are read whole, with no search.
        const whole = await this.candidates.whole(
          { parsed: asked.parsed, ctx: await this.poolContext(asked, consented, false) },
          PROMPT_ASK_ABOVE,
        );
        if (whole !== null) {
          search = {
            promptKey: asked.key,
            filters: asked.filters,
            queries: [],
            threadIds: [],
            atMs: this.deps.now(),
            whole: true,
          };
          await this.deps.insights.putPromptSearch(search);
          candidates = whole;
        }
      }
      if (search === null) {
        await gate();
        this.progress(mine, false);
        const searched = await this.search(asked, s, consented, signal, mine);
        if (searched.kind === "stopped") stopped = true;
        else if (searched.kind === "problem") problem = searched.problem;
        else {
          // Only a search that ended is kept: a stopped one leaves nothing half-written.
          search = {
            promptKey: asked.key,
            filters: asked.filters,
            queries: searched.queries,
            threadIds: searched.threadIds,
            atMs: this.deps.now(),
          };
          await this.deps.insights.putPromptSearch(search);
          candidates = await this.candidatesOf(asked, search, consented);
        }
      }
      if (candidates !== null && !stopped && problem === undefined) {
        mine.candidates = candidates;
        // Rule 4a: in the order of `sort:`; under a limit only until that many fit.
        const ordered = inReadingOrder(candidates, asked.sort);
        const known = await this.known(asked.key, ordered);
        const window = promptWindow(ordered, known, asked.limit, asked.sort);
        // Rule 4a: a limit bounds what is read only when enough fit; by date, or when few fit,
        // the threads before the limit's worth can be thousands. So under a limit one run reads
        // at most `PROMPT_ASK_ABOVE` of them, in order, and the next `↵` reads on (rule 4: what
        // one `↵` spends is bounded, and the line says how many are left).
        const todo =
          asked.limit !== undefined && window.todo.length > PROMPT_ASK_ABOVE
            ? window.todo.slice(0, PROMPT_ASK_ABOVE)
            : window.todo;
        mine.phase = "reading";
        mine.total = todo.length;
        mine.step = undefined;
        if (asked.limit !== undefined) mine.fits = window.fitting.length;
        // Rule 4: the count is said first; above the line the reading waits for one more `↵`.
        // Under a limit nothing is asked: each run is bounded above.
        ask = asked.limit === undefined && todo.length > PROMPT_ASK_ABOVE && !readAll;
        if (todo.length > 0 && !ask) {
          await gate();
          this.progress(mine, false);
          // What a turn answered, or tried and could not: a thread tried counts as read here, so
          // one batch the code refused does not keep a dated limit from being reached.
          const seen = new Map<string, { readonly fit: number }>(known);
          const enough =
            asked.limit === undefined
              ? undefined
              : (tried: readonly string[], accepted: readonly PromptVerdict[]) => {
                  for (const id of tried) if (!seen.has(id)) seen.set(id, { fit: 0 });
                  for (const v of accepted) seen.set(v.threadId, v);
                  const now = promptWindow(ordered, seen, asked.limit, asked.sort);
                  mine.fits = now.fitting.length;
                  return now.reached;
                };
          const outcome = await this.readBatches(todo, asked, s, consented, signal, mine, {
            ...(enough === undefined ? {} : { enough }),
          });
          rejected = outcome.rejected;
          problem = outcome.problem;
          stopped = signal.aborted && problem === undefined;
        }
        // ADR 0117, rule 3: all it set out to read is read, so the background goes on from here.
        if (
          search !== null &&
          !ask &&
          !stopped &&
          problem === undefined &&
          rejected === 0 &&
          todo.length === window.todo.length
        ) {
          await this.deps.insights.putPromptSearch({ ...search, readAtMs: startedAt });
        }
      }
    } finally {
      this.running = null;
      this.progress(mine, true);
    }
    const list = await this.list(query, true);
    return {
      ...list,
      stopped,
      rejected,
      ...(problem === undefined ? {} : { problem }),
      ...(ask && problem === undefined && !stopped ? { ask: true as const } : {}),
    };
  }

  // --- The query ---

  /** The query parsed as the list parses it, with the accounts known for `account:` and `from:me`. */
  private async ask(query: string): Promise<Asked> {
    const accounts = await this.deps.accounts.list();
    const parsed = parseQuery(query, {
      nowMs: this.deps.now(),
      accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
    });
    if (parsed.prompt === undefined) throw new InvalidAgentSettingError(NO_PROMPT);
    return {
      text: parsed.prompt.text,
      parsed,
      key: promptKey(parsed.prompt.text, sha256Hex),
      filters: promptFilters(query, parsed),
      limit: parsed.limit?.n,
      sort: sortOf(parsed),
    };
  }

  /** Accounts with consent for this runtime while AI is on for it; empty means off (rule 11). */
  private async consented(s: AgentSettings): Promise<ReadonlySet<string>> {
    if (!s.enabled || s.runtimeId !== this.deps.runtime.id) return new Set();
    return consentedAccounts(this.deps, this.deps.runtime.id);
  }

  private async list(query: string, withRows: boolean): Promise<PromptList> {
    const asked = await this.ask(query);
    const s = await this.deps.settings.get();
    const consented = await this.consented(s);
    if (consented.size === 0) return OFF;
    const run = this.running;
    const ours = run !== null && run.key === asked.key && run.filters === asked.filters;
    const running =
      run?.key === asked.key
        ? { running: { phase: run.phase, done: run.done, total: run.total } }
        : {};
    const search = await this.deps.insights.getPromptSearch(asked.key, asked.filters);
    const limit = asked.limit === undefined ? {} : { limit: asked.limit };
    if (search === null) {
      const none = { searched: false, found: 0, ...limit, read: 0, fits: 0 };
      return { ai: "on", promptKey: asked.key, ...none, ...running, rows: [] };
    }
    const all =
      (ours ? run.candidates : null) ?? (await this.candidatesOf(asked, search, consented));
    if (all === null) {
      // A whole match that grew past the line: nothing stands until a run searches (rule 4).
      const none = { searched: false, found: 0, ...limit, read: 0, fits: 0 };
      return { ai: "on", promptKey: asked.key, ...none, ...running, rows: [] };
    }
    // Rule 4a: read in the order of `sort:`, and under a limit only until that many fit; `found`
    // says what the search found.
    const ordered = inReadingOrder(all, asked.sort);
    const known = await this.known(asked.key, ordered);
    const window = promptWindow(ordered, known, asked.limit, asked.sort);
    const rows: PromptRow[] = [];
    if (withRows) {
      // Rule 4b: the threads that fit, in the order of `sort:`.
      const listed = orderPromptRows(
        window.fitting.flatMap((c) => {
          const v = known.get(c.threadId);
          return v === undefined
            ? []
            : [
                {
                  c,
                  v,
                  fit: v.fit,
                  threadId: c.threadId,
                  lastDateMs: c.newest.dateMs,
                  lastMessageKey: c.lastMessageKey,
                },
              ];
        }),
        asked.sort,
      );
      for (const { c, v } of listed) {
        if (v.fit !== 2 && v.fit !== 3) continue;
        rows.push({
          threadId: c.threadId,
          message: c.newest,
          unread: c.unread,
          fit: v.fit,
          why: v.why,
          ...(v.quote === undefined ? {} : { quote: v.quote }),
        });
      }
    }
    return {
      ai: "on",
      promptKey: asked.key,
      searched: true,
      found: all.length,
      ...limit,
      ...(search.whole === true ? { whole: true as const } : {}),
      read: window.read,
      fits: window.fitting.length,
      toRead: window.todo.length,
      ...(window.reached ? { reached: true as const } : {}),
      ...running,
      rows,
    };
  }

  /** The verdicts kept for these candidates as they stand, by thread. */
  private async known(
    key: string,
    candidates: readonly Candidate[],
  ): Promise<ReadonlyMap<string, PromptVerdict>> {
    const verdicts = await this.deps.insights.getPromptVerdicts(
      key,
      PROMPT_VERSION,
      candidates.map((c) => ({ threadId: c.threadId, lastMessageKey: c.lastMessageKey })),
    );
    return new Map(verdicts.map((v) => [v.threadId, v]));
  }

  // --- The candidates (rule 4) ---

  /**
   * The pipeline of ADR 0081 and 0082 over all stored mail of the accounts with consent, outside
   * Trash and Spam and without what the person's rules cover, every query ANDed with the mail
   * filters of the query (rule 4). Age weighs as little as in the loop: what a prompt asks for
   * is often old.
   */
  private async poolContext(
    asked: Asked,
    consented: ReadonlySet<string>,
    fragments: boolean,
  ): Promise<PoolContext> {
    const { index } = this.deps;
    const { parsed } = asked;
    const accounts = await this.deps.accounts.list();
    return {
      store: this.deps.store,
      index,
      bodies: this.deps.bodies,
      visibleText: (html) => this.deps.visibleText(html),
      nowMs: this.deps.now(),
      consented,
      accounts: accounts.map((a) => ({
        id: a.id,
        address: a.address,
        displayName: a.displayName,
      })),
      rules: await this.deps.insights.listRules(),
      olderThanDays: undefined,
      carry: undefined,
      time: "any",
      fragments,
      ...(parsed.root === null
        ? {}
        : {
            within: {
              root: parsed.root,
              among: (keys: readonly number[]) => index.matchesAmong(parsed, keys),
            },
          }),
    };
  }

  /** The candidates of a kept search, here, with no model (rule 4): see promptCandidates.ts. */
  private async candidatesOf(
    asked: Asked,
    search: Pick<PromptSearch, "queries" | "threadIds" | "atMs" | "whole">,
    consented: ReadonlySet<string>,
  ): Promise<Candidate[] | null> {
    return this.candidates.of({
      key: asked.key,
      filters: asked.filters,
      parsed: asked.parsed,
      search,
      ctx: await this.poolContext(asked, consented, false),
    });
  }

  // --- The search (rule 4) ---

  /**
   * The search turn(s): the loop of ADR 0083 when the person turned it on and the runtime can run
   * tools, as the talk across all mail decides, else the plan turn and the trail of ADR 0080. The
   * model gets the prompt as data and no mail before its first search. What went to the model is
   * counted in the ledger, whether or not the turn worked.
   */
  private async search(
    asked: Asked,
    s: AgentSettings,
    consented: ReadonlySet<string>,
    stop: AbortSignal,
    mine: Running,
  ): Promise<Searched> {
    const { runtime, settings } = this.deps;
    const loop = s.talkLoop === true ? runtime.runWithTools : undefined;
    const cap = loop === undefined ? TALK_TIME_CAP_MS : TALK_LOOP_TIME_CAP_MS;
    const startedAt = performance.now();
    const signal = AbortSignal.any([stop, AbortSignal.timeout(cap)]);
    const sent = new Map<string, number>();
    const add = (perAccount: ReadonlyMap<string, number>) => {
      for (const [accountId, n] of perAccount) sent.set(accountId, (sent.get(accountId) ?? 0) + n);
    };
    const step = (query: string, threads: number) => {
      mine.step = { query, threads };
      this.progress(mine, false);
    };
    // The loop runs on the model for writing; the plan and follow turns on the one for mail.
    const effort = this.deps.effortOf(loop === undefined ? "understand" : "write", s);
    const failure = (error: unknown): Searched =>
      stop.aborted
        ? { kind: "stopped" }
        : { kind: "problem", problem: this.deps.askFailure(error, SEARCH_FAILED).message };
    try {
      if (loop !== undefined) {
        const tools = await openMailTools({
          ...(await this.poolContext(asked, consented, true)),
          store: this.deps.store,
          index: this.deps.index,
          listViews: async () => [],
          tools: ["search_mail", "open_thread"],
          step: (st) => {
            if (st.kind === "search") step(st.query, st.threads);
          },
        });
        try {
          const before = (await settings.get()).limits;
          let run: AgentRunResult;
          try {
            run = await loop.call(
              runtime,
              {
                model: s.models.write,
                ...buildPromptSearchRequest(asked.text, this.deps.now()),
                ...withEffort(effort),
              },
              { signal, server: tools.server, timeoutMs: TALK_LOOP_TIME_MS },
            );
          } catch (error) {
            // A loop that ends badly after it searched keeps what it searched; Stop stays a stop.
            const { queries, opened } = tools.state;
            if (stop.aborted || queries.length === 0) return failure(error);
            return { kind: "found", queries: [...queries], threadIds: [...opened] };
          }
          await this.deps.noteRun(run.limits, before);
          if (stop.aborted) return { kind: "stopped" };
          const answer = parseTalkLoop(run.value);
          const { listed, opened, queries } = tools.state;
          // The threads it named; numbers no search gave are ignored. None: the ones it opened.
          const named = (answer?.threads ?? []).flatMap((n) => listed.get(n) ?? []);
          const threadIds =
            answer !== null && answer.threads.length === 0 ? [] : named.length > 0 ? named : opened;
          return { kind: "found", queries: [...queries], threadIds: [...new Set(threadIds)] };
        } finally {
          await tools.close();
          add(tools.state.sent);
        }
      }
      const check = () => {
        if (stop.aborted) throw new AgentUnavailableError(STOPPED);
      };
      const understand = async (request: AgentRequestBody): Promise<unknown> => {
        const before = (await settings.get()).limits;
        const run = await runtime.run(
          { model: s.models.understand, ...request, ...withEffort(effort) },
          { signal },
        );
        await this.deps.noteRun(run.limits, before);
        check();
        return run.value;
      };
      // ADR 0080: the plan turn sees the prompt as the person's words, today's date and no mail.
      const plan = parseTalkPlan(
        await understand(buildTalkPlanRequest([], asked.text, this.deps.now(), undefined)),
      );
      if (plan === null) return { kind: "problem", problem: SEARCH_FAILED };
      const trail = await followTrail(
        {
          ...(await this.poolContext(asked, consented, true)),
          words: asked.text,
          follow: understand,
          sent: async (perAccount) => add(perAccount),
          step: (st) => {
            if (st.kind === "search") step(st.query, st.threads);
          },
          check,
          over: () => performance.now() - startedAt > cap,
        },
        plan,
      );
      return { kind: "found", queries: trail.queries, threadIds: [...trail.threadIds] };
    } catch (error) {
      return failure(error);
    } finally {
      // Each search counts in the ledger, with the threads whose summaries or text went (rule 9).
      const lines = sent.size > 0 ? [...sent] : [[[...consented].sort()[0] ?? "", 0] as const];
      await this.deps.insights
        .appendLedger(
          lines.map(([accountId, threads]) => ({
            atMs: this.deps.now(),
            runtimeId: runtime.id,
            accountId,
            purpose: "prompt" as const,
            threads,
            ...withEffort(effort),
          })),
        )
        .catch(() => {});
    }
  }

  // --- The verdicts (rule 9) ---

  private async readBatches(
    todo: readonly Candidate[],
    asked: Asked,
    s: AgentSettings,
    consented: ReadonlySet<string>,
    signal: AbortSignal,
    mine: Running,
    options: BatchOptions = {},
  ): Promise<{ rejected: number; answered: readonly string[]; problem?: string }> {
    const { enough, priority = "P0", stopWhen } = options;
    const { runtime, insights, settings } = this.deps;
    const queue = [...todo];
    /** Threads loaded for a batch that did not fit in it wait at the front for the next. */
    const waiting: { c: Candidate; loaded: LoadedThread }[] = [];
    let rejected = 0;
    /** Threads that went in a turn that answered, whether the code accepted the answer or not. */
    const answered: string[] = [];
    let problem: string | undefined;
    // The limit is reached: the turns under way finish and are kept, and none more starts.
    let full = false;
    const halt = new AbortController();
    const turnSignal = AbortSignal.any([signal, halt.signal]);
    const effort = this.deps.effortOf("understand", s);

    const nextBatch = async (): Promise<{ c: Candidate; loaded: LoadedThread }[]> => {
      const batch = waiting.splice(0);
      while (batch.length < MAX_PROMPT_BATCH_THREADS && queue.length > 0) {
        // Taken before the first wait, so the turns that run at once read the best first.
        const claimed = queue.splice(0, MAX_PROMPT_BATCH_THREADS - batch.length);
        for (const c of claimed) {
          const loaded = await this.deps.loadThread(c.threadId, consented);
          if (loaded !== null) batch.push({ c, loaded });
        }
      }
      return batch;
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (turnSignal.aborted || full || stopWhen?.() === true) return;
        const batch = await nextBatch();
        if (batch.length === 0 || turnSignal.aborted) return;
        if (full) {
          // Another turn reached the limit while this batch loaded: it is not sent.
          waiting.unshift(...batch);
          return;
        }
        // Each turn is gated at its priority on the windows the last turn saw (ADR 0051, rule 7):
        // `P0` for what the person asked, `P1` or `P3` in the background (ADR 0117, rule 3).
        const now = await settings.get();
        const gate = mayRun(
          priority,
          now.limits,
          { weekSharePercent: now.weekSharePercent, usedByUsPercent: now.usedByUsPercent },
          this.deps.now(),
        );
        if (!gate.ok) {
          problem ??= USED_UP;
          halt.abort();
          return;
        }
        const candidates: PromptCandidate[] = batch.map((b) => ({
          thread: b.loaded.thread,
          signals: b.c.signals,
        }));
        const { request, sent } = buildPromptRequest(candidates, asked.text, this.deps.now());
        const went = sent.map((i) => batch[i] as (typeof batch)[number]);
        const wentSet = new Set(sent);
        waiting.unshift(...batch.filter((_, i) => !wentSet.has(i)));
        try {
          const before = now.limits;
          const result = await runtime.run(
            { model: s.models.understand, ...request, ...withEffort(effort) },
            { signal: turnSignal },
          );
          await this.deps.noteRun(result.limits, before);
          answered.push(...went.map((b) => b.c.threadId));
          const accepted = acceptVerdicts(
            result.value,
            went.map((b) => ({
              threadId: b.c.threadId,
              lastMessageKey: b.loaded.lastMessageKey,
              thread: b.loaded.thread,
            })),
            { promptKey: asked.key, version: PROMPT_VERSION, atMs: this.deps.now() },
          );
          if (accepted === null) rejected++;
          else await insights.putPromptVerdicts(accepted);
          mine.done += went.length;
          if (
            enough?.(
              went.map((b) => b.c.threadId),
              accepted ?? [],
            ) === true
          ) {
            full = true;
          }
          this.progress(mine, false);
        } catch (error) {
          if (turnSignal.aborted) return;
          if (isAgentRunError(error) && error.code === "limit") problem ??= USED_UP;
          else if (
            isAgentRunError(error) &&
            (error.code === "notSignedIn" ||
              error.code === "notPlan" ||
              error.code === "effortRefused")
          ) {
            problem ??= this.deps.askFailure(error, FAILED).message;
          } else problem ??= FAILED;
          halt.abort();
          return;
        } finally {
          // What went is counted whether or not it worked: counts per account, no text (rule 9).
          const perAccount = new Map<string, number>();
          for (const b of went) {
            perAccount.set(b.loaded.accountId, (perAccount.get(b.loaded.accountId) ?? 0) + 1);
          }
          await insights.appendLedger(
            [...perAccount].map(([accountId, threads]) => ({
              atMs: this.deps.now(),
              runtimeId: runtime.id,
              accountId,
              purpose: "prompt" as const,
              threads,
              ...withEffort(effort),
            })),
          );
        }
      }
    };

    await Promise.all(Array.from({ length: MAX_PARALLEL_TURNS }, () => worker()));
    return { rejected, answered, ...(problem === undefined ? {} : { problem }) };
  }

  /** Rule 12: prompts no saved view holds, not run for `PROMPT_KEEP_DAYS`, go. Never fails a run. */
  private async prune(): Promise<void> {
    try {
      const views = (await this.deps.views?.list()) ?? [];
      const keep = views.flatMap((v) => {
        const p = parseQuery(v.query).prompt;
        return p === undefined ? [] : [promptKey(p.text, sha256Hex)];
      });
      await this.deps.insights.prunePromptVerdicts(
        keep,
        this.deps.now() - PROMPT_KEEP_DAYS * DAY_MS,
      );
    } catch {
      // What is kept a while longer costs only room.
    }
  }

  private progress(mine: Running, finished: boolean): void {
    this.deps.onProgress?.({
      promptKey: mine.key,
      phase: mine.phase,
      done: mine.done,
      total: mine.total,
      ...(mine.step === undefined ? {} : { step: mine.step }),
      ...(mine.fits === undefined ? {} : { fits: mine.fits }),
      finished,
      ...(mine.background === true ? { background: true as const } : {}),
    });
  }

  // --- In the background (ADR 0117, rule 3) ---

  /**
   * Waits for the reading in the background, if one goes on: with a run of the person's set, it
   * starts nothing more, and the turns it sent answer and are kept.
   */
  private async joinBackground(): Promise<void> {
    await this.back?.done.catch(() => {});
  }

  /**
   * Reads new mail for the saved views that hold a prompt and were run at least once (ADR 0117,
   * rule 3). For each such view, with no model: its candidates as a return visit finds them (the
   * mail filters' whole match, or what its kept queries match under the filters), of those the
   * ones a run would read now (`promptWindow`: so never more than the foreground would, a
   * `limit:` included), and of those the ones with mail newer than the view's last reading, less
   * `recentDays` for mail that comes late. At most `PROMPT_ASK_ABOVE` of them per view and pass,
   * the last days first at `P1`, the rest at `P3`. It never searches and never asks: a kept
   * whole match that grew past the line stands no more, and waits for the person. The last
   * reading moves on only when every new thread was read. Never runs beside a run the person
   * started; AI being on, consent, the runtime and the pause are the caller's gates, and are
   * checked again here where they can change.
   */
  async readInBackground(options: BackgroundOptions): Promise<void> {
    if (this.running !== null || this.back !== null || this.deps.views === undefined) return;
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.back = { done };
    try {
      await this.backgroundPass(options);
    } finally {
      this.back = null;
      release();
    }
  }

  private async backgroundPass(options: BackgroundOptions): Promise<void> {
    const views = (await this.deps.views?.list()) ?? [];
    const signal = this.deps.stopAll();
    const over = () => signal.aborted || this.running !== null || options.stopWhen();
    const seen = new Set<string>();
    for (const view of views) {
      if (over()) return;
      if (parseQuery(view.query).prompt === undefined) continue;
      const s = await this.deps.settings.get();
      const consented = await this.consented(s);
      if (consented.size === 0) return;
      const asked = await this.ask(view.query);
      // Two views with the same prompt and filters read once.
      const name = `${asked.key}\n${asked.filters}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const search = await this.deps.insights.getPromptSearch(asked.key, asked.filters);
      // Never run: it stays unread until the person opens it.
      if (search === null) continue;
      const startedAt = this.deps.now();
      const candidates = await this.candidatesOf(asked, search, consented);
      if (candidates === null || over()) continue;
      const ordered = inReadingOrder(candidates, asked.sort);
      const known = await this.known(asked.key, ordered);
      const window = promptWindow(ordered, known, asked.limit, asked.sort);
      const since = (search.readAtMs ?? search.atMs) - options.recentDays * DAY_MS;
      const fresh = window.todo.filter(
        (c) =>
          c.newest.dateMs > since &&
          (this.tried.get(triedKey(asked.key, c)) ?? 0) < BACKGROUND_TRIES,
      );
      if (fresh.length === 0) {
        // Nothing new: the next pass looks from here.
        await this.deps.insights.putPromptSearch({ ...search, readAtMs: startedAt });
        continue;
      }
      const recentSince = startedAt - options.recentDays * DAY_MS;
      const recent = fresh.filter((c) => c.newest.dateMs >= recentSince);
      const older = fresh.filter((c) => c.newest.dateMs < recentSince);
      const take = PROMPT_ASK_ABOVE;
      const groups: [AgentPriority, readonly Candidate[]][] = [
        ["P1", recent.slice(0, take)],
        ["P3", older.slice(0, Math.max(0, take - recent.length))],
      ];
      const mine: Running = {
        key: asked.key,
        filters: asked.filters,
        stop: new AbortController(),
        phase: "reading",
        done: 0,
        total: Math.min(fresh.length, take),
        candidates,
        background: true,
      };
      let complete = fresh.length <= take;
      const answered: string[] = [];
      for (const [priority, todo] of groups) {
        if (todo.length === 0) continue;
        if (over()) {
          complete = false;
          break;
        }
        const outcome = await this.readBatches(todo, asked, s, consented, signal, mine, {
          priority,
          stopWhen: () => this.running !== null || options.stopWhen(),
        });
        answered.push(...outcome.answered);
        if (outcome.problem !== undefined || outcome.rejected > 0 || over()) complete = false;
        // Refused or failed at this priority: the older mail of this view waits for a later pass.
        if (outcome.problem !== undefined) break;
      }
      this.progress(mine, true);
      // A thread a turn went with and did not answer is tried once more, then left until it
      // changes: the background never spends turn after turn on the same thread.
      const read = await this.known(asked.key, fresh);
      const went = new Set(answered);
      for (const c of fresh) {
        if (!went.has(c.threadId) || read.has(c.threadId)) continue;
        const k = triedKey(asked.key, c);
        this.tried.set(k, (this.tried.get(k) ?? 0) + 1);
      }
      while (this.tried.size > MAX_TRIED) {
        const first = this.tried.keys().next().value;
        if (first === undefined) break;
        this.tried.delete(first);
      }
      if (complete) await this.deps.insights.putPromptSearch({ ...search, readAtMs: startedAt });
    }
  }
}
