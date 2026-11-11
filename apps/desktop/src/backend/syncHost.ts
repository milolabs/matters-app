import type { MoveKind, PromptProgress, SyncStatus } from "@matters/core";
import { backoffDelay } from "@matters/core";
import type { CommandResult, FromWorker, ToWorker, WireError, WorkerCommand } from "./protocol.ts";

/** The part of `worker_threads.Worker` the host uses. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  on(event: "message", listener: (message: FromWorker) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface SyncHostHandlers {
  onStatus(accountId: string, status: SyncStatus): void;
  /** A batch (or an account change) is committed. */
  onCommitted(): void;
  /** A send changed state. */
  onOutbox(): void;
  /** The moves waiting for their window or the server changed. */
  onMoves(): void;
  /** What agents found or made changed. */
  onAgent(): void;
  /** The saved views changed in the worker, not by a request (ADR 0117, rule 2). */
  onViews?(): void;
  /** A turn across all mail finished its search: the query and how many threads go on. */
  onAgentTalkStep(
    query: string,
    threads: number,
    kind?: "search" | "follow" | "read" | "note" | "count" | "look",
    note?: string,
  ): void;
  /** How far a prompt is read (ADR 0116, rule 9). Absent: nobody listens. */
  onAgentPrompt?(progress: PromptProgress): void;
  /** The server turned moves down for good. */
  onMoveRefused(action: MoveKind, count: number): void;
  /** The files of a draft changed. */
  onAttachments(draftId: string): void;
  onAttachmentProgress(id: string, fraction: number): void;
  onSendProgress(operationId: string, sentBytes: number, totalBytes: number): void;
  onReceivedProgress(messageKey: number, partId: string, bytes: number, totalBytes: number): void;
  /** These attachments are no longer being copied. */
  onCaptured(ids: readonly string[]): void;
  onSynced(accountId: string, scope: string, documents: number, durationMs: number): void;
  /** A credential request from the worker; `reply` answers that very worker, if it still lives. */
  onCredentials(data: unknown, reply: (data: unknown) => void): void;
  /** The worker died unexpectedly. A new one starts after a delay; reads are not affected. */
  onCrash(reason: string): void;
  /** A replacement worker is ready. */
  onRestarted(): void;
  /** The worker is updating the database's schema: step `step` of `total` (ADR 0103, rule 1). */
  onMigrating?(step: number, total: number): void;
}

export interface SyncHostOptions {
  readonly spawn: () => WorkerLike;
  readonly handlers: SyncHostHandlers;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** A worker that ran this long before dying counts as healthy: the backoff starts over. */
  readonly healthyAfterMs?: number;
}

/** A command failed in the worker; carries what the error classification needs. */
export class WorkerCommandError extends Error {
  readonly kind: string | undefined;
  constructor(wire: WireError) {
    super(wire.message);
    this.name = wire.name;
    this.kind = wire.kind;
  }
}

