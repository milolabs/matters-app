import type { MessageStorePort, SearchIndexPort } from "../ports/index.ts";
import { isEmptyQuery, parseQuery } from "./parseQuery.ts";
import type { SearchDeps } from "./searchMessages.ts";

export interface SearchThreadsDeps extends Omit<SearchDeps, "index" | "store"> {
  readonly index: Pick<SearchIndexPort, "matchesAmong">;
  readonly store: Pick<MessageStorePort, "getThread">;
}

/**
 * Which of these threads hold a message that matches the query (ADR 0056, rule 2), so a short list
 * answers the same query language as the whole mailbox. `null` when the text constrains nothing.
 * The index is asked once, about the messages of these threads: walking the mailbox in windows made
 * a word of one or two letters cost seconds, and every read waits behind this one.
 */
export async function threadsMatching(
  deps: SearchThreadsDeps,
  input: string,
  threadIds: readonly string[],
): Promise<ReadonlySet<string> | null> {
  const accounts = await deps.accounts.list();
  const query = parseQuery(input, {
    nowMs: (deps.now ?? Date.now)(),
    accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
  });
  if (isEmptyQuery(query)) return null;

  const threadOf = new Map<number, string>();
  for (const id of new Set(threadIds)) {
    const view = await deps.store.getThread(id);
    for (const m of view?.messages ?? []) threadOf.set(m.key, id);
  }
  const keys = await deps.index.matchesAmong(query, [...threadOf.keys()]);
  return new Set(keys.flatMap((key) => threadOf.get(key) ?? []));
}
