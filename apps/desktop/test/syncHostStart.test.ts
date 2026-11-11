import { describe, expect, it } from "vitest";
import type { FromWorker, ToWorker } from "../src/backend/protocol.ts";
import { SyncHost, type SyncHostHandlers, type WorkerLike } from "../src/backend/syncHost.ts";

// ADR 0046, rule 1: reads are served before the worker is up, so a command that arrives while
// the first worker is still starting waits for it; after a crash it still fails fast, as before.
class FakeWorker implements WorkerLike {
  readonly sent: ToWorker[] = [];
  private onMessage: (m: FromWorker) => void = () => {};
  private onExit: (code: number) => void = () => {};
  postMessage(message: ToWorker): void {
    this.sent.push(message);
    if (message.type === "command") {
      queueMicrotask(() => this.onMessage({ type: "result", id: message.id, ok: true, value: 7 }));
    }
  }
  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "message") this.onMessage = listener as (m: FromWorker) => void;
    if (event === "exit") this.onExit = listener as (code: number) => void;
    return this;
  }
  emit(m: FromWorker): void {
    this.onMessage(m);
  }
  exit(code: number): void {
    this.onExit(code);
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
}

const handlers = new Proxy({} as SyncHostHandlers, { get: () => () => {} });

describe("SyncHost before the first worker is ready", () => {
  it("holds a command until the worker is ready, then runs it", async () => {
    const worker = new FakeWorker();
    const host = new SyncHost({ spawn: () => worker, handlers });
    const started = host.start();
    const answer = host.command({ name: "probeMessageLimit", accountId: "a" });
    await Promise.resolve();
    expect(worker.sent).toEqual([]);
    worker.emit({ type: "ready", seeded: 0, ms: 1 });
    await started;
    await expect(answer).resolves.toBe(7);
    expect(worker.sent).toHaveLength(1);
  });

  it("fails the held command when the first worker cannot start", async () => {
    const worker = new FakeWorker();
    const host = new SyncHost({ spawn: () => worker, handlers });
    const started = host.start();
    const startFailed = expect(started).rejects.toThrow("could not start");
    const answer = host.command({ name: "probeMessageLimit", accountId: "a" });
    const commandFailed = expect(answer).rejects.toThrow();
    worker.exit(1);
    await startFailed;
    await commandFailed;
  });

  it("still fails fast once the worker has been up and is gone", async () => {
    const worker = new FakeWorker();
    const host = new SyncHost({ spawn: () => worker, handlers, backoffBaseMs: 60_000 });
    const started = host.start();
    worker.emit({ type: "ready", seeded: 0, ms: 1 });
    await started;
    worker.exit(1);
    await expect(host.command({ name: "probeMessageLimit", accountId: "a" })).rejects.toThrow(
      "restarting",
    );
    await host.stop(10);
  });
});
