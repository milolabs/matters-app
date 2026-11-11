import type { TalkPlanAnswer } from "@matters/core";
import {
  buildTalkFollowRequest,
  firstRoundQueries,
  MAX_FOLLOW_QUERIES,
  MAX_TALK_THREADS,
  MAX_TRAIL_ROUNDS,
  newQueriesOf,
  parseTalkFollow,
  senderKey,
  waitingQueries,
} from "@matters/core";
import { type Candidate, createTrailPool, type PoolContext } from "./trailPool.ts";

/** What the trail needs from the service; the service owns the gates, the ledger and the stop. */
export interface TrailContext extends PoolContext {
  readonly words: string;
  /** Runs a follow turn: counts the plan, checks the stop, returns what the model said. */
  follow(request: ReturnType<typeof buildTalkFollowRequest>): Promise<unknown>;
  /** Counts summaries that went to a model, per account, in the ledger. */
  sent(perAccount: ReadonlyMap<string, number>): Promise<void>;
  step(step: TrailStep): void;
  /** Throws when the person pressed Stop: checked between the steps of the trail. */
  check(): void;
  /** The whole question has taken too long: no more rounds. */
  over(): boolean;
}

/** A line of progress: a query that ran, or what a follow turn decided. */
export type TrailStep =
  | { readonly kind: "search"; readonly query: string; readonly threads: number }
  | { readonly kind: "follow"; readonly note: string; readonly threads: number };

export interface TrailResult {
  /** Candidates worth reading in full, best first, at most `MAX_TALK_THREADS`. */
  readonly threadIds: readonly string[];
  /** Valid queries that ran, in order. */
  readonly queries: readonly string[];
  /** The first valid query: what "show this search in the list" offers. */
  readonly firstQuery: string;
  readonly hypothesis: string;
  /** Queries dropped for a fault, with the diagnostic: not fatal. */
  readonly dropped: readonly { readonly query: string; readonly reason: string }[];
  /** Every query was bad, or nothing was run. */
  readonly nothingRan: boolean;
  /** Summaries of mail that left this machine for the follow turns. */
  readonly summariesSent: number;
}

/** Runs the plan: rounds of queries and follow turns until a model says answer, or there is nothing new. */
export async function followTrail(
  context: TrailContext,
  plan: TalkPlanAnswer,
): Promise<TrailResult> {
  // What the last question read is background unless the new words continue it (ADR 0081).
  const ctx: TrailContext = plan.followsUp ? context : { ...context, carry: undefined };
  const ran = new Set<string>();
  const log: { query: string; threads: number }[] = [];
  const pool = createTrailPool({ ...ctx, time: plan.time });
  const { lists, candidates } = pool;
  let hypothesis = ctx.carry?.hypothesis ?? "";
  let keep: string[] = [];
  let summariesSent = 0;

  if (ctx.carry !== undefined) {
    // What the last question read stays among the candidates, ahead of anything new.
    lists.push(
      ctx.carry.threadIds.map((threadId, i) => ({
        threadId,
        accountId: "",
        messageKey: 0,
        score: 100 - i,
      })),
    );
  }

  /** One round: the pool runs the queries; each valid one is logged and shown as a step. */
  const runRound = (queries: readonly string[]) =>
    pool.runRound(queries, (query, threads) => {
      log.push({ query, threads });
      ctx.step({ kind: "search", query, threads });
    });

  let round = 0;
  let queries = firstRoundQueries(plan, ran);
  for (;;) {
    round++;
    if (queries.length > 0) await runRound(queries);
    ctx.check();
    const before = candidates.size;
    await pool.refresh();
    ctx.check();
    const fresh = candidates.size - before;
    const list = pool.shown();
    const last = round >= MAX_TRAIL_ROUNDS;
    // With no query there is nothing to steer: a list of Matters is read as it is.
    if (log.length === 0 || last || ctx.over() || (round > 1 && fresh === 0)) {
      if (last && keep.length > 0) {
        // The last round has no follow turn after it: what it found joins what was kept.
        const kept = new Set(keep);
        const asked = pool.askedReps();
        const extra = list
          .filter(
            (c) =>
              !kept.has(c.summary.threadId) &&
              (!c.summary.automated || asked.has(c.summary.threadId)),
          )
          .map((c) => c.summary.threadId);
        keep = [...keep, ...extra];
      }
      break;
    }

    // The follow turn: what the candidates look like, and where to look next.
    const perAccount = new Map<string, number>();
    for (const c of list) perAccount.set(c.accountId, (perAccount.get(c.accountId) ?? 0) + 1);
    summariesSent += list.length;
    await ctx.sent(perAccount);
    const raw = await ctx.follow(
      buildTalkFollowRequest({
        words: ctx.words,
        plan,
        ran: log,
        candidates: list.map((c) => c.summary),
        hypothesis,
        waiting: waitingQueries(plan, ran),
        roundsLeft: MAX_TRAIL_ROUNDS - round,
        nowMs: ctx.nowMs,
      }),
    );
    // A turn that does not fit the schema steers nothing; the best candidates are read as they are.
    const follow = parseTalkFollow(raw);
    if (follow === null) break;
    const byNumber = new Map([...candidates.values()].map((c) => [c.number, c.summary.threadId]));
    keep = follow.keep.flatMap((n) => byNumber.get(n) ?? []);
    if (follow.hypothesis !== "") hypothesis = follow.hypothesis;
    ctx.step({
      kind: "follow",
      note: follow.decision === "answer" ? hypothesis : (follow.newQueries?.[0] ?? hypothesis),
      threads: keep.length,
    });
    if (follow.decision === "answer") break;
    queries = newQueriesOf(follow.newQueries ?? [], ran, MAX_FOLLOW_QUERIES);
    if (queries.length === 0) break;
  }

  // What is read: the model's choice, else the best ranked, programs not asked for left out.
  const order = pool.shown().map((c) => c.summary.threadId);
  const asked = pool.askedReps();
  const chosen =
    keep.length > 0 ? keep : order.filter((id) => !isAutomated(candidates, id) || asked.has(id));
  const threadIds = [...new Set(chosen.length > 0 ? chosen : order)].slice(0, MAX_TALK_THREADS);
  return {
    threadIds,
    queries: log.map((l) => l.query),
    firstQuery: log[0]?.query ?? "",
    hypothesis,
    dropped: pool.dropped,
    nothingRan: log.length === 0 && ctx.carry === undefined,
    summariesSent,
  };
}

function isAutomated(candidates: ReadonlyMap<string, Candidate>, id: string): boolean {
  return candidates.get(id)?.summary.automated === true;
}

export { senderKey };
