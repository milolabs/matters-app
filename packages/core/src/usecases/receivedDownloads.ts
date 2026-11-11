import { mailErrorKind } from "../domain/errors.ts";
import {
  planSweep,
  RECEIVED_MAX_AGE_MS,
  RECEIVED_MAX_BYTES,
  receivedId,
} from "../domain/received.ts";
import type { MailConnection, MessageStorePort, ReceivedFilesPort } from "../ports/index.ts";

/** What a download needs of a connection: the part fetcher, and the way to let go of it. */
export type DownloadConnection = Pick<MailConnection, "attachments" | "close">;

/**
 * How asking for a received file ended (ADR 0043, rule 9).
 *
 * - `done`: the copy is in the cache.
 * - `gone`: the message is no longer on the server (or never was). Definite: a retry would
 *   say the same, so there is none.
 * - `offline`: the server could not be reached. Try again later.
 * - `failed`: anything else; `message` is for the log, not for the person.
 * - `cancelled`: every one who asked for it gave up while it ran (ADR 0045), so it was stopped.
 *   Only an asker that passed a signal can be told this.
 */
export type FetchOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "gone" }
  | { readonly kind: "offline"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface ReceivedDeps {
  readonly store: Pick<MessageStorePort, "getAttachment" | "getLocations">;
  readonly files: ReceivedFilesPort;
  /**
   * A connection of its own to the account's server (ADR 0043, rule 6): a large download never
   * holds up sync. Null when the account is gone. Failures carry a `kind`, as `connect` does.
   */
  open(accountId: string): Promise<DownloadConnection | null>;
}

/** What one asker brings to a download it may share with others. */
export interface FetchWatch {
  /**
   * The asker no longer wants the file. The download stops when every asker has said so, and an
   * asker that passed no signal never does: a reader waiting for it keeps it alive.
   */
  readonly signal?: AbortSignal;
  /** Bytes written so far and what the whole part is expected to be, for this asker alone. */
  readonly onBytes?: (bytes: number, total: number) => void;
}

/** A download and the askers sharing it. */
interface Running {
  readonly promise: Promise<FetchOutcome>;
  readonly controller: AbortController;
  readonly watchers: Set<NonNullable<FetchWatch["onBytes"]>>;
  askers: number;
  abandoned: number;
}

export interface ReceivedOptions {
  /** Downloads at the same time for one account; default 2. */
  readonly perAccount?: number;
  /** Bytes written so far and what the whole part is expected to be. Called often: throttle it. */
  readonly onProgress?: (messageKey: number, partId: string, bytes: number, total: number) => void;
}

const DEFAULT_PER_ACCOUNT = 2;

/** Hands out `limit` places at a time, in the order they were asked for. */
class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.free = limit;
  }

  async take(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/**
 * Downloads received files on demand (ADR 0043, rules 6, 7 and 9). The same part asked for twice
 * joins the download that is running; at most `perAccount` run at once for an account and the
 * rest wait their turn. Nothing here touches a database write or a transaction.
 */
export class ReceivedDownloads {
  private readonly deps: ReceivedDeps;
  private readonly perAccount: number;
  private readonly onProgress: NonNullable<ReceivedOptions["onProgress"]>;
  private readonly running = new Map<string, Running>();
  private readonly slots = new Map<string, Slots>();
  private readonly controller = new AbortController();

  constructor(deps: ReceivedDeps, options: ReceivedOptions = {}) {
    this.deps = deps;
    this.perAccount = options.perAccount ?? DEFAULT_PER_ACCOUNT;
    this.onProgress = options.onProgress ?? (() => {});
  }

  /** Parts being downloaded now, as `receivedId`s: the sweep leaves them alone. */
  inUse(): ReadonlySet<string> {
    return new Set(this.running.keys());
  }

  /** Cuts every download short (quit). Each ends as `failed`; nothing partial is left behind. */
  abortAll(): void {
    this.controller.abort();
  }

  /** The app is quitting: a download that failed did so because it was cut short. */
  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  fetch(messageKey: number, partId: string, watch: FetchWatch = {}): Promise<FetchOutcome> {
    const id = receivedId(messageKey, partId);
    let entry = this.running.get(id);
    // A download everyone gave up on is still winding down; a new asker starts its own.
    if (!entry || entry.controller.signal.aborted) entry = this.start(id, messageKey, partId);
    return this.join(entry, watch);
  }

  private start(id: string, messageKey: number, partId: string): Running {
    const controller = new AbortController();
    const watchers = new Set<NonNullable<FetchWatch["onBytes"]>>();
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    const promise = this.run(messageKey, partId, signal, (bytes, total) => {
      this.onProgress(messageKey, partId, bytes, total);
      for (const watcher of watchers) watcher(bytes, total);
    }).finally(() => {
      if (this.running.get(id) === entry) this.running.delete(id);
    });
    const entry: Running = { promise, controller, watchers, askers: 0, abandoned: 0 };
    this.running.set(id, entry);
    return entry;
  }

  /** One more asker on a running download; it leaves when its signal says so. */
  private join(entry: Running, watch: FetchWatch): Promise<FetchOutcome> {
    const { signal, onBytes } = watch;
    if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
    entry.askers++;
    if (onBytes) entry.watchers.add(onBytes);
    if (!signal) return entry.promise;
    return new Promise<FetchOutcome>((resolve) => {
      const leave = () => {
        entry.abandoned++;
        if (onBytes) entry.watchers.delete(onBytes);
        // The last one out stops the download. A reader (no signal) is never counted out.
        if (entry.abandoned === entry.askers) entry.controller.abort();
        resolve({ kind: "cancelled" });
      };
      signal.addEventListener("abort", leave, { once: true });
      void entry.promise.then((outcome) => {
        signal.removeEventListener("abort", leave);
        resolve(outcome);
      });
    });
  }

  private async run(
    messageKey: number,
    partId: string,
    signal: AbortSignal,
    onBytes: (bytes: number, total: number) => void,
  ): Promise<FetchOutcome> {
    const { store, files } = this.deps;
    try {
      const attachment = await store.getAttachment(messageKey, partId);
      if (!attachment) return { kind: "gone" };
      // A copy already here costs no connection: this is what makes a file open offline.
      if (await files.touch(messageKey, partId)) return { kind: "done" };
      const locations = await store.getLocations(messageKey);
      const accountId = locations[0]?.accountId;
      if (accountId === undefined) return { kind: "gone" };

      const release = await this.slotsOf(accountId).take();
      try {
        // Everyone may have given up while this waited for its turn.
        signal.throwIfAborted();
        // Another asker may have finished it while this one waited its turn.
        if (await files.touch(messageKey, partId)) return { kind: "done" };
        return await this.download(accountId, messageKey, partId, attachment, signal, onBytes);
      } finally {
        release();
      }
    } catch (error) {
      return this.classify(error, signal);
    }
  }

  private async download(
    accountId: string,
    messageKey: number,
    partId: string,
    attachment: { readonly name: string; readonly size: number },
    signal: AbortSignal,
    onBytes: (bytes: number, total: number) => void,
  ): Promise<FetchOutcome> {
    const connection = await this.deps.open(accountId);
    if (!connection) return { kind: "gone" };
    try {
      // Every folder the message is in holds the same part; the first that still has it will do.
      for (const location of await this.deps.store.getLocations(messageKey)) {
        const part = await connection.attachments.download(location, partId, signal);
        if (part.kind === "gone") continue;
        await this.deps.files.write(
          messageKey,
          partId,
          attachment.name,
          part.content,
          (written) =>
            // The row's size is an estimate, so the total never falls behind the bytes written.
            onBytes(written, Math.max(attachment.size, written)),
          signal,
        );
        return { kind: "done" };
      }
      return { kind: "gone" };
    } finally {
      await connection.close().catch(() => {});
    }
  }

  private classify(error: unknown, signal: AbortSignal): FetchOutcome {
    // Stopped because nobody wanted it any more; a quit is a failure, as it always was.
    if (signal.aborted && !this.controller.signal.aborted) return { kind: "cancelled" };
    const kind = mailErrorKind(error);
    const message = error instanceof Error ? error.message : "The download failed";
    return kind === "unreachable" || kind === "tls"
      ? { kind: "offline", message }
      : { kind: "failed", message };
  }

  private slotsOf(accountId: string): Slots {
    let slots = this.slots.get(accountId);
    if (!slots) {
      slots = new Slots(this.perAccount);
      this.slots.set(accountId, slots);
    }
    return slots;
  }
}

export interface SweepDeps {
  readonly files: ReceivedFilesPort;
  readonly nowMs: number;
  /** Parts being downloaded or opened right now. */
  readonly inUse: ReadonlySet<string>;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
}

/**
 * The cache's start-up sweep (ADR 0043, rule 8): files nobody used for a week go, then the oldest
 * until 2 GB remain. Returns how many files were deleted.
 */
export async function sweepReceived(deps: SweepDeps): Promise<number> {
  const doomed = planSweep(await deps.files.list(), {
    nowMs: deps.nowMs,
    maxAgeMs: deps.maxAgeMs ?? RECEIVED_MAX_AGE_MS,
    maxBytes: deps.maxBytes ?? RECEIVED_MAX_BYTES,
    inUse: deps.inUse,
  });
  if (doomed.length > 0) await deps.files.remove(doomed);
  return doomed.length;
}
