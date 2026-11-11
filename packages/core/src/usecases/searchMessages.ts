import type { Message } from "../domain/entities.ts";
import type { AccountStorePort, MessageStorePort, SearchIndexPort } from "../ports/index.ts";
import { isEmptyQuery, parseQuery } from "./parseQuery.ts";

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
  readonly beforeKey?: number;
}

export interface SearchMessagesResult {
  /** Newest first. */
  readonly messages: readonly Message[];
  /** Pass as `beforeKey` for the next chunk; absent on the last. A chunk may be short or empty. */
  readonly nextBeforeKey?: number;
}

const MAX_LIMIT = 500;

export async function searchMessages(
  deps: SearchDeps,
  input: string,
  options: SearchMessagesOptions,
): Promise<SearchMessagesResult> {
  const accounts = await deps.accounts.list();
  const query = parseQuery(input, {
    nowMs: (deps.now ?? Date.now)(),
    accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
  });
  if (isEmptyQuery(query)) return { messages: [] };

  const limit = Math.min(Math.max(Math.trunc(options.limit) || 1, 1), MAX_LIMIT);
  const chunk = await deps.index.searchChunk(query, {
    limit,
    ...(options.beforeKey === undefined ? {} : { beforeKey: options.beforeKey }),
  });
  const messages = await deps.store.getByKeys(chunk.keys);
  return chunk.nextBeforeKey === undefined
    ? { messages }
    : { messages, nextBeforeKey: chunk.nextBeforeKey };
}
