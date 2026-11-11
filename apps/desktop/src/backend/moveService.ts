import type {
  AccountStorePort,
  ClockPort,
  CredentialPort,
  DeleteForeverResult,
  Label,
  LocationSwap,
  MailConnection,
  MailConnectorPort,
  MessageBodyPort,
  MessageLocation,
  MessageStorePort,
  MoveAction,
  MoveKind,
  MoveOperation,
  MoveOutboxPort,
  MoveThreadInput,
  MoveThreadResult,
  ReceivedFilesPort,
  SearchIndexPort,
  UndoMoveResult,
  UnitOfWorkPort,
} from "@matters/core";
import {
  backoffDelay,
  decodeTarget,
  deleteForever,
  finishMoves,
  finishPurge,
  labelStyle,
  MOVE_BACKOFF_CAP_MS,
  mailErrorKind,
  moveThread,
  rejectMoves,
  resolvePlace,
  undoMove,
} from "@matters/core";
import type { FlagRunner } from "./flagRunner.ts";
import type { MoveApi } from "./handler.ts";

/** Operations handed to the server in one pass; the rest follow at once. */
const BATCH = 500;
const BACKOFF_BASE_MS = 2000;

export interface MoveServiceDeps {
  readonly store: Pick<
    MessageStorePort,
    | "getThread"
    | "getByKeys"
    | "getLocations"
    | "listFolders"
    | "setPlacement"
    | "addLocations"
    | "removeLocations"
    | "removeByProviderIds"
  >;
  readonly index: Pick<SearchIndexPort, "removeMessages">;
  readonly bodies: Pick<MessageBodyPort, "removeBodies">;
  /** With it, the downloaded copies of a message go when the message does (ADR 0043, rule 8). */
  readonly received?: Pick<ReceivedFilesPort, "removeMessages">;
  readonly moveOps: MoveOutboxPort;
  readonly accounts: Pick<AccountStorePort, "get">;
  readonly credentials: CredentialPort;
  readonly connector: MailConnectorPort;
  readonly uow: UnitOfWorkPort;
  readonly clock: ClockPort;
  readonly newId: () => string;
  /** The undo window; default 10 s. Only tests change it. */
  readonly windowMs?: number;
  /** The change log moved without a batch: the router reads it and tells the windows. */
  readonly onChanged: () => void;
  /** The list of moves in their window changed: the router tells the windows. */
  readonly onMoves: () => void;
  /** The server turned these down for good (ADR 0044, rule 15): the tray says so. */
  readonly onRefused: (action: MoveKind, count: number) => void;
  /** A sync of the account would settle what the push could not (a copy whose new UID is unknown). */
  readonly requestSync: (accountId: string) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Moving mail in the sync worker (ADR 0044): the request of the renderer, and the push of what
 * the server does not have yet. `moveThread` returns once the local labels and the request are
 * stored; `process` is what the runner calls, shaped like `SeenService`.
 */
export class MoveService implements MoveApi {
  private readonly deps: MoveServiceDeps;
  private runner: FlagRunner | null = null;

  constructor(deps: MoveServiceDeps) {
    this.deps = deps;
  }

  attach(runner: FlagRunner): void {
    this.runner = runner;
  }

  nextDueMs(): Promise<number | null> {
    return this.deps.moveOps.nextDueMs();
  }

  async moveThread(input: MoveThreadInput): Promise<MoveThreadResult> {
    const { deps } = this;
    const result = await moveThread(
      {
        store: deps.store,
        moveOps: deps.moveOps,
        uow: deps.uow,
        now: () => deps.clock.now(),
        newId: deps.newId,
        ...(deps.windowMs === undefined ? {} : { windowMs: deps.windowMs }),
      },
      input,
    );
    if (result.operationId !== null) this.changed();
    return result;
  }

  async undoMove(operationId: string): Promise<UndoMoveResult> {
    const { deps } = this;
    const result = await undoMove(
      { store: deps.store, moveOps: deps.moveOps, uow: deps.uow, now: () => deps.clock.now() },
      operationId,
    );
    if (result.kind === "undone") this.changed();
    return result;
  }

  async deleteForever(keys: readonly number[]): Promise<DeleteForeverResult> {
    const { deps } = this;
    const result = await deleteForever(
      {
        store: deps.store,
        index: deps.index,
        bodies: deps.bodies,
        moveOps: deps.moveOps,
        uow: deps.uow,
        now: () => deps.clock.now(),
        newId: deps.newId,
      },
      keys,
    );
    if (result.removed.length > 0)
      await deps.received?.removeMessages(result.removed).catch(() => {});
    if (result.queued.length > 0 || result.removed.length > 0) this.changed();
    return result;
  }

