import type { StoredAccount } from "../domain/accounts.ts";
import type { Label } from "../domain/entities.ts";
import {
  CredentialsUnavailableError,
  type MailErrorKind,
  mailErrorKind,
} from "../domain/errors.ts";
import { type FailureDetail, failureDetailOf, refusalIsTemporary } from "../domain/signIn.ts";
import type {
  AccountStorePort,
  CredentialPort,
  MailConnection,
  MailConnectorPort,
  MailTarget,
  MailWatch,
} from "../ports/index.ts";
import { toAccount } from "./accounts.ts";
import type { ApplySyncBatchDeps } from "./applySyncBatch.ts";
import { SyncAbortedError, syncAccount } from "./syncAccount.ts";

export type SyncStatus =
  | { readonly state: "idle"; readonly lastSyncMs?: number }
  | {
      readonly state: "syncing";
      readonly folder: string;
      readonly done: number;
      readonly total?: number;
    }
  | {
      readonly state: "error";
      readonly kind: MailErrorKind;
      readonly message: string;
      /**
       * What the server's answer told (ADR 0114): why a sign-in was refused, the server's own
       * sentence for a quote. Never read by logic but through `refusal`.
       */
      readonly detail?: FailureDetail;
    };

/** Time and chance, injected so the scheduler is testable without waiting. */
export interface ClockPort {
  now(): number;
  /** Returns the function that cancels the timer. */
  setTimeout(run: () => void, delayMs: number): () => void;
  /** In [0, 1). */
  random(): number;
}

export interface SyncSchedulerOptions {
  /** Full sync period; default 15 minutes. */
  readonly intervalMs?: number;
  /** First retry delay after a failure; default 1 s, doubling. */
  readonly backoffBaseMs?: number;
  /** Longest retry delay; default 5 minutes. */
  readonly backoffCapMs?: number;
  /**
   * First retry delay after a temporary refusal (`unavailable`, `throttled`); default 1 minute,
   * doubling. Slow, so the retries do not feed the server's count of failed logins.
   */
  readonly refusalBackoffBaseMs?: number;
  /** Longest retry delay after a temporary refusal; default 30 minutes. */
  readonly refusalBackoffCapMs?: number;
}

export interface SyncSchedulerDeps {
  readonly connector: MailConnectorPort;
  readonly accounts: AccountStorePort;
  readonly credentials: CredentialPort;
  /** The write ports; batches commit through their unit of work. */
  readonly sync: ApplySyncBatchDeps;
  readonly clock: ClockPort;
  readonly onStatus: (accountId: string, status: SyncStatus) => void;
  /** A batch was committed: readers can refresh. */
  readonly onBatchApplied?: (accountId: string) => void;
  /** A run finished without error; for logs and measurements. */
  readonly onSynced?: (accountId: string, run: SyncRun) => void;
  readonly options?: SyncSchedulerOptions;
}

export const SYNC_INTERVAL_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 5 * 60_000;
const REFUSAL_BACKOFF_BASE_MS = 60_000;
const REFUSAL_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Exponential delay with jitter: `base * 2^attempt`, never above `cap`, scaled into [0.5, 1) of
 * that so many clients do not retry in step. `attempt` counts from 0.
 */
export function backoffDelay(
  attempt: number,
  random: number,
  base = BACKOFF_BASE_MS,
  cap = BACKOFF_CAP_MS,
): number {
  const raw = Math.min(cap, base * 2 ** Math.min(attempt, 30));
  return Math.floor(raw * (0.5 + 0.5 * random));
}

type Scope = "inbox" | "full";

export interface SyncRun {
  readonly scope: Scope;
  readonly durationMs: number;
  /** Messages downloaded and stored for the first time. */
  readonly documents: number;
}

/**
 * Failures a retry cannot fix; the user has to act (password, webmail, settings). A refusal the
 * server says is temporary (`unavailable`, `throttled`) is not one: it is tried again slowly.
 */
const needsUser = (f: Failure) =>
  f.kind === "credentials" || (f.kind === "auth" && !temporaryRefusal(f));

