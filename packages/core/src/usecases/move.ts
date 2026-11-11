import type { Message, MessageLocation } from "../domain/entities.ts";
import { hasRole, isHiddenMailbox } from "../domain/mailbox.ts";
import {
  decodeTarget,
  encodeTarget,
  MOVE_UNDO_WINDOW_MS,
  type MoveAction,
  type MoveOperation,
  type MoveTarget,
  type NewMoveOperation,
  planMove,
  resolvePlace,
  targetOf,
} from "../domain/move.ts";
import type {
  MessageBodyPort,
  MessageStorePort,
  MoveOutboxPort,
  SearchIndexPort,
  SetPlacementResult,
  UnitOfWorkPort,
} from "../ports/index.ts";

export interface MoveDeps {
  readonly store: Pick<MessageStorePort, "getThread" | "listFolders" | "setPlacement">;
  readonly moveOps: Pick<MoveOutboxPort, "put">;
  readonly uow: UnitOfWorkPort;
  readonly now: () => number;
  readonly newId: () => string;
  /** The undo window; default `MOVE_UNDO_WINDOW_MS`. Only tests change it. */
  readonly windowMs?: number;
}

export interface MoveThreadInput {
  readonly threadId: string;
  /** More threads moved with it as one action: one line in the tray, one Undo (ADR 0056, rule 6). */
  readonly others?: readonly string[];
  readonly action: MoveAction;
  /** Only for `move`: the other actions have a target of their own. */
  readonly target?: MoveTarget;
  /**
   * The thread is being looked at from Trash or Spam: its messages there are shown, and so they
   * are taken too. Otherwise messages in Trash and Spam stay where they are, so a deleted message
   * never comes back with the thread it was part of.
   */
  readonly hidden?: boolean;
}

export interface MoveThreadResult {
  /** What ⌘Z takes back; null when there was nothing to move (ADR 0044, rule 5). */
  readonly operationId: string | null;
  /** The messages that moved. */
  readonly keys: readonly number[];
  /** The change sequence of the write; unchanged when nothing moved. */
  readonly changeSeq: number;
}

const held = (m: Message) => ({ labelIds: m.labelIds, mailboxes: m.mailboxes ?? 0 });

/**
 * Moves a thread to a target (ADR 0044, rule 5): archive, delete, spam, or a folder. The local
 * labels and mailboxes change and the request for the server is stored in one unit of work, so a
 * crash leaves neither or both. The request is not due until the undo window is over (rule 10).
 * Messages that are already at the target, and Sent and Drafts when the action leaves them, are
 * left alone; a second request for a message replaces the first and keeps its "before".
 */
export function moveThread(deps: MoveDeps, input: MoveThreadInput): Promise<MoveThreadResult> {
  return deps.uow.run(async () => {
    const plans: { message: Message; plan: NonNullable<ReturnType<typeof planMove>> }[] = [];
    for (const threadId of new Set([input.threadId, ...(input.others ?? [])])) {
      const view = await deps.store.getThread(threadId);
      if (!view) continue;
      const folders = await deps.store.listFolders(view.thread.accountId);
      const place = resolvePlace(folders, targetOf(input.action, input.target));
      for (const message of view.messages) {
        if (input.hidden !== true && isHiddenMailbox(message.mailboxes ?? 0)) continue;
        const plan = planMove(held(message), input.action, place, folders);
        if (plan !== null) plans.push({ message, plan });
      }
    }
    if (plans.length === 0) return { operationId: null, keys: [], changeSeq: 0 };

    const operationId = deps.newId();
    const at = deps.now();
    const encoded = encodeTarget(targetOf(input.action, input.target));
    const result = await deps.store.setPlacement(
      plans.map(({ message, plan }) => ({ key: message.key, ...plan })),
    );
    await deps.moveOps.put(
      plans.map(
        ({ message }): NewMoveOperation => ({
          key: message.key,
          accountId: message.accountId,
          operationId,
          action: input.action,
          target: encoded,
          labelsBefore: message.labelIds,
          mailboxesBefore: message.mailboxes ?? 0,
          nextAttemptMs: at + (deps.windowMs ?? MOVE_UNDO_WINDOW_MS),
          createdAtMs: at,
        }),
      ),
    );
    return { operationId, keys: plans.map((p) => p.message.key), changeSeq: result.changeSeq };
  });
}

export interface UndoMoveDeps {
  readonly store: Pick<MessageStorePort, "setPlacement">;
  readonly moveOps: Pick<MoveOutboxPort, "cancel">;
  readonly uow: UnitOfWorkPort;
  readonly now: () => number;
}

export type UndoMoveResult =
  | { readonly kind: "undone"; readonly keys: readonly number[]; readonly changeSeq: number }
  /** The window is over: the move is on its way to the server and stays. */
  | { readonly kind: "tooLate" }
  /** Nothing of this action is pending: it was replaced, undone, or is done. */
  | { readonly kind: "gone" };

