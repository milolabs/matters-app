import type { SeenIntent } from "../domain/seen.ts";
import { SEEN_PUSH_DELAY_MS } from "../domain/seen.ts";
import type {
  FlagOutboxPort,
  MessageStorePort,
  SetSeenResult,
  UnitOfWorkPort,
} from "../ports/index.ts";

export interface SetSeenDeps {
  readonly store: Pick<MessageStorePort, "getByKeys" | "setSeen">;
  readonly flagOps: Pick<FlagOutboxPort, "put">;
  readonly uow: UnitOfWorkPort;
  now(): number;
}

/**
 * Mark messages read or unread (ADR 0039, ADR 0007 rule 4). The local flag and the request for
 * the server commit together, so a crash never leaves one without the other. A message that
 * already has the state is left alone, and so is its pending request: that one wants the same.
 * Sets a second request for a message with one pending: the newer wins and the first
 * `previousSeen`, the state the server has, is kept.
 */
export function setSeen(
  deps: SetSeenDeps,
  keys: readonly number[],
  seen: boolean,
): Promise<SetSeenResult> {
  const wanted = [...new Set(keys)];
  return deps.uow.run(async () => {
    const before = await deps.store.getByKeys(wanted);
    const result = await deps.store.setSeen(wanted, seen);
    if (result.changedKeys.length === 0) return result;
    const changed = new Set(result.changedKeys);
    const at = deps.now();
    await deps.flagOps.put(
      before
        .filter((m) => changed.has(m.key))
        .map((m) => ({
          key: m.key,
          accountId: m.accountId,
          seen,
          previousSeen: m.flags.seen,
          nextAttemptMs: at + SEEN_PUSH_DELAY_MS,
          createdAtMs: at,
        })),
    );
    return result;
  });
}

export interface ReapplySeenDeps {
  readonly store: Pick<MessageStorePort, "setSeen">;
  readonly flagOps: Pick<FlagOutboxPort, "listPending">;
}

/**
 * Puts the pending requests of an account back over what a sync just wrote, so a batch built
 * from the server's older state can never undo a change the server has not got yet. Call at the
 * end of the batch's unit of work. The pending set is normally empty: one read, no write; and a
 * message that already has the wanted state is not touched, so nothing is announced for it.
 * Returns the keys that had to be put back.
 */
export async function reapplyPendingSeen(
  deps: ReapplySeenDeps,
  accountId: string,
): Promise<readonly number[]> {
  const pending = await deps.flagOps.listPending(accountId);
  if (pending.length === 0) return [];
  const restored: number[] = [];
  for (const seen of [true, false]) {
    const keys = pending.filter((p) => p.seen === seen).map((p) => p.key);
    if (keys.length > 0) restored.push(...(await deps.store.setSeen(keys, seen)).changedKeys);
  }
  return restored;
}

export interface SettleSeenDeps {
  readonly store: Pick<MessageStorePort, "setSeen">;
  readonly flagOps: Pick<FlagOutboxPort, "settle">;
  readonly uow: UnitOfWorkPort;
}

/**
 * The server has the requests, or there is nothing to push them to (no copy on the server, the
 * account is gone, a demo account without a password): delete them, unless a newer request
 * replaced one meanwhile. The local flag stays as it is.
 */
export async function finishSeen(
  deps: Pick<SettleSeenDeps, "flagOps" | "uow">,
  intents: readonly SeenIntent[],
): Promise<void> {
  if (intents.length === 0) return;
  await deps.uow.run(() => deps.flagOps.settle(intents));
}

/**
 * The server refused for good (a read-only folder): it wins. The requests go, and each message
 * gets back the state it had before them, with a change of its own, because the server will
 * never report a change that did not happen there. A message with a newer request is left alone.
 */
export async function rejectSeen(
  deps: SettleSeenDeps,
  intents: readonly SeenIntent[],
): Promise<readonly number[]> {
  if (intents.length === 0) return [];
  return deps.uow.run(async () => {
    const current = await deps.flagOps.settle(intents);
    const restored: number[] = [];
    for (const seen of [true, false]) {
      const keys = current.filter((i) => i.previousSeen === seen).map((i) => i.key);
      if (keys.length > 0) restored.push(...(await deps.store.setSeen(keys, seen)).changedKeys);
    }
    return restored;
  });
}