/** The server turned the sign-in away for now, on its side (ADR 0114 `unavailable`, `throttled`). */
const temporaryRefusal = (f: Failure) => f.kind === "auth" && refusalIsTemporary(f.detail?.refusal);

interface Failure {
  readonly kind: MailErrorKind;
  readonly message: string;
  readonly detail?: FailureDetail;
}

interface Runtime {
  readonly account: StoredAccount;
  readonly abort: { aborted: boolean };
  stopped: boolean;
  /** The drain loop in flight. */
  running: Promise<void> | null;
  /** The connection of that loop, to cut when the account stops: a download can take long. */
  connection: MailConnection | null;
  pending: Scope | null;
  watch: MailWatch | null;
  watching: Promise<void> | null;
  syncFailure: Failure | null;
  watchFailure: Failure | null;
  syncAttempts: number;
  watchAttempts: number;
  status: SyncStatus;
  lastSyncMs: number | undefined;
  cancelInterval: (() => void) | null;
  cancelSyncRetry: (() => void) | null;
  cancelWatchRetry: (() => void) | null;
}

/**
 * Keeps accounts in sync in the background (ADR 0018): a full sync at start and every
 * 15 minutes, an IDLE watch on the inbox that triggers inbox syncs, at most one sync per account
 * at a time (triggers arriving meanwhile are merged into one more run), retries with
 * exponential backoff. Status goes to `onStatus`; the IMAP specifics stay behind the connector.
 */
export class SyncScheduler {
  private readonly deps: SyncSchedulerDeps;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly intervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly refusalBackoffBaseMs: number;
  private readonly refusalBackoffCapMs: number;
  private stopped = false;

  constructor(deps: SyncSchedulerDeps) {
    this.deps = deps;
    this.intervalMs = deps.options?.intervalMs ?? SYNC_INTERVAL_MS;
    this.backoffBaseMs = deps.options?.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffCapMs = deps.options?.backoffCapMs ?? BACKOFF_CAP_MS;
    this.refusalBackoffBaseMs = deps.options?.refusalBackoffBaseMs ?? REFUSAL_BACKOFF_BASE_MS;
    this.refusalBackoffCapMs = deps.options?.refusalBackoffCapMs ?? REFUSAL_BACKOFF_CAP_MS;
  }

  /** Starts every stored account. */
  async start(): Promise<void> {
    for (const account of await this.deps.accounts.list()) this.add(account);
  }

  /** Starts syncing and watching one account; a second call for the same id does nothing. */
  add(account: StoredAccount): void {
    if (this.stopped || this.runtimes.has(account.id)) return;
    const rt: Runtime = {
      account,
      abort: { aborted: false },
      stopped: false,
      running: null,
      connection: null,
      pending: null,
      watch: null,
      watching: null,
      syncFailure: null,
      watchFailure: null,
      syncAttempts: 0,
      watchAttempts: 0,
      status: { state: "idle" },
      lastSyncMs: undefined,
      cancelInterval: null,
      cancelSyncRetry: null,
      cancelWatchRetry: null,
    };
    this.runtimes.set(account.id, rt);
    this.request(rt, "full");
    this.startWatch(rt);
  }

  /** Stops the account's work and waits for it to finish; call before deleting its data. */
  async remove(accountId: string): Promise<void> {
    const rt = this.runtimes.get(accountId);
    if (!rt) return;
    this.runtimes.delete(accountId);
    await this.halt(rt);
  }

  /** "Sync now": a full sync, also after an error that stopped the retries. */
  syncNow(accountId: string): void {
    const rt = this.runtimes.get(accountId);
    if (!rt || rt.stopped) return;
    rt.cancelSyncRetry?.();
    rt.cancelSyncRetry = null;
    rt.syncAttempts = 0;
    this.request(rt, "full");
    if (!rt.watch && !rt.watching && !rt.cancelWatchRetry) this.startWatch(rt);
  }