  private changed(): void {
    this.deps.onChanged();
    this.deps.onMoves();
    this.runner?.wake();
  }

  /** Pushes every operation that is due, one connection for each account. */
  async process(): Promise<void> {
    const { deps } = this;
    for (;;) {
      const due = await deps.moveOps.listDue(deps.clock.now(), BATCH);
      if (due.length === 0) return;
      const byAccount = new Map<string, MoveOperation[]>();
      for (const operation of due) {
        const list = byAccount.get(operation.accountId);
        if (list) list.push(operation);
        else byAccount.set(operation.accountId, [operation]);
      }
      let handled = 0;
      for (const [accountId, operations] of byAccount) {
        handled += await this.pushAccount(accountId, operations);
      }
      // A pass that settled nothing (all deferred) must not spin: the retries have later times.
      if (handled === 0 || due.length < BATCH) return;
    }
  }

  /** Returns how many operations left the table. */
  private async pushAccount(
    accountId: string,
    operations: readonly MoveOperation[],
  ): Promise<number> {
    const { deps } = this;
    const later = (list: readonly MoveOperation[]) =>
      deps.moveOps.defer(
        list.map((operation) => ({
          operation,
          nextAttemptMs:
            deps.clock.now() +
            backoffDelay(
              operation.attempts,
              deps.clock.random(),
              BACKOFF_BASE_MS,
              MOVE_BACKOFF_CAP_MS,
            ),
        })),
      );

    // No account, or no password to log in with (demo mail): nothing to push to. The local state
    // is what the reader chose, so it stays, and nothing is retried. A vault that could not answer
    // says nothing about the password, so that request waits rather than being lost.
    const account = await deps.accounts.get(accountId);
    let credential: Awaited<ReturnType<CredentialPort["get"]>> = null;
    if (account) {
      try {
        credential = await deps.credentials.get(accountId);
      } catch (error) {
        this.report(error);
        await later(operations);
        return 0;
      }
    }
    if (!account || !credential) {
      await finishMoves(deps, operations);
      this.afterSettle();
      return operations.length;
    }

    const folders = await deps.store.listFolders(accountId);
    const copies = new Map<number, readonly MessageLocation[]>();
    const gone: MoveOperation[] = [];
    const live: MoveOperation[] = [];
    for (const operation of operations) {
      const locations = await deps.store.getLocations(operation.key);
      copies.set(operation.key, locations);
      (locations.length === 0 ? gone : live).push(operation);
    }
    // A message with no copy was removed, or is not on the server yet: there is nothing to move.
    let handled = gone.length;
    await finishMoves(deps, gone);
    if (live.length === 0) {
      this.afterSettle();
      return handled;
    }

    let connection: MailConnection;
    try {
      connection = await deps.connector.connect({ server: account.imap, credential });
    } catch (error) {
      // Offline, a timeout or a password the server turned down: all wait and try again.
      this.report(error);
      await later(live);
      return handled;
    }
    try {
      const purge = live.filter((o) => o.action === "purge");
      const moves = live.filter((o) => o.action !== "purge");
      handled += await this.pushMoves(connection, accountId, folders, moves, copies, later);
      handled += await this.pushPurges(connection, folders, purge, copies, later);
    } finally {
      await connection.close().catch(() => {});
    }
    this.afterSettle();
    return handled;
  }

  /** The copies of a message that a move takes (ADR 0044, rule 5): Sent and Drafts stay. */
  private takenCopies(
    operation: MoveOperation,
    copies: readonly MessageLocation[],
    folders: readonly Label[],
  ): MessageLocation[] {
    const target = decodeTarget(operation.target);
    const place = target === null ? null : resolvePlace(folders, target);
    const roles = new Map(folders.map((f) => [f.id, f]));
    // With labels the target folder can be where the copy is (All Mail): the label is what moves.
    const labels = labelStyle(folders);
    return copies.filter((c) => {
      const role = roles.get(c.folderId)?.role;
      if (!labels && place !== null && c.folderId === place.id) return false;
      if (operation.action === "delete") return true;
      return role !== "sent" && role !== "drafts";
    });
  }

