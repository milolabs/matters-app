/**
 * ADR 0116, rules 4a and 4b: `limit:` without a prompt is the most messages a query lists, the
 * first along the key in the order of `sort:` (newest by default, or oldest). It is not in the
 * tree: the list and its count apply it here, from the text, so a tree from elsewhere never
 * decides it. With a prompt the limit is the prompt's (that many threads that fit), and the mail
 * filters' list is not cut.
 */
import type { SearchChunk, SearchIndexPort } from "../ports/index.ts";
import type { ParsedQuery, QueryNode } from "./parseQuery.ts";

/** Every message: what `limit:` or `sort:oldest` alone lists. */
export const EVERYTHING: QueryNode = {
  kind: "or",
  children: [
    { kind: "flag", flag: "read" },
    { kind: "flag", flag: "unread" },
  ],
};

/** Which way a dated list walks the key (rule 4b). Ranked orders list by date while typing. */
export type KeyOrder = "newest" | "oldest";

/** The way the dated list of this query walks the key: `oldest` only when it says so. */
export function listOrder(parsed: Pick<ParsedQuery, "sort">): KeyOrder {
  return parsed.sort?.value === "oldest" ? "oldest" : "newest";
}

/** The cap the list of this query has, or undefined: no `limit:`, or it is the prompt's. */
export function listLimit(parsed: Pick<ParsedQuery, "limit" | "prompt">): number | undefined {
  return parsed.prompt === undefined ? parsed.limit?.n : undefined;
}

/** The query a limited or oldest-first list runs: alone, either lists all mail. */
export function limitedQuery(parsed: ParsedQuery): ParsedQuery {
  return parsed.root === null && (listLimit(parsed) !== undefined || listOrder(parsed) === "oldest")
    ? { ...parsed, root: EVERYTHING }
    : parsed;
}

/** The cursor a chunk hands on in this order. */
export function nextCursor(chunk: SearchChunk, order: KeyOrder): number | undefined {
  return order === "oldest" ? chunk.nextAfterKey : chunk.nextBeforeKey;
}

/** The options that go on from `cursor` in this order. */
export function fromCursor(
  cursor: number | undefined,
  order: KeyOrder,
): { readonly beforeKey?: number; readonly afterKey?: number; readonly order?: "oldest" } {
  if (order === "oldest") {
    return cursor === undefined ? { order } : { order, afterKey: cursor };
  }
  return cursor === undefined ? {} : { beforeKey: cursor };
}

/**
 * The key of the `n`th match along the order: what is past it is past the limit. Undefined when
 * fewer match. Keys only, window by window: the cost is the `n` keys it walks.
 */
export async function limitFloor(
  index: Pick<SearchIndexPort, "searchChunk">,
  query: ParsedQuery,
  n: number,
  order: KeyOrder = "newest",
): Promise<number | undefined> {
  let have = 0;
  let cursor: number | undefined;
  for (;;) {
    const chunk = await index.searchChunk(query, { limit: n - have, ...fromCursor(cursor, order) });
    if (have + chunk.keys.length >= n) return chunk.keys[n - have - 1];
    have += chunk.keys.length;
    cursor = nextCursor(chunk, order);
    if (cursor === undefined) return undefined;
  }
}

/**
 * A window cut at the floor: keys past it go, and so does the cursor once it is passed. Newest
 * first, past is below; oldest first, past is above.
 */
export function cutAtFloor(
  chunk: SearchChunk,
  floor: number | undefined,
  order: KeyOrder = "newest",
): SearchChunk {
  if (floor === undefined) return chunk;
  if (order === "oldest") {
    const keys = chunk.keys.filter((k) => k <= floor);
    const next = chunk.nextAfterKey;
    return keys.length < chunk.keys.length || next === undefined || next >= floor
      ? { keys }
      : { keys, nextAfterKey: next };
  }
  const keys = chunk.keys.filter((k) => k >= floor);
  const next = chunk.nextBeforeKey;
  return keys.length < chunk.keys.length || next === undefined || next <= floor
    ? { keys }
    : { keys, nextBeforeKey: next };
}
