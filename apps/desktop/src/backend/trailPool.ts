// The candidate pipeline of a question across all mail (ADR 0080): the queries of a round run
// through the ranked search, the threads found are fused, summarised in a few facts and put in
// the order a reader looks at them. The backend's trail and the evaluation tool share it, so what
// is measured is what the person gets.
import type {
  AgentRule,
  CandidateSummary,
  FusedThread,
  MessageBodyPort,
  MessageStorePort,
  ParsedQuery,
  QueryNode,
  RankedSearchPort,
  RankedThread,
  TalkCarry,
  TalkTime,
  ThreadView,
  WrittenTo,
} from "@matters/core";
import {
  asksForSender,
  BULK_PENALTY,
  type ConversationPart,
  companiesWrittenTo,
  consolidateConversations,
  effectiveSender,
  fragmentAround,
  fuseRanks,
  isEmptyQuery,
  MAX_SEEN_CANDIDATES,
  MAX_THREADS_PER_QUERY,
  orderCandidates,
  parseQuery,
  positiveWords,
  RANKED_MESSAGES,
  RELATIONSHIP_BOOST,
  rankQueryThreads,
  requiresSender,
  stemQuery,
  talkEligibility,
  threadFiles,
} from "@matters/core";
import { textForPrompt } from "./promptText.ts";

const lower = (s: string) => s.trim().toLowerCase();
const DAY_MS = 86_400_000;

/** What the pipeline needs; the trail adds the gates, the ledger and the stop around it. */
export interface PoolContext {
  readonly store: Pick<MessageStorePort, "getThread" | "listWrittenTo">;
  readonly index: RankedSearchPort;
  readonly bodies: Pick<MessageBodyPort, "getBodies" | "getHtml" | "getHtmlKinds">;
  visibleText(html: string): string;
  readonly nowMs: number;
  readonly consented: ReadonlySet<string>;
  readonly accounts: readonly { id: string; address: string; displayName: string }[];
  readonly rules: readonly AgentRule[];
  /** From the plan: threads on the list of Matters in this state; the candidates are limited to them. */
  readonly onlyThreads: ReadonlySet<string> | null;
  readonly olderThanDays: number | undefined;
  /** Threads read for the question before this one. */
  readonly carry: TalkCarry | undefined;
  /** From the plan: how much age weighs (ADR 0081). Default "recent". */
  readonly time?: TalkTime;
  /** Read the passage of the best message of each candidate (the evaluation tool does not). */
  readonly fragments?: boolean;
  /**
   * The mail filters of the query a prompt is in (ADR 0116, rule 4): every query is ANDed with
   * them in code. `root` goes into the search; `among` says which matches they match, so what
   * the search adds on its own (file names) is held to them too. Absent: nothing narrows.
   */
  readonly within?: {
    readonly root: QueryNode;
    among(keys: readonly number[]): Promise<readonly number[]>;
  };
}

export interface Candidate {
  readonly number: number;
  readonly summary: CandidateSummary;
  readonly accountId: string;
}

/** Who the person wrote to changes slowly and costs a pass over their Sent mail: read it once a minute. */
const WRITTEN_TO_AGE_MS = 60_000;
interface Written {
  readonly atMs: number;
  readonly addresses: ReadonlyMap<string, WrittenTo>;
  readonly companies: ReadonlyMap<string, WrittenTo>;
}
const writtenCache = new WeakMap<object, Written>();

async function writtenTo(store: Pick<MessageStorePort, "listWrittenTo">): Promise<Written> {
  const known = writtenCache.get(store);
  if (known !== undefined && Date.now() - known.atMs < WRITTEN_TO_AGE_MS) return known;
  const addresses = await store.listWrittenTo();
  const fresh = { atMs: Date.now(), addresses, companies: companiesWrittenTo(addresses) };
  writtenCache.set(store, fresh);
  return fresh;
}

