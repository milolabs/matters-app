import type { Message } from "@matters/core";

/**
 * Applies a `changes` event to a list that is the newest messages first (a prefix of the whole
 * mailbox unless `complete`). Rows keep their place and identity unless the message changed:
 * removed keys disappear, changed ones are replaced, new ones are inserted by key. A new
 * message older than everything loaded is left out while more pages exist; paging brings it.
 */
export function mergeMessages(
  current: readonly Message[],
  fetched: readonly Message[],
  removed: ReadonlySet<number>,
  complete: boolean,
): readonly Message[] {
  const updated = new Map(fetched.map((m) => [m.key, m]));
  const have = new Set<number>();
  const kept: Message[] = [];
  for (const m of current) {
    if (removed.has(m.key)) continue;
    have.add(m.key);
    kept.push(updated.get(m.key) ?? m);
  }
  const floor = kept.length > 0 ? (kept[kept.length - 1] as Message).key : Number.NEGATIVE_INFINITY;
  const added = fetched
    .filter((m) => !have.has(m.key) && !removed.has(m.key) && (complete || m.key > floor))
    .sort((a, b) => b.key - a.key);
  if (added.length === 0)
    return kept.some((m, i) => m !== current[i]) || kept.length !== current.length ? kept : current;

  const out: Message[] = [];
  let i = 0;
  for (const m of added) {
    while (i < kept.length && (kept[i] as Message).key > m.key) out.push(kept[i++] as Message);
    out.push(m);
  }
  while (i < kept.length) out.push(kept[i++] as Message);
  return out;
}