/**
 * Takes a move back (ADR 0044, rule 10): the requests go and each message gets back the labels
 * and mailboxes it had before the first request that was still pending, with a change of its
 * own. Once the window is over, or a row was tried, nothing is touched: the answer is `tooLate`.
 */
export function undoMove(deps: UndoMoveDeps, operationId: string): Promise<UndoMoveResult> {
  return deps.uow.run(async () => {
    const { removed, late } = await deps.moveOps.cancel(operationId, deps.now());
    if (late) return { kind: "tooLate" };
    if (removed.length === 0) return { kind: "gone" };
    const result = await deps.store.setPlacement(
      removed.map((o) => ({ key: o.key, labelIds: o.labelsBefore, mailboxes: o.mailboxesBefore })),
    );
    return { kind: "undone", keys: result.changedKeys, changeSeq: result.changeSeq };
  });
}

export interface ReapplyMovesDeps {
  readonly store: Pick<MessageStorePort, "getByKeys" | "listFolders" | "setPlacement">;
  readonly moveOps: Pick<MoveOutboxPort, "listPending">;
}

/**
 * Puts the pending moves of an account back over what a sync just wrote, so a batch built from
 * the server's older state can never undo a move the server has not got yet (ADR 0044, rule 12).
 * Call at the end of the batch's unit of work. Each move is planned again from what the message
 * holds now, so one that is already in place plans nothing and nothing is announced for it; the
 * pending set is normally empty: one read, no write. Returns the keys that were put back.
 */
export async function reapplyPendingMoves(
  deps: ReapplyMovesDeps,
  accountId: string,
): Promise<readonly number[]> {
  const pending = (await deps.moveOps.listPending(accountId)).filter((o) => o.action !== "purge");
  if (pending.length === 0) return [];
  const folders = await deps.store.listFolders(accountId);
  const messages = new Map(
    (await deps.store.getByKeys(pending.map((o) => o.key))).map((m) => [m.key, m]),
  );
  const entries = pending.flatMap((o) => {
    const message = messages.get(o.key);
    const target = decodeTarget(o.target);
    if (!message || target === null) return [];
    const plan = planMove(
      held(message),
      o.action as MoveAction,
      resolvePlace(folders, target),
      folders,
    );
    return plan === null ? [] : [{ key: o.key, ...plan }];
  });
  if (entries.length === 0) return [];
  return (await deps.store.setPlacement(entries)).changedKeys;
}

export interface SettleMovesDeps {
  readonly store: Pick<
    MessageStorePort,
    "getByKeys" | "addLocations" | "removeLocations" | "setPlacement"
  >;
  readonly moveOps: Pick<MoveOutboxPort, "settle">;
  readonly uow: UnitOfWorkPort;
}

/** A copy that is now somewhere else: the server told where (`uidMap`, ADR 0016 rule 5). */
export interface LocationSwap {
  readonly key: number;
  readonly from: MessageLocation;
  readonly to: MessageLocation;
}

/**
 * The server has the moves, or there is nothing to move on it (no copy, no account, a demo
 * account without a password): delete the operations, unless a newer request replaced one
 * meanwhile. A copy the server put somewhere new replaces its old location in the same unit:
 * the new one is added first, so the message is never left without a place and never deleted or
 * downloaded again (ADR 0044, rule 13). Without a new location the old one stays for sync.
 */
export async function finishMoves(
  deps: Pick<SettleMovesDeps, "store" | "moveOps" | "uow">,
  operations: readonly MoveOperation[],
  swaps: readonly LocationSwap[] = [],
): Promise<void> {
  if (operations.length === 0 && swaps.length === 0) return;
  await deps.uow.run(async () => {
    if (swaps.length > 0) {
      const alive = new Set(
        (await deps.store.getByKeys(swaps.map((s) => s.key))).map((m) => m.key),
      );
      const live = swaps.filter((s) => alive.has(s.key));
      await deps.store.addLocations(live.map((s) => ({ key: s.key, location: s.to })));
      await deps.store.removeLocations(live.map((s) => s.from));
    }
    await deps.moveOps.settle(operations);
  });
}

/**
 * The server refused for good: it wins. The operations go and each message gets back the labels
 * and mailboxes it had before them, with a change of its own, because the server will never
 * report a change that did not happen there. A message with a newer request is left alone.
 * Returns the keys that were put back.
 */
export async function rejectMoves(
  deps: Pick<SettleMovesDeps, "store" | "moveOps" | "uow">,
  operations: readonly MoveOperation[],
): Promise<readonly number[]> {
  if (operations.length === 0) return [];
  return deps.uow.run(async () => {
    const current = await deps.moveOps.settle(operations);
    if (current.length === 0) return [];
    const result: SetPlacementResult = await deps.store.setPlacement(
      current.map((o) => ({ key: o.key, labelIds: o.labelsBefore, mailboxes: o.mailboxesBefore })),
    );
    return result.changedKeys;
  });
}