  /**
   * The account has a new password (ADR 0113): what the old one left behind goes (its failures,
   * a watch logged in with it), then a full sync and a new watch start at once. A sync already
   * running finishes first; the full one follows it with the new password.
   */
  async reconnect(accountId: string): Promise<void> {
    const rt = this.runtimes.get(accountId);
    if (!rt || rt.stopped) return;
    // A watch still opening uses the password read before the change; let it settle first.
    await rt.watching?.catch(() => {});
    if (rt.stopped) return;
    rt.cancelWatchRetry?.();
    rt.cancelWatchRetry = null;
    const watch = rt.watch;
    rt.watch = null;
    await watch?.close().catch(() => {});
    if (rt.stopped) return;
    rt.syncFailure = null;
    rt.watchFailure = null;
    rt.watchAttempts = 0;
    this.syncNow(accountId);
  }

  status(accountId: string): SyncStatus | null {
    return this.runtimes.get(accountId)?.status ?? null;
  }

  statuses(): ReadonlyMap<string, SyncStatus> {
    return new Map([...this.runtimes].map(([id, rt]) => [id, rt.status]));
  }

  /** Stops everything and closes every connection; resolves when nothing is running. */
  async stop(): Promise<void> {
    this.stopped = true;
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(all.map((rt) => this.halt(rt)));
  }

  private async halt(rt: Runtime): Promise<void> {
    rt.stopped = true;
    rt.abort.aborted = true;
    rt.cancelInterval?.();
    rt.cancelSyncRetry?.();
    rt.cancelWatchRetry?.();
    rt.pending = null;
    rt.connection?.abort();
    await Promise.allSettled([rt.running, rt.watching]);
    const watch = rt.watch;
    rt.watch = null;
    await watch?.close().catch(() => {});
  }

  private request(rt: Runtime, scope: Scope): void {
    if (rt.stopped) return;
    rt.pending = rt.pending === "full" || scope === "full" ? "full" : "inbox";
    if (rt.running) return;
    rt.running = this.drain(rt).finally(() => {
      rt.running = null;
    });
  }

  private async drain(rt: Runtime): Promise<void> {
    while (rt.pending && !rt.stopped) {
      const scope = rt.pending;
      rt.pending = null;
      await this.runOnce(rt, scope);
    }
  }

  private async runOnce(rt: Runtime, scope: Scope): Promise<void> {
    rt.cancelInterval?.();
    rt.cancelInterval = null;
    rt.cancelSyncRetry?.();
    rt.cancelSyncRetry = null;
    this.publish(rt, { state: "syncing", folder: "", done: 0 });
    const startedMs = this.deps.clock.now();
    try {
      const target = await this.targetOf(rt);
      const connection = await this.deps.connector.connect(target);
      rt.connection = connection;
      // Stopped while connecting: nothing to cut yet at that moment.
      if (rt.stopped) connection.abort();
      try {
        const result = await syncAccount(
          { ...this.deps.sync, sync: connection.sync },
          toAccount(rt.account),
          {
            ...(scope === "inbox" ? { folders: inboxFolders } : {}),
            signal: rt.abort,
            onBatchApplied: () => this.deps.onBatchApplied?.(rt.account.id),
            onProgress: ({ folder, done, total }) =>
              this.publish(rt, {
                state: "syncing",
                folder: folder.name,
                done,
                ...(total === undefined ? {} : { total }),
              }),
          },
        );
        this.deps.onSynced?.(rt.account.id, {
          scope,
          durationMs: this.deps.clock.now() - startedMs,
          documents: result.folders.reduce((n, f) => n + f.documents, 0),
        });
      } finally {
        rt.connection = null;
        await connection.close().catch(() => {});
      }
      rt.syncFailure = null;
      rt.syncAttempts = 0;
      rt.lastSyncMs = this.deps.clock.now();
      this.armInterval(rt);
      // A watch turned away for now waits for a sync that got in, so the account makes one
      // login per slow retry rather than two.
      if (rt.watchFailure && temporaryRefusal(rt.watchFailure)) this.startWatch(rt);
    } catch (error) {
      if (rt.stopped || error instanceof SyncAbortedError) return;
      rt.syncFailure = failureOf(error);
      this.armSyncRetry(rt);
    }
    this.publishSettled(rt, true);
  }

  private async targetOf(rt: Runtime): Promise<MailTarget> {
    const credential = await this.deps.credentials.get(rt.account.id);
    if (!credential) throw new CredentialsUnavailableError("The saved password is missing");
    return { server: rt.account.imap, credential };
  }

