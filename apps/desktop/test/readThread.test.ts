import { describe, expect, it, vi } from "vitest";
import type { HeavyRead } from "../src/backend/heavyReads.ts";
import { ReadThread, type ReadThreadWorker } from "../src/backend/readThread.ts";

/** A worker the test answers for. */
function fakeWorker() {
  const listeners: Record<string, ((value: never) => void)[]> = {};
  const sent: { id?: number; read?: HeavyRead; nowMs?: number; stop?: boolean }[] = [];
  const worker = {
    postMessage: (m: never) => sent.push(m),
    on: (event: string, listener: (value: never) => void) => {
      listeners[event] ??= [];
      listeners[event].push(listener);
    },
    terminate: vi.fn(async () => 1),
  };
  const emit = (event: string, value: unknown) => {
    for (const l of listeners[event] ?? []) l(value as never);
  };
  return { worker: worker as unknown as ReadThreadWorker, sent, emit, terminate: worker.terminate };
}

const started = (over: { local?: (read: HeavyRead) => Promise<unknown> } = {}) => {
  const fake = fakeWorker();
  const local = vi.fn(over.local ?? (async () => "here"));
  const thread = new ReadThread({ spawn: () => fake.worker, local, now: () => 1000, stopMs: 5 });
  thread.start();
  return { ...fake, local, thread };
};

const READ: HeavyRead = { name: "threadAgent", threadId: "t1" };

describe("ReadThread (ADR 0070, rule 2)", () => {
  it("asks the thread, with the time it was asked, and the router does none of the work", async () => {
    const { thread, sent, emit, local } = started();
    const answer = thread.ask(READ);
    expect(sent[0]).toEqual({ id: 1, read: READ, nowMs: 1000 });
    emit("message", { id: 1, ok: true, value: { available: true } });
    await expect(answer).resolves.toEqual({ available: true });
    expect(local).not.toHaveBeenCalled();
  });

  it("matches answers to questions when they come back in another order", async () => {
    const { thread, emit } = started();
    const first = thread.ask(READ);
    const second = thread.ask({ name: "threadAgent", threadId: "t" });
    emit("message", { id: 2, ok: true, value: "second" });
    emit("message", { id: 1, ok: true, value: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("answers on the router what the thread could not answer", async () => {
    const { thread, emit, local } = started();
    const answer = thread.ask(READ);
    emit("message", { id: 1, ok: false });
    await expect(answer).resolves.toBe("here");
    expect(local).toHaveBeenCalledWith(READ, 1000);
  });

  it("loses nothing when the thread dies, and stays on the router after it", async () => {
    const { thread, emit, sent, local } = started();
    const asked = thread.ask(READ);
    emit("exit", 1);
    await expect(asked).resolves.toBe("here");
    await expect(thread.ask(READ)).resolves.toBe("here");
    expect(sent).toHaveLength(1);
    expect(local).toHaveBeenCalledTimes(2);
  });

  it("works on the router when the thread cannot start", async () => {
    const local = vi.fn(async () => "here");
    const onDown = vi.fn();
    const thread = new ReadThread({
      spawn: () => {
        throw new Error("no threads today");
      },
      local,
      onDown,
    });
    thread.start();
    await expect(thread.ask(READ)).resolves.toBe("here");
    expect(onDown).toHaveBeenCalledWith("no threads today");
  });

  it("passes on a failure of the router's own read", async () => {
    const { thread, emit } = started({
      local: async () => {
        throw new Error("no such thread");
      },
    });
    const answer = thread.ask(READ);
    emit("message", { id: 1, ok: false });
    await expect(answer).rejects.toThrow("no such thread");
  });

  it("asks the thread to stop and ends it when it does not", async () => {
    const { thread, sent, terminate } = started();
    await thread.stop();
    expect(sent.at(-1)).toEqual({ stop: true });
    expect(terminate).toHaveBeenCalled();
  });

  it("does not end a thread that stopped when asked", async () => {
    const { thread, emit, terminate } = started();
    const stopping = thread.stop();
    emit("exit", 0);
    await stopping;
    expect(terminate).not.toHaveBeenCalled();
  });
});