  private async pushMoves(
    connection: MailConnection,
    accountId: string,
    folders: readonly Label[],
    operations: readonly MoveOperation[],
    copies: ReadonlyMap<number, readonly MessageLocation[]>,
    later: (list: readonly MoveOperation[]) => Promise<void>,
  ): Promise<number> {
    const { deps } = this;
    let handled = 0;
    // One call for each action and target: the server is asked once for a whole thread.
    const groups = new Map<string, MoveOperation[]>();
    for (const o of operations) {
      const id = `${o.action}\u0000${o.target}`;
      const list = groups.get(id);
      if (list) list.push(o);
      else groups.set(id, [o]);
    }
    for (const group of groups.values()) {
      const first = group[0] as MoveOperation;
      const target = decodeTarget(first.target);
      const taken = new Map(
        group.map((o) => [o.key, this.takenCopies(o, copies.get(o.key) ?? [], folders)]),
      );
      const nothing = group.filter((o) => (taken.get(o.key) ?? []).length === 0);
      const asked = group.filter((o) => (taken.get(o.key) ?? []).length > 0);
      handled += nothing.length;
      await finishMoves(deps, nothing);
      if (asked.length === 0 || target === null) {
        if (target === null) await rejectMoves(deps, asked);
        continue;
      }
      try {
        const results = await connection.moves.move(
          asked.flatMap((o) => taken.get(o.key) ?? []),
          first.action as MoveAction,
          target,
        );
        let at = 0;
        const done: MoveOperation[] = [];
        const refused: MoveOperation[] = [];
        const swaps: LocationSwap[] = [];
        let sync = false;
        for (const operation of asked) {
          const mine = results.slice(at, at + (taken.get(operation.key) ?? []).length);
          at += mine.length;
          if (mine.some((r) => r.outcome.kind === "moved")) {
            done.push(operation);
            for (const r of mine) {
              if (r.outcome.kind !== "moved") continue;
              if (r.outcome.location) {
                swaps.push({ key: operation.key, from: r.location, to: r.outcome.location });
              } else {
                sync = true;
              }
            }
          } else if (mine.some((r) => r.outcome.kind === "rejected")) {
            refused.push(operation);
          } else {
            // Only stale copies: the folder was rebuilt or the copy is gone (a crash between the
            // move and the settling). Sync will say where the message is now.
            done.push(operation);
            sync = true;
          }
        }
        await finishMoves(deps, done, swaps);
        const restored = await rejectMoves(deps, refused);
        handled += done.length + refused.length;
        if (restored.length > 0) deps.onChanged();
        if (refused.length > 0) deps.onRefused(first.action, refused.length);
        if (sync) deps.requestSync(accountId);
      } catch (error) {
        this.report(error);
        await later(asked);
      }
    }
    return handled;
  }

  private async pushPurges(
    connection: MailConnection,
    folders: readonly Label[],
    operations: readonly MoveOperation[],
    copies: ReadonlyMap<number, readonly MessageLocation[]>,
    later: (list: readonly MoveOperation[]) => Promise<void>,
  ): Promise<number> {
    if (operations.length === 0) return 0;
    const { deps } = this;
    const trash = new Set(folders.filter((f) => f.role === "trash").map((f) => f.id));
    // The core refused anything with a copy outside Trash when it was asked; this is asked again
    // on the way out, because the copies may have changed since (a sync, a restore).
    const safe = operations.filter((o) =>
      (copies.get(o.key) ?? []).every((c) => trash.has(c.folderId)),
    );
    const unsafe = operations.filter((o) => !safe.includes(o));
    await deps.moveOps.settle(unsafe);
    if (safe.length === 0) return unsafe.length;
    try {
      const wanted = safe.flatMap((o) => copies.get(o.key) ?? []);
      const results = await connection.moves.expunge(wanted);
      const confirmed = results.filter((r) => r.outcome !== "rejected").map((r) => r.location);
      const refused = results.filter((r) => r.outcome === "rejected").length;
      const left = await finishPurge(deps, safe, confirmed);
      if (left.length > 0) await deps.received?.removeMessages(left).catch(() => {});
      if (refused > 0) deps.onRefused("purge", refused);
      this.changed();
      return unsafe.length + safe.length;
    } catch (error) {
      this.report(error);
      await later(safe);
      return unsafe.length;
    }
  }

  /** Rows left the table, and a swapped location may have set a mailbox: both are told. */
  private afterSettle(): void {
    this.deps.onChanged();
    this.deps.onMoves();
  }

  private report(error: unknown): void {
    // The kind is enough; the message of an adapter error is scrubbed, but the log needs no more.
    this.deps.onError(new Error(`push of a move failed (${mailErrorKind(error)})`));
  }
}
