import type { AccountStorePort, SearchIndexPort } from "../ports/index.ts";
import { isEmptyQuery, type ParsedQuery, parseQuery } from "./parseQuery.ts";

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
 * Unread messages a query matches, one chunk at a time (ADR 0027). The keys are counted, never
 * loaded: a badge must not cost more than the index window it reads.
 */
export async function countMatches(
  deps: CountDeps,
  input: string,
  options: CountOptions,
): Promise<CountResult> {
  const accounts = await deps.accounts.list();
  const parsed = parseQuery(input, {
    nowMs: (deps.now ?? Date.now)(),
    accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
  });
  if (isEmptyQuery(parsed) || !parsed.root) return { count: 0 };

  const query: ParsedQuery = {
    ...parsed,
    root: { kind: "and", children: [parsed.root, { kind: "flag", flag: "unread" }] },
  };
  const limit = Math.min(Math.max(Math.trunc(options.cap) || 1, 1), MAX_CAP);
  const chunk = await deps.index.searchChunk(query, {
    limit,
    ...(options.beforeKey === undefined ? {} : { beforeKey: options.beforeKey }),
  });
  return chunk.nextBeforeKey === undefined
    ? { count: chunk.keys.length }
    : { count: chunk.keys.length, nextBeforeKey: chunk.nextBeforeKey };
}
