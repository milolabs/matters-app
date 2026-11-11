import type { Message } from "../domain/entities.ts";
import type { AccountStorePort, MessageStorePort, SearchIndexPort } from "../ports/index.ts";
import { isEmptyQuery, parseQuery } from "./parseQuery.ts";
import {
  cutAtFloor,
  fromCursor,
  limitedQuery,
  limitFloor,
  listLimit,
  listOrder,
  nextCursor,
} from "./queryLimit.ts";

export interface SearchDeps {
  readonly index: Pick<SearchIndexPort, "searchChunk">;
  readonly store: Pick<MessageStorePort, "getByKeys">;
  /** For `account:` and `from:me`. */
  readonly accounts: Pick<AccountStorePort, "list">;
  /** The "now" of relative dates. */
  readonly now?: () => number;
}

export interface SearchMessagesOptions {
  readonly limit: number;
  /** The cursor of a newest-first list. */
  readonly beforeKey?: number;
  /** The cursor of an oldest-first list (`sort:oldest`, ADR 0116, rule 4b). */
  readonly afterKey?: number;
}

export interface SearchMessagesResult {
  /** Newest first, or oldest first under `sort:oldest`. */
  readonly messages: readonly Message[];
  /** Pass as `beforeKey` for the next chunk; absent on the last. A chunk may be short or empty. */
  readonly nextBeforeKey?: number;
  /** The same for an oldest-first list, as `afterKey`. */
  readonly nextAfterKey?: number;
}

const MAX_LIMIT = 500;

export async function searchMessages(
  deps: SearchDeps,
  input: string,
  options: SearchMessagesOptions,
): Promise<SearchMessagesResult> {
  const accounts = await deps.accounts.list();
  const parsed = parseQuery(input, {
    nowMs: (deps.now ?? Date.now)(),
    accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
  });
  // ADR 0116, rule 4a: `limit:` (without a prompt) lists at most that many, the first in the
  // order of `sort:` (rule 4b): the newest, or the oldest.
  const cap = listLimit(parsed);
  const order = listOrder(parsed);
  const query = limitedQuery(parsed);
  if (isEmptyQuery(query)) return { messages: [] };

  const limit = Math.min(Math.max(Math.trunc(options.limit) || 1, 1), MAX_LIMIT);
  const cursor = order === "oldest" ? options.afterKey : options.beforeKey;
  const window = await deps.index.searchChunk(query, { limit, ...fromCursor(cursor, order) });
  // The first window often holds the floor itself; otherwise it is walked to (its keys only).
  const floor =
    cap === undefined
      ? undefined
      : cursor === undefined && window.keys.length >= cap
        ? window.keys[cap - 1]
        : await limitFloor(deps.index, query, cap, order);
  const chunk = cap === undefined ? window : cutAtFloor(window, floor, order);
  const messages = await deps.store.getByKeys(chunk.keys);
  const next = nextCursor(chunk, order);
  if (next === undefined) return { messages };
  return order === "oldest" ? { messages, nextAfterKey: next } : { messages, nextBeforeKey: next };
}