export interface DeleteForeverDeps {
  readonly store: Pick<
    MessageStorePort,
    "getByKeys" | "getLocations" | "listFolders" | "removeByProviderIds"
  >;
  readonly index: Pick<SearchIndexPort, "removeMessages">;
  readonly bodies: Pick<MessageBodyPort, "removeBodies">;
  readonly moveOps: Pick<MoveOutboxPort, "put">;
  readonly uow: UnitOfWorkPort;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface DeleteForeverResult {
  /** Sent to the server: they leave the store when it confirms. */
  readonly queued: readonly number[];
  /** Had no copy on the server: gone at once. The index, bodies and files are the caller's. */
  readonly removed: readonly number[];
  /** Not in Trash, or with a copy outside it: nothing was done. */
  readonly refused: readonly number[];
}

/**
 * Deletes messages for good (ADR 0044, rules 7 and 16): the only permanent action there is, and
 * refused here whatever asked for it unless the message is in Trash and every copy it has is in
 * a Trash folder. A refused message is left as it is, even when others in the call go ahead.
 * Copies are expunged one by one and the message leaves the store when the server says so; one
 * with no copy on the server leaves at once.
 */
export function deleteForever(
  deps: DeleteForeverDeps,
  keys: readonly number[],
): Promise<DeleteForeverResult> {
  return deps.uow.run(async () => {
    const messages = await deps.store.getByKeys([...new Set(keys)]);
    const trashIds = new Map<string, ReadonlySet<string>>();
    const queued: Message[] = [];
    const gone: Message[] = [];
    const refused: number[] = keys.filter((k) => !messages.some((m) => m.key === k));
    for (const m of messages) {
      let trash = trashIds.get(m.accountId);
      if (!trash) {
        const folders = await deps.store.listFolders(m.accountId);
        trash = new Set(folders.filter((f) => f.role === "trash").map((f) => f.id));
        trashIds.set(m.accountId, trash);
      }
      const copies = await deps.store.getLocations(m.key);
      const inTrash = hasRole(m.mailboxes ?? 0, "trash");
      const everyCopyInTrash = copies.every((c) => trash.has(c.folderId));
      if (!inTrash || !everyCopyInTrash) refused.push(m.key);
      else if (copies.length === 0) gone.push(m);
      else queued.push(m);
    }
    if (gone.length > 0) {
      for (const accountId of new Set(gone.map((m) => m.accountId))) {
        const ids = gone.filter((m) => m.accountId === accountId).map((m) => m.providerId);
        const removed = await deps.store.removeByProviderIds(accountId, ids);
        await deps.index.removeMessages(removed);
        await deps.bodies.removeBodies(removed);
      }
    }
    const at = deps.now();
    const operationId = deps.newId();
    await deps.moveOps.put(
      queued.map(
        (m): NewMoveOperation => ({
          key: m.key,
          accountId: m.accountId,
          operationId,
          action: "purge",
          target: "",
          labelsBefore: m.labelIds,
          mailboxesBefore: m.mailboxes ?? 0,
          // No window: it cannot be taken back, so there is nothing to wait for.
          nextAttemptMs: at,
          createdAtMs: at,
        }),
      ),
    );
    return {
      queued: queued.map((m) => m.key),
      removed: gone.map((m) => m.key),
      refused,
    };
  });
}

export interface FinishPurgeDeps {
  readonly store: Pick<MessageStorePort, "removeLocations">;
  readonly index: Pick<SearchIndexPort, "removeMessages">;
  readonly bodies: Pick<MessageBodyPort, "removeBodies">;
  readonly moveOps: Pick<MoveOutboxPort, "settle">;
  readonly uow: UnitOfWorkPort;
}

/**
 * The server has deleted these copies for good, or says they were gone already (ADR 0044, rule
 * 16): they leave the store one location at a time, and a message leaves with its last one, with
 * its index entry and its body. The operations are settled in the same unit; a copy the server
 * refused stays, and so does its message. Returns the messages that left, for the files that
 * were downloaded from them.
 */
export async function finishPurge(
  deps: FinishPurgeDeps,
  operations: readonly MoveOperation[],
  confirmed: readonly MessageLocation[],
): Promise<readonly number[]> {
  return deps.uow.run(async () => {
    const removal = await deps.store.removeLocations(confirmed);
    if (removal.deletedKeys.length > 0) {
      await deps.index.removeMessages(removal.deletedKeys);
      await deps.bodies.removeBodies(removal.deletedKeys);
    }
    await deps.moveOps.settle(operations);
    return removal.deletedKeys;
  });
}
