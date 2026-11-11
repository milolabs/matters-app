// The candidates of a prompt (ADR 0116, rule 4): every thread its kept queries match, ANDed with
// the mail filters, in the accounts with consent, outside Trash and Spam and without what the
// person's rules cover. No cap of ours: each query is walked through the index to its end, window
// by window, and the worker gets its turn between windows. Read best match first: the threads
// the search named, then the ranked pipeline's order (ADR 0081 and 0082), then the rest newest
// first. What is read of the store is kept against its change sequence, so a return with no new
// mail costs one look at the sequence. When the mail filters alone are narrow, there is no search:
// the candidates are everything they match, newest first (`whole`).
import type {
  CandidateMessage,
  CandidateThread,
  Message,
  MessageStorePort,
  ParsedQuery,
  PromptSearch,
  PromptSignals,
  QueryNode,
  SearchIndexPort,
} from "@matters/core";
import {
  fuseRanks,
  isEmptyQuery,
  PROMPT_ASK_ABOVE,
  parseQuery,
  stemQuery,
  talkEligibility,
} from "@matters/core";
import { createTrailPool, type PoolContext } from "./trailPool.ts";

const lower = (s: string) => s.trim().toLowerCase();

/** Keys one window of the walk asks the index for. */
const WALK_WINDOW = 2000;
/** Keys asked of the store at once, for the threads they are in. */
const KEYS_AT_ONCE = 500;
/** The longest the walk holds the worker before it gives other requests their turn. */
const SLICE_MS = 8;
/** More changes than this since the last look: the caches start over, which is cheaper. */
const MAX_CHANGES_FOLLOWED = 2000;
/** Candidate sets kept: the prompts a person goes between. */
const SETS_KEPT = 4;

/** A thread the search found, as far as the code knows it before any verdict. */
export interface PromptCandidateThread {
  readonly threadId: string;
  readonly accountId: string;
  readonly lastMessageKey: number;
  /** The newest message outside Trash and Spam: what the list shows. */
  readonly newest: Message;
  readonly unread: number;
  readonly signals: PromptSignals;
}

/** What the store says of a thread, outside Trash and Spam; nothing of the person's rules yet. */
interface Facts {
  readonly accountId: string;
  readonly lastMessageKey: number;
  readonly newest: Message;
  readonly unread: number;
  readonly signals: PromptSignals;
  readonly messages: readonly CandidateMessage[];
  readonly keys: readonly number[];
}

export interface CandidateDeps {
  readonly store: Pick<MessageStorePort, "getThread" | "getByKeys" | "changesSince">;
  readonly index: PoolContext["index"] & Pick<SearchIndexPort, "searchChunk" | "matchesAmong">;
}

export interface CandidateAsk {
  /** The prompt's key and its mail filters as text: what the set is kept under. */
  readonly key: string;
  readonly filters: string;
  /** The query as parsed: its tree is the mail filters. */
  readonly parsed: ParsedQuery;
  readonly search: Pick<PromptSearch, "queries" | "threadIds" | "atMs" | "whole">;
  /** The pipeline's context, with the filters in `within`; its consent and rules are the ones used. */
  readonly ctx: PoolContext;
}