/** One query that ran: what it found and how long the search took. */
export interface QueryRun {
  readonly query: string;
  readonly threads: number;
  readonly messages: number;
  readonly ms: number;
}

/** Threads summarised in one step of `refresh`, and at most in all. */
const SUMMARY_STEP = 40;
const MAX_SUMMARISED = 240;

export function createTrailPool(ctx: PoolContext) {
  const dropped: { query: string; reason: string }[] = [];
  const lists: RankedThread[][] = [];
  /** Threads a query that requires its sender found by a message from someone else (ADR 0082). */
  const asked = new Set<string>();
  const ranLog: QueryRun[] = [];
  const views = new Map<string, ThreadView | null>();
  const candidates = new Map<string, Candidate>();
  const rejected = new Set<string>();
  /** What a candidate is, for putting the fragments of one conversation together (ADR 0081). */
  const parts = new Map<string, ConversationPart>();
  const words = new Set<string>();
  const own = ctx.accounts.map((a) => lower(a.address));
  const accountNames = ctx.accounts.map((a) => ({
    id: a.id,
    address: a.address,
    displayName: a.displayName,
  }));

  const viewOf = async (threadId: string): Promise<ThreadView | null> => {
    if (!views.has(threadId)) {
      views.set(threadId, await ctx.store.getThread(threadId, { visibleOnly: true }));
    }
    return views.get(threadId) ?? null;
  };

  const textOf = async (view: ThreadView, key: number): Promise<string> => {
    if (ctx.fragments === false) return "";
    const message = view.messages.find((m) => m.key === key) ?? view.messages.at(-1);
    if (message === undefined) return "";
    const [plain, kinds] = await Promise.all([
      ctx.bodies.getBodies([message.key]),
      ctx.bodies.getHtmlKinds([message.key]),
    ]);
    const html = kinds.has(message.key) ? await ctx.bodies.getHtml(message.key) : undefined;
    return textForPrompt({
      text: plain.get(message.key) ?? "",
      ...(html === undefined ? {} : { html }),
      visibleText: ctx.visibleText,
    });
  };

  /** A candidate, or null when the thread must not be read: no consent, a rule, too new. */
  const summarize = async (hit: FusedThread, number: number): Promise<Candidate | null> => {
    const view = await viewOf(hit.threadId);
    const last = view?.messages.at(-1);
    if (view === null || last === undefined || !ctx.consented.has(view.thread.accountId)) {
      return null;
    }
    if (ctx.olderThanDays !== undefined && last.dateMs > ctx.nowMs - ctx.olderThanDays * DAY_MS) {
      return null;
    }
    const thread = {
      threadId: hit.threadId,
      accountId: view.thread.accountId,
      lastMessageKey: view.thread.lastMessageKey,
      lastDateMs: last.dateMs,
      lastFromOwn: own.includes(lower(last.from.address)),
      subject: last.subject,
      messages: view.messages.map((m) => ({
        from: lower(m.from.address),
        ...(m.automated === undefined ? {} : { automated: m.automated }),
      })),
    };
    const eligibility = talkEligibility(thread, { ownAddresses: own, rules: ctx.rules });
    if (eligibility === "rule") return null;
    const fromMessage =
      [...view.messages].reverse().find((m) => !own.includes(lower(m.from.address))) ?? last;
    // A service that relays for a person is shown as the person, via the service (ADR 0081).
    const written = await writtenTo(ctx.store);
    const relayed = effectiveSender(
      fromMessage.from.address,
      fromMessage.replyTo?.[0]?.address,
      fromMessage.senderAuth,
      written,
    );
    const behind = fromMessage.replyTo?.find((p) => lower(p.address) === relayed);
    const from =
      relayed !== lower(fromMessage.from.address) && behind !== undefined
        ? {
            address: behind.address,
            name: `${behind.name ?? ""} (via ${fromMessage.from.address.split("@")[1] ?? fromMessage.from.address})`.trim(),
          }
        : fromMessage.from;
    const files: string[] = [];
    for (const m of [...view.messages].reverse()) {
      for (const item of view.attachments.get(m.key)?.items ?? []) {
        if (files.length < 3 && !files.includes(item.name)) files.push(item.name);
      }
    }
    const text = await textOf(view, hit.messageKey);
    parts.set(hit.threadId, {
      threadId: hit.threadId,
      accountId: view.thread.accountId,
      subject: view.thread.subject,
      participants: view.messages.flatMap((m) => [m.from, ...m.to, ...m.cc].map((p) => p.address)),
      messages: view.messages.length,
    });
    return {
      number,
      accountId: view.thread.accountId,
      summary: {
        number,
        threadId: hit.threadId,
        subject: view.thread.subject,
        senderName: from.name ?? "",
        senderAddress: from.address,
        dateMs: last.dateMs,
        messages: view.messages.length,
        files,
        fileList: threadFiles(view),
        fragment: fragmentAround(text, [...words]),
        automated: eligibility === "automated",
        earlier: ctx.carry?.threadIds.includes(hit.threadId) ?? false,
      },
    };
  };

  /** Each candidate thread mapped to the thread that stands for its conversation. */
  const conversations = (): Map<string, string> =>
    consolidateConversations([...parts.values()], new Set(own));

  const askedReps = (rep: ReadonlyMap<string, string> = conversations()): Set<string> => {
    const reps = new Set<string>();
    for (const [threadId, repId] of rep) if (asked.has(threadId)) reps.add(repId);
    for (const id of asked) if (!rep.has(id)) reps.add(id);
    return reps;
  };

  return {
    /** The ranked lists, one per query, in the order they were added. */
    lists,
    /** Every valid query that ran. */
    ran: ranLog,
    dropped,
    candidates,

    /**
     * Summarises the best threads not yet seen, until the conversations among them fill the list
     * the models are shown: fragments of one conversation count once (ADR 0081). Returns how many
     * candidates are new.
     */
    async refresh(): Promise<number> {
      const fused = fuseRanks(lists).filter(
        (t) => ctx.onlyThreads === null || ctx.onlyThreads.has(t.threadId),
      );
      let added = 0;
      let at = 0;
      while (at < fused.length && at < MAX_SUMMARISED) {
        for (const hit of fused.slice(at, at + SUMMARY_STEP)) {
          if (candidates.has(hit.threadId) || rejected.has(hit.threadId)) continue;
          const made = await summarize(hit, candidates.size + 1);
          if (made === null) rejected.add(hit.threadId);
          else {
            candidates.set(hit.threadId, made);
            added++;
          }
        }
        at += SUMMARY_STEP;
        if (new Set(conversations().values()).size >= MAX_SEEN_CANDIDATES + 20) break;
      }
      return added;
    },

    /** The threads that stand for a conversation holding a thread that was asked for (ADR 0082). */
    askedReps,

    /** The thread that stands for the conversation of this one; itself when it is alone or unknown. */
    repOf(threadId: string): string {
      return conversations().get(threadId) ?? threadId;
    },

    /**
     * The candidates in the order a reader looks at them: one per conversation, at the place of
     * its best-ranked fragment; the sender cap and programs behind, unless asked for (ADR 0082).
     */
    shown(): Candidate[] {
      const fused = fuseRanks(lists);
      const rank = new Map(fused.map((t, i) => [t.threadId, i]));
      const place = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
      const rep = conversations();
      const best = new Map<string, number>();
      for (const c of candidates.values()) {
        const r = rep.get(c.summary.threadId) ?? c.summary.threadId;
        best.set(r, Math.min(best.get(r) ?? Number.MAX_SAFE_INTEGER, place(c.summary.threadId)));
      }
      const list = [...candidates.values()]
        .filter((c) => (rep.get(c.summary.threadId) ?? c.summary.threadId) === c.summary.threadId)
        .sort(
          (a, b) =>
            (best.get(a.summary.threadId) ?? Number.MAX_SAFE_INTEGER) -
            (best.get(b.summary.threadId) ?? Number.MAX_SAFE_INTEGER),
        );
      const reps = askedReps(rep);
      return orderCandidates(list, (c) => ({
        sender: c.summary.senderAddress,
        automated: c.summary.automated,
        asked: reps.has(c.summary.threadId),
      })).slice(0, MAX_SEEN_CANDIDATES);
    },

    /** The 1-based place of the first candidate of `shown` that stands for one of these threads. */
    rankOf(threadIds: ReadonlySet<string>, shown: readonly Candidate[]): number | null {
      const reps = new Set([...threadIds].map((id) => conversations().get(id) ?? id));
      const at = shown.findIndex((c) => reps.has(c.summary.threadId));
      return at < 0 ? null : at + 1;
    },

    /** One round: every query at once through the ranked search. A bad query is dropped, not fatal. */
    async runRound(
      queries: readonly string[],
      onRan?: (query: string, threads: number) => void,
    ): Promise<void> {
      const written = await writtenTo(ctx.store);
      const search = async (query: string, parsed: ParsedQuery) => {
        // The agent's words tolerate inflection; the person's own search does not (ADR 0081).
        const stemmed = stemQuery(parsed);
        const within = ctx.within;
        const t0 = performance.now();
        // The person's filters are ANDed after the stemming: their own words are not inflected.
        const ranked = await ctx.index.searchRanked(
          within === undefined || stemmed.root === null
            ? stemmed
            : { ...stemmed, root: { kind: "and", children: [stemmed.root, within.root] } },
          {
            limit: RANKED_MESSAGES,
            accountIds: [...ctx.consented],
            automatedPenalty: BULK_PENALTY,
            ownBoost: RELATIONSHIP_BOOST,
          },
        );
        const matching =
          within === undefined
            ? null
            : new Set(await within.among([...new Set(ranked.map((m) => m.messageKey))]));
        const found = matching === null ? ranked : ranked.filter((m) => matching.has(m.messageKey));
        const ms = performance.now() - t0;
        const threads = rankQueryThreads(found, {
          nowMs: ctx.nowMs,
          time: ctx.time ?? "recent",
          own: new Set(own),
          writtenAddresses: written.addresses,
          writtenCompanies: written.companies,
          capSenders: !asksForSender(parsed.root),
          limit: MAX_THREADS_PER_QUERY,
        });
        // Threads in which a person other than the one asking wrote what the query requires.
        const kept = new Set(threads.map((t) => t.threadId));
        const asking = new Set<string>();
        if (requiresSender(parsed.root)) {
          for (const m of found) {
            if (!kept.has(m.threadId)) continue;
            if (!(m.fromMe === true || own.includes(m.sender ?? ""))) asking.add(m.threadId);
          }
        }
        return { query, parsed, threads, asked: [...asking], messages: found.length, ms };
      };
      // One after the other: the searches are synchronous work, and each is timed on its own.
      const results = [];
      for (const query of queries) {
        const parsed = parseQuery(query, { nowMs: ctx.nowMs, accounts: accountNames });
        const fault = parsed.diagnostics[0];
        if (isEmptyQuery(parsed) || fault !== undefined) {
          dropped.push({ query, reason: fault?.message ?? "Nothing to search for" });
          continue;
        }
        results.push(await search(query, parsed));
      }
      for (const r of results) {
        for (const w of positiveWords(r.parsed.root)) words.add(w);
        lists.push(r.threads);
        for (const id of r.asked) asked.add(id);
        ranLog.push({ query: r.query, threads: r.threads.length, messages: r.messages, ms: r.ms });
        onRan?.(r.query, r.threads.length);
      }
    },
  };
}

export type TrailPool = ReturnType<typeof createTrailPool>;
