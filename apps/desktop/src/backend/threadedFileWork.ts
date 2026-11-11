import {
  type FileDirs,
  openSpool,
  readSpool,
  removeAttachments,
  removeSpool,
  statSource,
  sweep,
} from "@matters/adapter-files";
import type {
  BuiltMessage,
  CaptureJob,
  CaptureResult,
  ComposeInput,
  ExtractedText,
  FileTextExtractorPort,
  FileWorkPort,
  MimeSource,
} from "@matters/core";
import { FileWorkError } from "@matters/core";
import type { FromFileWorker, ToFileWorker } from "./fileWorkProtocol.ts";

/** The part of `worker_threads.Worker` the host uses. */
export interface FileWorkerLike {
  postMessage(message: ToFileWorker): void;
  on(event: "message", listener: (message: FromFileWorker) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface ThreadedFileWorkOptions {
  /** Starts the attachment worker thread; called on first use and again after it ended. */
  readonly spawn: () => FileWorkerLike;
  /** The two directories. Reads and deletions that cost nothing run on the caller's thread. */
  readonly dirs: FileDirs;
  /** The thread exits after this long without a job (ADR 0041, rule 4). Default 30 s. */
  readonly idleMs?: number;
  /** Jobs running at once; the rest wait their turn. Default 2. */
  readonly maxJobs?: number;
}

interface Job {
  readonly id: number;
  readonly message: ToFileWorker;
  readonly onProgress: ((fraction: number) => void) | undefined;
  readonly resolve: (value: never) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  unlisten: () => void;
}

const IDLE_MS = 30_000;
const MAX_JOBS = 2;

/**
 * `FileWorkPort` over a worker thread of its own (ADR 0041, rule 4). Capturing, hashing and
 * building run there; opening a spool, reading one and `stat` are cheap and run here. The thread
 * starts with the first job, exits when it has had none for a while, and when it dies with jobs
 * in flight only those jobs fail: the ones still waiting go to its replacement.
 */
export class ThreadedFileWork implements FileWorkPort, FileTextExtractorPort {
  private readonly options: ThreadedFileWorkOptions;
  private worker: FileWorkerLike | null = null;
  private nextId = 0;
  private spawns = 0;
  private disposed = false;
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<number, Job>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ThreadedFileWorkOptions) {
    this.options = options;
  }

  /** True while the thread is up. */
  get running(): boolean {
    return this.worker !== null;
  }

  /** How many threads were started so far (tests and diagnostics). */
  get spawned(): number {
    return this.spawns;
  }

  capture(
    job: CaptureJob,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<CaptureResult> {
    return this.submit(
      (id) => ({
        type: "capture",
        id,
        attachmentId: job.attachmentId,
        sourcePath: job.sourcePath,
      }),
      onProgress,
      signal,
    );
  }

  buildMessage(
    input: ComposeInput,
    files: readonly { attachmentId: string; name: string; sha256: string }[],
    operationId: string,
  ): Promise<BuiltMessage> {
    return this.submit((id) => ({ type: "build", id, input, files, operationId }));
  }

  /** Reads the text of a received file on the thread (ADR 0087, rule 3). */
  extractText(job: Parameters<FileTextExtractorPort["extractText"]>[0]): Promise<ExtractedText> {
    return this.submit((id) => ({
      type: "text",
      id,
      sourcePath: job.sourcePath,
      kind: job.kind,
    }));
  }

  openSpool(path: string): MimeSource {
    return openSpool(path);
  }

  readSpool(path: string): Promise<Uint8Array> {
    return readSpool(path);
  }

  statSource(path: string): Promise<{ mtimeMs: number; size: number } | null> {
    return statSource(path);
  }

  removeAttachments(ids: readonly string[]): Promise<void> {
    return removeAttachments(this.options.dirs, ids);
  }

  removeSpool(path: string): Promise<void> {
    return removeSpool(this.options.dirs, path);
  }

  sweep(keepAttachmentIds: readonly string[], keepSpoolPaths: readonly string[]): Promise<void> {
    return sweep(this.options.dirs, keepAttachmentIds, keepSpoolPaths);
  }

  /** Ends the thread; every job not finished fails. Nothing starts again afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdle();
    const error = new FileWorkError("unreadable", "The app is closing");
    for (const job of [...this.queue.splice(0), ...this.inFlight.values()]) this.finish(job, error);
    this.inFlight.clear();
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate().catch(() => 0);
  }

  private submit<T>(
    make: (id: number) => ToFileWorker,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new FileWorkError("unreadable", "The app is closing"));
    }
    if (signal?.aborted) return Promise.reject(stopped());
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const job: Job = {
        id,
        message: make(id),
        onProgress,
        resolve: resolve as (value: never) => void,
        reject,
        signal,
        unlisten: () => {},
      };
      if (signal) {
        const onAbort = () => this.abort(job);
        signal.addEventListener("abort", onAbort, { once: true });
        job.unlisten = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private abort(job: Job): void {
    const waiting = this.queue.indexOf(job);
    if (waiting >= 0) {
      this.queue.splice(waiting, 1);
      this.finish(job, stopped());
      this.armIdle();
      return;
    }
    // Running: the thread removes the partial copy and reports the job as failed.
    if (this.inFlight.has(job.id)) this.worker?.postMessage({ type: "abort", id: job.id });
  }

  private pump(): void {
    const { maxJobs = MAX_JOBS } = this.options;
    while (!this.disposed && this.inFlight.size < maxJobs) {
      const job = this.queue.shift();
      if (!job) break;
      this.clearIdle();
      let worker: FileWorkerLike;
      try {
        worker = this.ensureWorker();
      } catch (error) {
        this.finish(job, new FileWorkError("unreadable", "The file work could not start"));
        console.error(
          "matters-sync: attachment worker:",
          error instanceof Error ? error.message : "unknown",
        );
        continue;
      }
      this.inFlight.set(job.id, job);
      worker.postMessage(job.message);
    }
    this.armIdle();
  }

  private ensureWorker(): FileWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.options.spawn();
    this.worker = worker;
    this.spawns++;
    worker.on("message", (message) => {
      if (this.worker === worker) this.onMessage(message);
    });
    const died = (reason: string) => this.onDied(worker, reason);
    worker.on("error", (error) => died(error.message));
    worker.on("exit", (code) => died(`exit code ${code}`));
    return worker;
  }

  private onMessage(message: FromFileWorker): void {
    const job = this.inFlight.get(message.id);
    if (!job) return;
    if (message.type === "progress") {
      job.onProgress?.(message.fraction);
      return;
    }
    this.inFlight.delete(job.id);
    if (message.type === "done") {
      job.unlisten();
      job.resolve(message.value as never);
    } else {
      const { kind, message: text, file } = message.error;
      this.finish(job, new FileWorkError(kind, text, file));
    }
    this.pump();
  }

  /** The thread ended without being asked to: the jobs it held fail, the queue goes on. */
  private onDied(worker: FileWorkerLike, reason: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    void worker.terminate().catch(() => 0);
    console.error(`matters-sync: attachment worker stopped (${reason})`);
    const lost = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const job of lost) {
      this.finish(job, new FileWorkError("unreadable", "The file work stopped unexpectedly"));
    }
    this.pump();
  }

  private finish(job: Job, error: Error): void {
    job.unlisten();
    job.reject(error);
  }

  private armIdle(): void {
    if (this.disposed || !this.worker || this.inFlight.size > 0 || this.queue.length > 0) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const worker = this.worker;
      if (!worker || this.inFlight.size > 0) return;
      // Forget it first, so its exit is not mistaken for a crash.
      this.worker = null;
      void worker.terminate().catch(() => 0);
    }, this.options.idleMs ?? IDLE_MS);
    // Waiting to retire a thread must not keep the process alive.
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function stopped(): FileWorkError {
  return new FileWorkError("unreadable", "The copy was stopped");
}