/** Newest first; the key and then the id decide a tie, so the order never depends on the store. */
function sortNewest(list: PromptCandidateThread[]): PromptCandidateThread[] {
  return list.sort(
    (a, b) =>
      b.newest.dateMs - a.newest.dateMs ||
      b.lastMessageKey - a.lastMessageKey ||
      (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
  );
}

/** Gives the worker its turn when the walk has held it for `SLICE_MS`. */
function pacer(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
}

export class PromptCandidates {
  private readonly deps: CandidateDeps;
  /** The change sequence the caches below hold for; null before the first look. */
  private seq: number | null = null;
  /** Bumped whenever something cached is let go: a read begun before it is not kept. */
  private generation = 0;
  private readonly facts = new Map<string, Facts | null>();
  private readonly threadOfKey = new Map<number, string>();
  private readonly sets = new Map<
    string,
    {
      readonly stamp: string;
      readonly seq: number;
      readonly list: PromptCandidateThread[] | null;
    }
  >();

  constructor(deps: CandidateDeps) {
    this.deps = deps;
  }

  /**
   * Every candidate of a kept search, best first (rule 4). The same mail gives the same list, so
   * coming back with nothing new reads nothing. Null for a `whole` search whose filters now match
   * more than `PROMPT_ASK_ABOVE` threads: it no longer stands, and a search runs instead.
   */
  async of(ask: CandidateAsk): Promise<PromptCandidateThread[] | null> {
    const seq = await this.sync();
    const { ctx } = ask;
    const stamp = JSON.stringify([
      ask.search.queries,
      ask.search.threadIds,
      ask.search.atMs,
      ask.search.whole === true,
      [...ctx.consented].sort(),
      ctx.rules,
      ctx.accounts.map((a) => a.address),
    ]);
    const name = `${ask.key}\n${ask.filters}`;
    const kept = this.sets.get(name);
    if (kept !== undefined && kept.stamp === stamp && kept.seq === seq) return kept.list;
    const list =
      ask.search.whole === true ? await this.whole(ask, PROMPT_ASK_ABOVE) : await this.compute(ask);
    this.sets.delete(name);
    this.sets.set(name, { stamp, seq, list });
    while (this.sets.size > SETS_KEPT) {
      const oldest = this.sets.keys().next().value;
      if (oldest === undefined) break;
      this.sets.delete(oldest);
    }
    return list;
  }

  /** Lets go of what changed since the last look; returns the sequence now. */
  private async sync(): Promise<number> {
    const { store } = this.deps;
    if (this.seq === null) {
      this.seq = (await store.changesSince(Number.MAX_SAFE_INTEGER)).changeSeq;
      return this.seq;
    }
    const changes = await store.changesSince(this.seq);
    if (changes.changeSeq === this.seq) return this.seq;
    const touched = changes.changedKeys.length + changes.removedKeys.length;
    this.generation++;
    if (touched > MAX_CHANGES_FOLLOWED) {
      this.facts.clear();
      this.threadOfKey.clear();
    } else {
      const gone = (key: number) => {
        const threadId = this.threadOfKey.get(key);
        if (threadId !== undefined) this.facts.delete(threadId);
        this.threadOfKey.delete(key);
      };
      for (const key of changes.removedKeys) gone(key);
      for (const key of changes.changedKeys) gone(key);
      // A changed message may be new to a thread, or have moved to another one.
      for (let i = 0; i < changes.changedKeys.length; i += KEYS_AT_ONCE) {
        const slice = changes.changedKeys.slice(i, i + KEYS_AT_ONCE);
        for (const m of await store.getByKeys(slice)) this.facts.delete(m.threadId);
      }
    }
    this.seq = changes.changeSeq;
    return this.seq;
  }

  private async factsOf(threadId: string): Promise<Facts | null> {
    if (this.facts.has(threadId)) return this.facts.get(threadId) ?? null;
    const generation = this.generation;
    const view = await this.deps.store.getThread(threadId, { visibleOnly: true });
    const newest = view?.messages.at(-1);
    const facts: Facts | null =
      view === null || view === undefined || newest === undefined
        ? null
        : {
            accountId: view.thread.accountId,
            lastMessageKey: view.thread.lastMessageKey,
            newest,
            unread: view.messages.filter((x) => !x.flags.seen).length,
            signals: {
              unread: view.messages.some((x) => !x.flags.seen),
              starred: view.messages.some((x) => x.flags.flagged),
              answered: view.messages.some((x) => x.flags.answered),
              messages: view.messages.length,
            },
            messages: view.messages.map((x) => ({
              from: lower(x.from.address),
              ...(x.automated === undefined ? {} : { automated: x.automated }),
            })),
            keys: view.messages.map((x) => x.key),
          };
    // What changed while it was read is not kept: the next look reads it again.
    if (generation === this.generation) {
      this.facts.set(threadId, facts);
      for (const key of facts?.keys ?? []) this.threadOfKey.set(key, threadId);
    }
    return facts;
  }

  /** The threads of these keys, through what is known; the rest from the store. */
  private async threadsOf(keys: readonly number[], pace: () => Promise<void>): Promise<string[]> {
    const out = new Set<string>();
    const unknown: number[] = [];
    for (const key of keys) {
      const threadId = this.threadOfKey.get(key);
      if (threadId === undefined) unknown.push(key);
      else out.add(threadId);
    }
    for (let i = 0; i < unknown.length; i += KEYS_AT_ONCE) {
      const generation = this.generation;
      for (const m of await this.deps.store.getByKeys(unknown.slice(i, i + KEYS_AT_ONCE))) {
        out.add(m.threadId);
        if (generation === this.generation) this.threadOfKey.set(m.key, m.threadId);
      }
      await pace();
    }
    return [...out];
  }

  /**
   * Everything the mail filters match (rule 4), newest first, or null as soon as more than `max`
   * threads are eligible: the walk stops there. No filters: null.
   */
  async whole(
    ask: Pick<CandidateAsk, "parsed" | "ctx">,
    max: number,
  ): Promise<PromptCandidateThread[] | null> {
    const { parsed, ctx } = ask;
    if (parsed.root === null) return null;
    const pace = pacer();
    // Consent is held to per thread (`take`), as in `compute`.
    const root = parsed.root;
    const seen = new Set<string>();
    const out: PromptCandidateThread[] = [];
    let before: number | undefined;
    for (;;) {
      const chunk = await this.deps.index.searchChunk(
        { root, tokens: [], diagnostics: [] },
        { limit: WALK_WINDOW, ...(before === undefined ? {} : { beforeKey: before }) },
      );
      // Keys come newest first, so the threads do too, by their newest match.
      for (const threadId of await this.threadsOf(chunk.keys, pace)) {
        await this.take(threadId, ctx, seen, out);
        if (out.length > max) return null;
      }
      await pace();
      if (chunk.nextBeforeKey === undefined) break;
      before = chunk.nextBeforeKey;
    }
    return sortNewest(out);
  }

  /** The thread as a candidate into `into`, once, if consent and the person's rules let it. */
  private async take(
    threadId: string,
    ctx: PoolContext,
    seen: Set<string>,
    into: PromptCandidateThread[],
  ): Promise<void> {
    if (seen.has(threadId)) return;
    seen.add(threadId);
    const facts = await this.factsOf(threadId);
    if (facts === null || !ctx.consented.has(facts.accountId)) return;
    const own = ctx.accounts.map((a) => lower(a.address));
    const thread: CandidateThread = {
      threadId,
      accountId: facts.accountId,
      lastMessageKey: facts.lastMessageKey,
      lastDateMs: facts.newest.dateMs,
      lastFromOwn: own.includes(lower(facts.newest.from.address)),
      subject: facts.newest.subject,
      messages: facts.messages,
    };
    // What the person's rules cover never goes to a model.
    if (talkEligibility(thread, { ownAddresses: own, rules: ctx.rules }) === "rule") return;
    into.push({
      threadId,
      accountId: facts.accountId,
      lastMessageKey: facts.lastMessageKey,
      newest: facts.newest,
      unread: facts.unread,
      signals: facts.signals,
    });
  }

  private async compute(ask: CandidateAsk): Promise<PromptCandidateThread[]> {
    const { ctx, search, parsed } = ask;
    const { index } = this.deps;
    const pace = pacer();

    // The ranked part: what the pipeline lists, in its order (ADR 0081 and 0082).
    const pool = createTrailPool(ctx);
    if (search.queries.length > 0) {
      await pool.runRound(search.queries);
      await pool.refresh();
    }
    const ranked = [
      ...pool.shown().map((c) => c.summary.threadId),
      ...fuseRanks(pool.lists).map((t) => t.threadId),
    ];

    // The threads the search named, held to the mail filters as they match now (an `is:unread`
    // one may not).
    const named: string[] = [];
    for (const threadId of search.threadIds) {
      const facts = await this.factsOf(threadId);
      if (facts === null) continue;
      if (parsed.root !== null) {
        const matching = await index.matchesAmong(parsed, facts.keys);
        if (matching.length === 0) continue;
      }
      named.push(threadId);
    }

    // The whole match set of every kept query: each walked to its end (rule 4).
    const accounts = ctx.accounts.map((a) => ({
      id: a.id,
      address: a.address,
      displayName: a.displayName,
    }));
    const walked = new Set<string>();
    for (const query of search.queries) {
      const q = parseQuery(query, { nowMs: ctx.nowMs, accounts });
      // As the pipeline drops it (trailPool `runRound`): nothing it did not run is walked.
      if (isEmptyQuery(q) || q.diagnostics[0] !== undefined) continue;
      const stemmed = stemQuery(q).root as QueryNode;
      // Consent is held to per thread below: an `account:` term here makes the index walk
      // window by window over time, some thirty times slower on a large match set.
      const root: QueryNode =
        parsed.root === null ? stemmed : { kind: "and", children: [stemmed, parsed.root] };
      let before: number | undefined;
      for (;;) {
        const chunk = await index.searchChunk(
          { root, tokens: [], diagnostics: [] },
          { limit: WALK_WINDOW, ...(before === undefined ? {} : { beforeKey: before }) },
        );
        for (const threadId of await this.threadsOf(chunk.keys, pace)) walked.add(threadId);
        await pace();
        if (chunk.nextBeforeKey === undefined) break;
        before = chunk.nextBeforeKey;
      }
    }

    // Each thread once, held to consent and the person's rules, best first.
    const seen = new Set<string>();
    const first: PromptCandidateThread[] = [];
    const rest: PromptCandidateThread[] = [];
    for (const threadId of [...named, ...ranked]) {
      await this.take(threadId, ctx, seen, first);
      await pace();
    }
    for (const threadId of walked) {
      await this.take(threadId, ctx, seen, rest);
      await pace();
    }
    return [...first, ...sortNewest(rest)];
  }
}