  private armInterval(rt: Runtime): void {
    if (rt.stopped) return;
    rt.cancelInterval = this.deps.clock.setTimeout(() => {
      rt.cancelInterval = null;
      this.request(rt, "full");
    }, this.intervalMs);
  }

  private armSyncRetry(rt: Runtime): void {
    if (rt.stopped || !rt.syncFailure || needsUser(rt.syncFailure)) return;
    const delay = this.delay(rt.syncAttempts++, temporaryRefusal(rt.syncFailure));
    rt.cancelSyncRetry = this.deps.clock.setTimeout(() => {
      rt.cancelSyncRetry = null;
      this.request(rt, "full");
    }, delay);
  }

  private delay(attempt: number, refused: boolean): number {
    return refused
      ? backoffDelay(
          attempt,
          this.deps.clock.random(),
          this.refusalBackoffBaseMs,
          this.refusalBackoffCapMs,
        )
      : backoffDelay(attempt, this.deps.clock.random(), this.backoffBaseMs, this.backoffCapMs);
  }

  private startWatch(rt: Runtime): void {
    if (rt.stopped || rt.watching) return;
    rt.watching = this.openWatch(rt).finally(() => {
      rt.watching = null;
    });
  }

  private async openWatch(rt: Runtime): Promise<void> {
    try {
      const target = await this.targetOf(rt);
      const watch = await this.deps.connector.watchInbox(target, {
        onChange: () => this.request(rt, "inbox"),
        onClosed: (error) => {
          if (rt.watch !== watch) return;
          rt.watch = null;
          if (rt.stopped) return;
          rt.watchFailure = failureOf(error ?? new Error("The connection to the server closed"));
          this.publishSettled(rt);
          this.armWatchRetry(rt);
        },
      });
      if (rt.stopped) {
        await watch.close().catch(() => {});
        return;
      }
      rt.watch = watch;
      rt.watchFailure = null;
      rt.watchAttempts = 0;
      // Mail may have arrived while the watch was down.
      if (rt.lastSyncMs !== undefined) this.request(rt, "inbox");
      this.publishSettled(rt);
    } catch (error) {
      if (rt.stopped) return;
      rt.watchFailure = failureOf(error);
      this.publishSettled(rt);
      this.armWatchRetry(rt);
    }
  }

  private armWatchRetry(rt: Runtime): void {
    if (rt.stopped || !rt.watchFailure || needsUser(rt.watchFailure)) return;
    // Turned away for now: the sync's slow retry, or its next run, opens the watch again.
    if (temporaryRefusal(rt.watchFailure)) return;
    const delay = this.delay(rt.watchAttempts++, false);
    rt.cancelWatchRetry = this.deps.clock.setTimeout(() => {
      rt.cancelWatchRetry = null;
      this.startWatch(rt);
    }, delay);
  }

  /** Idle or error, depending on what is still wrong; never while a sync is running. */
  private publishSettled(rt: Runtime, afterSync = false): void {
    if (rt.running && !afterSync) return;
    const failure = rt.syncFailure ?? rt.watchFailure;
    this.publish(
      rt,
      failure
        ? { state: "error", ...failure }
        : { state: "idle", ...(rt.lastSyncMs === undefined ? {} : { lastSyncMs: rt.lastSyncMs }) },
    );
  }

  private publish(rt: Runtime, status: SyncStatus): void {
    if (rt.stopped) return;
    rt.status = status;
    this.deps.onStatus(rt.account.id, status);
  }
}

function inboxFolders(all: readonly Label[]): readonly Label[] {
  const inbox = all.filter((f) => f.role === "inbox");
  // Gmail has no INBOX folder to sync: every message lives in All Mail.
  return inbox.length > 0 ? inbox : all.filter((f) => f.role === "archive");
}

function failureOf(error: unknown): Failure {
  const detail = failureDetailOf(error);
  return {
    kind: mailErrorKind(error),
    message: error instanceof Error ? error.message : "Unknown error",
    ...(detail === undefined ? {} : { detail }),
  };
}
