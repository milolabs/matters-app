import type {
  AccountStorePort,
  ClockPort,
  CredentialPort,
  FlagOutboxPort,
  MailConnectorPort,
  MessageStorePort,
  SeenIntent,
  SetSeenResult,
  UnitOfWorkPort,
} from "@matters/core";
import {
  backoffDelay,
  finishSeen,
  mailErrorKind,
  rejectSeen,
  SEEN_BACKOFF_CAP_MS,
  setSeen,
} from "@matters/core";
import type { FlagRunner } from "./flagRunner.ts";
import type { SeenApi } from "./handler.ts";

/** Requests handed to the server in one pass; the rest follow at once. */
const BATCH = 500;
const BACKOFF_BASE_MS = 2000;

export interface SeenServiceDeps {
  readonly store: Pick<MessageStorePort, "getByKeys" | "getLocations" | "setSeen">;
  readonly flagOps: FlagOutboxPort;
  readonly accounts: Pick<AccountStorePort, "get">;
  readonly credentials: CredentialPort;
  readonly connector: MailConnectorPort;
  readonly uow: UnitOfWorkPort;
  readonly clock: ClockPort;
  /** The change log moved without a batch: the router reads it and tells the windows. */
  readonly onChanged: () => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Read and unread in the sync worker (ADR 0039): the request of the renderer, and the push of
 * what the server does not have yet. `setSeen` returns once the local flag and the request are
 * stored; `process` is what the runner calls.
 */
export class SeenService implements SeenApi {
  private readonly deps: SeenServiceDeps;
  private runner: FlagRunner | null = null;

  constructor(deps: SeenServiceDeps) {
    this.deps = deps;
  }

  attach(runner: FlagRunner): void {
    this.runner = runner;
  }

  nextDueMs(): Promise<number | null> {
    return this.deps.flagOps.nextDueMs();
  }

  async setSeen(keys: readonly number[], seen: boolean): Promise<SetSeenResult> {
    const { deps } = this;
    const result = await setSeen(
      { store: deps.store, flagOps: deps.flagOps, uow: deps.uow, now: () => deps.clock.now() },
      keys,
      seen,
    );
    if (result.changedKeys.length > 0) {
      deps.onChanged();
      this.runner?.wake();
    }
    return result;
  }

  /** Pushes every request that is due, one connection for each account. */
  async process(): Promise<void> {
    const { deps } = this;
    for (;;) {
      const due = await deps.flagOps.listDue(deps.clock.now(), BATCH);
      if (due.length === 0) return;
      const byAccount = new Map<string, SeenIntent[]>();
      for (const intent of due) {
        const list = byAccount.get(intent.accountId);
        if (list) list.push(intent);
        else byAccount.set(intent.accountId, [intent]);
      }
      let moved = 0;
      for (const [accountId, intents] of byAccount) {
        moved += await this.pushAccount(accountId, intents);
      }
      // A pass that moved nothing (all deferred) must not spin: the retries have later times.
      if (moved === 0 || due.length < BATCH) return;
    }
  }

  /** Returns how many requests left the table. */
  private async pushAccount(accountId: string, intents: readonly SeenIntent[]): Promise<number> {
    const { deps } = this;
    const finish = (list: readonly SeenIntent[]) => finishSeen(deps, list);

    const later = (list: readonly SeenIntent[]) =>
      deps.flagOps.defer(
        list.map((intent) => ({
          intent,
          nextAttemptMs:
            deps.clock.now() +
            backoffDelay(
              intent.attempts,
              deps.clock.random(),
              BACKOFF_BASE_MS,
              SEEN_BACKOFF_CAP_MS,
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
        await later(intents);
        return 0;
      }
    }
    if (!account || !credential) {
      await finish(intents);
      return intents.length;
    }

    // Every copy of the message, since IMAP flags belong to a copy. A message with none was
    // removed or is not on the server yet.
    const copies = new Map<number, Awaited<ReturnType<MessageStorePort["getLocations"]>>>();
    const gone: SeenIntent[] = [];
    const live: SeenIntent[] = [];
    for (const intent of intents) {
      const locations = await deps.store.getLocations(intent.key);
      copies.set(intent.key, locations);
      (locations.length === 0 ? gone : live).push(intent);
    }
    let moved = gone.length;
    await finish(gone);
    if (live.length === 0) return moved;

    let connection: Awaited<ReturnType<MailConnectorPort["connect"]>>;
    try {
      connection = await deps.connector.connect({ server: account.imap, credential });
    } catch (error) {
      // Offline, a timeout or a password the server turned down: all wait and try again.
      this.report(error);
      await later(live);
      return moved;
    }
    try {
      for (const seen of [true, false]) {
        const group = live.filter((i) => i.seen === seen);
        if (group.length === 0) continue;
        try {
          const results = await connection.flags.setSeen(
            group.flatMap((i) => copies.get(i.key) ?? []),
            seen,
          );
          let at = 0;
          const done: SeenIntent[] = [];
          const refused: SeenIntent[] = [];
          for (const intent of group) {
            const end = at + (copies.get(intent.key) ?? []).length;
            const mine = results.slice(at, end);
            at = end;
            const outcomes = new Set(mine.map((r) => r.outcome));
            if (outcomes.has("done")) done.push(intent);
            else if (outcomes.has("rejected")) refused.push(intent);
            // Only stale copies: the folder was rebuilt, and sync will say what is there now.
            else done.push(intent);
          }
          await finish(done);
          const restored = await rejectSeen(deps, refused);
          moved += done.length + refused.length;
          if (restored.length > 0) deps.onChanged();
        } catch (error) {
          this.report(error);
          await later(group);
        }
      }
    } finally {
      await connection.close().catch(() => {});
    }
    return moved;
  }

  private report(error: unknown): void {
    // The kind is enough; the message of an adapter error is scrubbed, but the log needs no more.
    this.deps.onError(new Error(`push of read state failed (${mailErrorKind(error)})`));
  }
}