/** The command could not run because the sync worker is not running. */
export class WorkerUnavailableError extends Error {
  constructor(message = "The sync process is restarting; try again in a moment") {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

interface StartWaiter {
  resolve(started: { seeded: number; ms: number }): void;
  reject(error: Error): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Router side of the sync worker: spawns it, sends commands, forwards its events, and starts a
 * new one with exponential backoff when it dies. It owns no data; while the worker is down the
 * router keeps serving reads.
 */
export class SyncHost {
  private readonly options: SyncHostOptions;
  private worker: WorkerLike | null = null;
  private ready = false;
  private stopping = false;
  private nextId = 0;
  private attempts = 0;
  private readyAtMs = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();
  private waitingForStop: (() => void) | null = null;
  /** Settled when the first worker is ready or has failed; null once that has happened. */
  private firstStart: Promise<unknown> | null = null;

  constructor(options: SyncHostOptions) {
    this.options = options;
  }

  /** True while a worker is up and has finished starting. */
  get running(): boolean {
    return this.ready;
  }

  /** Resolves when the first worker is ready; rejects when it cannot start. */
  start(): Promise<{ seeded: number; ms: number }> {
    const started = new Promise<{ seeded: number; ms: number }>((resolve, reject) =>
      this.launch({ resolve, reject }),
    );
    // The router may serve reads before the worker is up (ADR 0046, rule 1); a command that
    // arrives in that moment waits for the first worker instead of failing.
    const settled = started.then(
      () => {
        this.firstStart = null;
      },
      () => {
        this.firstStart = null;
      },
    );
    this.firstStart = settled;
    return started;
  }

  async command<C extends WorkerCommand>(command: C): Promise<CommandResult<C>> {
    if (this.firstStart && !this.ready && !this.stopping) await this.firstStart;
    const worker = this.worker;
    if (!worker || !this.ready || this.stopping)
      return Promise.reject(new WorkerUnavailableError());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ type: "command", id, command });
    });
  }

  /**
   * Asks the worker to close its connections and the writer, then ends the thread. If it does
   * not finish within `timeoutMs` it is terminated; SQLite discards an open transaction.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.failPending(new WorkerUnavailableError("The app is closing"));
    const worker = this.worker;
    if (!worker) return;
    const stopped = new Promise<void>((resolve) => {
      this.waitingForStop = resolve;
    });
    worker.postMessage({ type: "shutdown" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this.worker = null;
    this.ready = false;
    await worker.terminate().catch(() => 0);
  }

  private launch(first?: StartWaiter): void {
    const worker = this.options.spawn();
    this.worker = worker;
    this.ready = false;
    let everReady = false;
    const fail = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.ready = false;
      this.failPending(new WorkerUnavailableError(`The sync process stopped: ${reason}`));
      void worker.terminate().catch(() => 0);
      if (this.waitingForStop) return this.waitingForStop();
      if (this.stopping) return;
      if (first && !everReady) {
        return first.reject(new Error(`The sync process could not start: ${reason}`));
      }
      this.options.handlers.onCrash(reason);
      this.scheduleRestart(everReady);
    };
    worker.on("message", (message) => {
      if (this.worker !== worker) return;
      switch (message.type) {
        case "ready":
          this.ready = true;
          this.readyAtMs = Date.now();
          everReady = true;
          if (first) first.resolve({ seeded: message.seeded, ms: message.ms });
          else this.options.handlers.onRestarted();
          return;
        case "migrating":
          return this.options.handlers.onMigrating?.(message.step, message.total);
        case "result": {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          if (message.ok) waiting.resolve(message.value);
          else waiting.reject(new WorkerCommandError(message.error));
          return;
        }
        case "status":
          return this.options.handlers.onStatus(message.accountId, message.status);
        case "committed":
          return this.options.handlers.onCommitted();
        case "outbox":
          return this.options.handlers.onOutbox();
        case "moves":
          return this.options.handlers.onMoves();
        case "agent":
          return this.options.handlers.onAgent();
        case "views":
          return this.options.handlers.onViews?.();
        case "agentTalkStep":
          return this.options.handlers.onAgentTalkStep(
            message.query,
            message.threads,
            message.kind,
            message.note,
          );
        case "agentPrompt": {
          const { type: _type, ...progress } = message;
          return this.options.handlers.onAgentPrompt?.(progress);
        }
        case "moveRefused":
          return this.options.handlers.onMoveRefused(message.action, message.count);
        case "attachments":
          return this.options.handlers.onAttachments(message.draftId);
        case "attachmentProgress":
          return this.options.handlers.onAttachmentProgress(message.id, message.fraction);
        case "receivedProgress":
          return this.options.handlers.onReceivedProgress(
            message.messageKey,
            message.partId,
            message.bytes,
            message.totalBytes,
          );
        case "sendProgress":
          return this.options.handlers.onSendProgress(
            message.operationId,
            message.sentBytes,
            message.totalBytes,
          );
        case "captured":
          return this.options.handlers.onCaptured(message.ids);
        case "synced":
          return this.options.handlers.onSynced(
            message.accountId,
            message.scope,
            message.documents,
            message.durationMs,
          );
        case "credentials":
          return this.options.handlers.onCredentials(message.data, (data) =>
            worker.postMessage({ type: "credentials", data }),
          );
        case "stopped":
          return this.waitingForStop?.();
      }
    });
    worker.on("error", (error) => fail(error.message));
    worker.on("exit", (code) => fail(`exit code ${code}`));
  }

  private scheduleRestart(wasReady: boolean): void {
    const { backoffBaseMs = 500, backoffCapMs = 30_000, healthyAfterMs = 30_000 } = this.options;
    if (wasReady && Date.now() - this.readyAtMs >= healthyAfterMs) this.attempts = 0;
    const delay = backoffDelay(this.attempts++, Math.random(), backoffBaseMs, backoffCapMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      // A replacement that fails to start is another crash: the same loop, a longer delay.
      try {
        this.launch();
      } catch {
        this.scheduleRestart(false);
      }
    }, delay);
  }

  private failPending(error: Error): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.reject(error);
    }
  }
}
