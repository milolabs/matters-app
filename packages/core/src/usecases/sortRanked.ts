/**
 * ADR 0116, rule 4b: the ranked order of a query without a prompt, `sort:relevance`. A rank needs
 * every hit before its first row, so it is computed over at most `RELEVANCE_POOL` matches, the
 * newest, and only when the person asks (`↵`): while typing, the list shows the dated order. One
 * row per thread, as the agent's ranking counts threads.
 */
import type { Message } from "../domain/entities.ts";
import { MESSAGE_KEY_SEQ_LIMIT } from "../domain/messageKey.ts";
import { companiesWrittenTo } from "../domain/relation.ts";
import type {
  AccountStorePort,
  MessageStorePort,
  RankedSearchPort,
  SearchIndexPort,
} from "../ports/index.ts";
import { parseQuery, type QueryNode } from "./parseQuery.ts";
import { EVERYTHING, listLimit } from "./queryLimit.ts";
import { BULK_PENALTY, RELATIONSHIP_BOOST, rankQueryThreads } from "./talkTrail.ts";

/** Starting value: the most matches, the newest, a ranked order is computed over. */
export const RELEVANCE_POOL = 2000;
/** Matches past the pool are counted for the status line up to this many; beyond it, `+`. */
export const RANK_COUNT_CAP = 50_000;
/** Keys one window of the count asks for. */
const COUNT_WINDOW = 5000;
/** Keys asked of the store at once. */
const KEYS_AT_ONCE = 500;
/** Ranked hits asked for beyond the pool: hits of the same millisecond as its oldest key. */
const RANK_SLACK = 64;

export interface SortRankedDeps {
  readonly index: Pick<SearchIndexPort, "searchChunk"> & Pick<RankedSearchPort, "searchRanked">;
  readonly store: Pick<MessageStorePort, "getByKeys" | "listWrittenTo">;
  /** For `account:` and `from:me`, and the person's own addresses. */
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly now?: () => number;
}

/** A ranked order as the list shows it. */
export interface SortRanked {
  /** The order computed; null when the query has none to compute (no ranked `sort:`, a prompt). */
  readonly sort: "relevance" | null;
  /** One message per thread, in the order: the best match, then the newest. */
  readonly rows: readonly Message[];
  /** Matches the order was computed over: at most `RELEVANCE_POOL`. */
  readonly pool: number;
  /** Every match, counted up to `RANK_COUNT_CAP`. */
  readonly matches: number;
  /** More than `RANK_COUNT_CAP` match. */
  readonly more?: true;
}

const NONE: SortRanked = { sort: null, rows: [], pool: 0, matches: 0 };
const lower = (s: string) => s.trim().toLowerCase();

/**
 * The newest `RELEVANCE_POOL` matching keys, and how many match in all (counted up to the cap,
 * keys only).
 */
async function poolOf(
  index: SortRankedDeps["index"],
  query: Parameters<SearchIndexPort["searchChunk"]>[0],
): Promise<{ keys: number[]; matches: number; more: boolean }> {
  const keys: number[] = [];
  let matches = 0;
  let before: number | undefined;
  for (;;) {
    const chunk = await index.searchChunk(query, {
      limit: keys.length < RELEVANCE_POOL ? RELEVANCE_POOL - keys.length : COUNT_WINDOW,
      ...(before === undefined ? {} : { beforeKey: before }),
    });
    for (const k of chunk.keys) if (keys.length < RELEVANCE_POOL) keys.push(k);
    matches += chunk.keys.length;
    if (matches > RANK_COUNT_CAP) return { keys, matches: RANK_COUNT_CAP, more: true };
    if (chunk.nextBeforeKey === undefined) return { keys, matches, more: false };
    before = chunk.nextBeforeKey;
  }
}

/** Messages by key, in batches the store takes at once. */
async function messagesOf(
  store: SortRankedDeps["store"],
  keys: readonly number[],
): Promise<Message[]> {
  const out: Message[] = [];
  for (let i = 0; i < keys.length; i += KEYS_AT_ONCE) {
    out.push(...(await store.getByKeys(keys.slice(i, i + KEYS_AT_ONCE))));
  }
  return out;
}

/** One message per thread, the newest of those given first (keys descend with the date). */
function newestPerThread(messages: readonly Message[], skip: ReadonlySet<string>): Message[] {
  const seen = new Set(skip);
  const out: Message[] = [];
  for (const m of [...messages].sort((a, b) => b.key - a.key)) {
    if (seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    out.push(m);
  }
  return out;
}

/**
 * The ranked order of `input` (rule 4b): the agent's ranking of ADR 0081 (bm25 over the fields
 * with weights, a lower place for mail of programs, a higher one for the person's own relations, a
 * mild weight of age) over the pool, held to the pool's keys. `limit:` cuts after the order.
 */
export async function sortRanked(deps: SortRankedDeps, input: string): Promise<SortRanked> {
  const nowMs = (deps.now ?? Date.now)();
  const accounts = await deps.accounts.list();
  const parsed = parseQuery(input, {
    nowMs,
    accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
  });
  const sort = parsed.sort?.value;
  if (parsed.prompt !== undefined || sort !== "relevance") return NONE;
  const cap = listLimit(parsed);
  const root: QueryNode = parsed.root ?? EVERYTHING;
  const query = { ...parsed, root };
  const pool = await poolOf(deps.index, query);
  const inPool = new Set(pool.keys);
  const cut = pool.matches > pool.keys.length;
  const counted = {
    pool: pool.keys.length,
    matches: pool.matches,
    ...(pool.more ? { more: true as const } : {}),
  };
  // The oldest key of the pool as a date bound, so that the rank looks at the pool alone.
  const oldest = pool.keys[pool.keys.length - 1];
  const bounded: QueryNode =
    cut && oldest !== undefined
      ? {
          kind: "and",
          children: [root, { kind: "after", ms: Math.floor(oldest / MESSAGE_KEY_SEQ_LIMIT) }],
        }
      : root;
  const ranked = (
    await deps.index.searchRanked(
      { ...query, root: bounded },
      {
        limit: pool.keys.length + RANK_SLACK,
        automatedPenalty: BULK_PENALTY,
        ownBoost: RELATIONSHIP_BOOST,
      },
    )
  ).filter((m) => inPool.has(m.messageKey));
  const written = await deps.store.listWrittenTo();
  const threads = rankQueryThreads(ranked, {
    nowMs,
    time: "recent",
    own: new Set(accounts.map((a) => lower(a.address))),
    writtenAddresses: written,
    writtenCompanies: companiesWrittenTo(written),
    // The person's own list: no sender is put behind for the sake of variety.
    capSenders: false,
    limit: Number.POSITIVE_INFINITY,
  });
  const best = await messagesOf(
    deps.store,
    threads.map((t) => t.messageKey),
  );
  const byKey = new Map(best.map((m) => [m.key, m] as const));
  const rows = threads.flatMap((t) => {
    const m = byKey.get(t.messageKey);
    return m === undefined ? [] : [m];
  });
  // What the rank did not reach (a match it cannot score) follows, newest first.
  const rest = newestPerThread(
    await messagesOf(
      deps.store,
      pool.keys.filter((k) => !byKey.has(k)),
    ),
    new Set(rows.map((m) => m.threadId)),
  );
  const all = [...rows, ...rest];
  return { sort, rows: cap === undefined ? all : all.slice(0, cap), ...counted };
}
