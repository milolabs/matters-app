import type { AccountStorePort, SearchIndexPort } from "../ports/index.ts";
import { isEmptyQuery, type ParsedQuery, parseQuery } from "./parseQuery.ts";
import { cutAtFloor, limitedQuery, limitFloor, listLimit, listOrder } from "./queryLimit.ts";

export interface CountDeps {
  readonly index: Pick<SearchIndexPort, "searchChunk">;
  /** For `account:` and `from:me`, as in search. */
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly now?: () => number;
}

export interface CountOptions {
  /** The most keys one chunk may hold. */
  readonly cap: number;
  readonly beforeKey?: number;
}

export interface CountResult {
  /** Unread matches in this chunk; may be fewer than `cap` with a cursor still set. */
  readonly count: number;
  /** Ask again below this key; absent when nothing older can match. */
  readonly nextBeforeKey?: number;
}

const MAX_CAP = 500;
/**
 * ADR 0116, rule 4a: up to this `limit:` a badge counts the unread among the newest that many,
 * walking their keys on every window. Above it the walk would cost more than the badge is worth,
 * and the plain count of unread is shown, each window at most the limit.
 */
export const EXACT_LIMIT_COUNT = 5000;

/**
 * Unread messages a query matches, one chunk at a time (ADR 0027). The keys are counted, never
 * loaded: a badge must not cost more than the index window it reads.
 */
export async function countMatches(
  deps: CountDeps,
  input: string,
  options: CountOptions,
): Promise<CountResult> {
  const accounts = await deps.accounts.list();
  const typed = parseQuery(input, {
    nowMs: (deps.now ?? Date.now)(),
    accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
  });
  const cap = listLimit(typed);
  const parsed = limitedQuery(typed);
  if (isEmptyQuery(parsed) || !parsed.root) return { count: 0 };
  // A count of the mail filters alone is not a count of what a view with a prompt shows: no badge
  // (ADR 0116, rule 10).
  if (parsed.prompt !== undefined) return { count: 0 };

  const query: ParsedQuery = {
    ...parsed,
    root: { kind: "and", children: [parsed.root, { kind: "flag", flag: "unread" }] },
  };
  const limit = Math.min(Math.max(Math.trunc(options.cap) || 1, 1), MAX_CAP);
  // The badge ignores the order (rule 4b), but not what `limit:` keeps: the oldest that many
  // under `sort:oldest`. Their newest key is the floor, so the walk starts there, cheaply.
  const oldest = cap !== undefined && cap <= EXACT_LIMIT_COUNT && listOrder(parsed) === "oldest";
  const ceiling = oldest ? await limitFloor(deps.index, parsed, cap, "oldest") : undefined;
  const beforeKey =
    ceiling === undefined
      ? options.beforeKey
      : Math.min(options.beforeKey ?? Number.MAX_SAFE_INTEGER, ceiling + 1);
  const window = await deps.index.searchChunk(query, {
    limit,
    ...(beforeKey === undefined ? {} : { beforeKey }),
  });
  const chunk =
    cap === undefined || oldest
      ? window
      : cap <= EXACT_LIMIT_COUNT
        ? cutAtFloor(window, await limitFloor(deps.index, parsed, cap))
        : { ...window, keys: window.keys.slice(0, cap) };
  return chunk.nextBeforeKey === undefined
    ? { count: chunk.keys.length }
    : { count: chunk.keys.length, nextBeforeKey: chunk.nextBeforeKey };
}
