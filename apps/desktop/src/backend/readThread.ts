import type { HeavyAnswer, HeavyRead } from "./heavyReads.ts";

/** The part of a `Worker` this uses. */
export interface ReadThreadWorker {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface ReadThreadOptions {
  readonly spawn: () => ReadThreadWorker;
  /** Answers a read on the router: when the thread is gone, or could not answer it. */
  readonly local: (read: HeavyRead, nowMs: number) => Promise<unknown>;
  readonly onDown?: (reason: string) => void;
  readonly now?: () => number;
  readonly stopMs?: number;
}

interface Waiting {
  readonly read: HeavyRead;
  readonly nowMs: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The router's side of the read thread (ADR 0070, rule 2): a thread with its own read-only connection,
 * for the reads that take long. A read is never lost to it. Until the thread is up the messages wait
 * in its port, and whatever it has not answered when it ends is answered here, on the router, as all
 * of them were before. It is not started again: slower is still right, and a thread that cannot
 * start would only cost more.
 */
export class ReadThread {
  private readonly options: ReadThreadOptions;
  private worker: ReadThreadWorker | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, Waiting>();
  private exited: Promise<void> = Promise.resolve();

  constructor(options: ReadThreadOptions) {
    this.options = options;
  }

  start(): void {
    let worker: ReadThreadWorker;
    try {
      worker = this.options.spawn();
    } catch (error) {
      this.gone(error instanceof Error ? error.message : "could not start");
      return;
    }
    this.worker = worker;
    this.exited = new Promise((resolve) => {
      worker.on("exit", (code) => {
        this.gone(`exited with ${code}`);
        resolve();
      });
    });
    worker.on("error", (error) => this.gone(error.message));
    worker.on("message", (message) => this.answer(message));
  }

  ask<R extends HeavyRead>(read: R): Promise<HeavyAnswer<R>> {
    const nowMs = (this.options.now ?? Date.now)();
    const worker = this.worker;
    if (worker === null) return this.options.local(read, nowMs) as Promise<HeavyAnswer<R>>;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, {
        read,
        nowMs,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      worker.postMessage({ id, read, nowMs });
    });
  }

  /** Lets the thread close its connection, and ends it if it does not. */
  async stop(): Promise<void> {
    const worker = this.worker;
    if (worker === null) return;
    worker.postMessage({ stop: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.options.stopMs ?? 1000);
    });
    const how = await Promise.race([this.exited.then(() => "exited" as const), late]);
    clearTimeout(timer);
    if (how === "late") await worker.terminate();
  }

  private answer(message: unknown): void {
    const m = (message ?? {}) as { id?: unknown; ok?: unknown; value?: unknown };
    if (typeof m.id !== "number") return;
    const waiting = this.waiting.get(m.id);
    if (waiting === undefined) return;
    this.waiting.delete(m.id);
    if (m.ok === true) waiting.resolve(m.value);
    else this.runHere(waiting);
  }

  private gone(reason: string): void {
    if (this.worker === null && this.waiting.size === 0) {
      this.options.onDown?.(reason);
      return;
    }
    this.worker = null;
    this.options.onDown?.(reason);
    const left = [...this.waiting.values()];
    this.waiting.clear();
    for (const waiting of left) this.runHere(waiting);
  }

  private runHere(waiting: Waiting): void {
    this.options.local(waiting.read, waiting.nowMs).then(waiting.resolve, waiting.reject);
  }
}
