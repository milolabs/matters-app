import type { PreparedWork, PrepareResult, ThreadAgentView } from "@matters/core";
import { describe, expect, it } from "vitest";
import { COALESCE_MS, createAgentStore } from "../src/renderer/agent.ts";
import type { Backend } from "../src/renderer/client.ts";
import { createThreadAgent, type OpenThreadRef } from "../src/renderer/threadAgent.ts";

const draft = (body = "Hi Anna,\n\nTuesday works."): PreparedWork => ({
  kind: "draft",
  body,
  nudge: false,
});
const question: PreparedWork = { kind: "needs", missing: "Which day?", directions: ["Mon", "Fri"] };

const view = (over: Partial<ThreadAgentView> = {}): ThreadAgentView => ({
  available: true,
  prepared: null,
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A thread answer the test lets go when it likes. */
function gate<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup(
  answer: (threadId: string, call: number) => Promise<ThreadAgentView> | ThreadAgentView,
) {
  const asked: string[] = [];
  const prepareCalls: unknown[][] = [];
  const listeners: ((e: { type: string }) => void)[] = [];
  let timers: (() => void)[] = [];
  const backend = {
    agentThread: async (id: string) => {
      asked.push(id);
      return answer(id, asked.length);
    },
    agentPrepare: async (...args: unknown[]) => {
      prepareCalls.push(args);
      return draft() as PrepareResult;
    },
    onEvent: (l: (e: { type: string }) => void) => {
      listeners.push(l);
      return () => {};
    },
  } as unknown as Backend;
  let open: OpenThreadRef | null = null;
  const agent = createAgentStore(backend, { openDraft: async () => {}, now: () => 1 });
  const ta = createThreadAgent({
    backend,
    agent,
    open: () => open,
    schedule: (run) => {
      timers.push(run);
      return () => {
        timers = timers.filter((t) => t !== run);
      };
    },
  });
  return {
    ta,
    agent,
    asked,
    prepareCalls,
    openThread: (next: OpenThreadRef | null) => {
      open = next;
      ta.sync();
    },
    emit: () => {
      for (const l of listeners) l({ type: "agentChanged" });
    },
    pending: () => timers.length,
    fire: () => {
      const t = timers;
      timers = [];
      for (const r of t) r();
    },
  };
}

const A = (key = 10): OpenThreadRef => ({ id: "a", lastMessageKey: key, subject: "About A" });
const B = (key = 20): OpenThreadRef => ({ id: "b", lastMessageKey: key, subject: "About B" });

describe("the agent in an ordinary thread (ADR 0063)", () => {
  it("loads when the open thread or its last message changes, and not otherwise", async () => {
    const s = setup(() => view({ prepared: draft() }));
    expect(s.ta.available()).toBe(false);
    s.openThread(A(10));
    await flush();
    expect(s.asked).toEqual(["a"]);
    expect(s.ta.available()).toBe(true);
    expect(s.ta.prepared()).toEqual(draft());
    s.ta.sync();
    s.openThread(A(10));
    await flush();
    expect(s.asked).toEqual(["a"]);
    s.openThread(A(11));
    await flush();
    expect(s.asked).toEqual(["a", "a"]);
    s.openThread(B());
    await flush();
    expect(s.asked).toEqual(["a", "a", "b"]);
    s.openThread(null);
    expect(s.ta.available()).toBe(false);
    expect(s.ta.prepared()).toBeNull();
  });

  it("shows the work when there is some, and nothing when AI is not available", async () => {
    const s = setup((id) =>
      id === "a" ? view({ prepared: question }) : { available: false, prepared: null },
    );
    s.openThread(A());
    await flush();
    expect(s.ta.prepared()).toEqual(question);
    s.openThread(B());
    await flush();
    expect(s.ta.available()).toBe(false);
    expect(s.ta.prepared()).toBeNull();
  });

  it("drops an answer that comes after the person moved on, and never shows one thread's work on another", async () => {
    const slow = gate<ThreadAgentView>();
    const s = setup((id) => (id === "a" ? slow.promise : view({ prepared: question })));
    s.openThread(A());
    s.openThread(B());
    await flush();
    expect(s.ta.prepared()).toEqual(question);
    slow.release(view({ prepared: draft("WORK OF A") }));
    await flush();
    expect(s.ta.prepared()).toEqual(question);
    // Back on A, its old answer never arrives again; the work of B is not A's.
    s.openThread(A(12));
    expect(s.ta.prepared()).toBeNull();
  });

  it("shows nothing between a new last message and its answer", async () => {
    const next = gate<ThreadAgentView>();
    const s = setup((_, n) => (n === 1 ? view({ prepared: draft() }) : next.promise));
    s.openThread(A(10));
    await flush();
    expect(s.ta.prepared()).toEqual(draft());
    s.openThread(A(11));
    expect(s.ta.prepared()).toBeNull();
    next.release(view());
    await flush();
    expect(s.ta.prepared()).toBeNull();
    expect(s.ta.available()).toBe(true);
  });

  it("reads again after a push, once for several pushes close together", async () => {
    let work: PreparedWork | null = null;
    const s = setup(() => view({ prepared: work }));
    s.openThread(A());
    await flush();
    work = draft("made meanwhile");
    s.emit();
    s.emit();
    expect(s.pending()).toBe(1);
    expect(s.asked).toHaveLength(1);
    s.fire();
    await flush();
    expect(s.asked).toHaveLength(2);
    expect(s.ta.prepared()).toEqual(draft("made meanwhile"));
    expect(COALESCE_MS).toBeGreaterThan(0);
  });

  it("does not read for a push while no thread is open", async () => {
    const s = setup(() => view());
    s.emit();
    s.fire();
    await flush();
    expect(s.asked).toEqual([]);
  });

  it("hides dismissed work until the thread's last message changes", async () => {
    const s = setup(() => view({ prepared: draft() }));
    s.openThread(A(10));
    await flush();
    s.ta.dismiss();
    expect(s.ta.prepared()).toBeNull();
    // A read of the same thread does not bring it back, and the offer is what shows.
    s.emit();
    s.fire();
    await flush();
    expect(s.ta.prepared()).toBeNull();
    expect(s.ta.available()).toBe(true);
    // Another thread is not affected, and a new message makes the backend's work the truth again.
    s.openThread(B());
    await flush();
    expect(s.ta.prepared()).toEqual(draft());
    s.openThread(A(11));
    await flush();
    expect(s.ta.prepared()).toEqual(draft());
    // Dismissing records nothing anywhere.
    expect(s.prepareCalls).toEqual([]);
  });

  it("sends the draft shown, and then hides it; an existing draft of the person's keeps it", async () => {
    const calls: string[] = [];
    let existing = true;
    const backend = {
      agentThread: async () => view({ prepared: draft("BODY") }),
      agentDraftFromPrepared: async (id: string, body: string) => {
        calls.push(`draft:${id}:${body}`);
        return { draftId: "d1", existing };
      },
      requestSend: async (id: string) => {
        calls.push(`send:${id}`);
        return {};
      },
      onEvent: () => () => {},
    } as unknown as Backend;
    const opened: string[] = [];
    const agent = createAgentStore(backend, {
      openDraft: async (id) => {
        opened.push(id);
      },
      now: () => 1,
    });
    const ta = createThreadAgent({ backend, agent, open: () => A(10) });
    ta.sync();
    await flush();
    expect(ta.readyDraft()).toBe("BODY");
    expect(await ta.send()).toBe("openedExisting");
    expect(opened).toEqual(["d1"]);
    expect(calls).toEqual(["draft:a:BODY"]);
    expect(ta.prepared()).toEqual(draft("BODY"));
    existing = false;
    expect(await ta.send()).toBe("sent");
    expect(calls).toEqual(["draft:a:BODY", "draft:a:BODY", "send:d1"]);
    expect(ta.prepared()).toBeNull();
    expect(ta.readyDraft()).toBeNull();
    expect(await ta.send()).toBe("none");
  });

  it("takes the draft into the composer and hides it, unless the person already had a draft", async () => {
    let existing = true;
    const backend = {
      agentThread: async () => view({ prepared: draft("BODY") }),
      agentDraftFromPrepared: async () => ({ draftId: "d1", existing }),
      onEvent: () => () => {},
    } as unknown as Backend;
    const agent = createAgentStore(backend, { openDraft: async () => {}, now: () => 1 });
    const ta = createThreadAgent({ backend, agent, open: () => A(10) });
    ta.sync();
    await flush();
    expect(await ta.editMyself()).toBe("existing");
    expect(ta.prepared()).toEqual(draft("BODY"));
    existing = false;
    expect(await ta.editMyself()).toBe("took");
    expect(ta.prepared()).toBeNull();
  });

  it("asks only when the person does, then reads again so the backend's work is what shows", async () => {
    let stored: PreparedWork | null = null;
    const s = setup(() => view({ prepared: stored }));
    s.openThread(A(10));
    await flush();
    s.openThread(B(20));
    s.openThread(A(10));
    await flush();
    expect(s.prepareCalls).toEqual([]);
    const asking = s.ta.ask("  Tuesday 10:00  ");
    expect(s.ta.busy()).toBe(true);
    stored = draft("Tuesday 10:00 works");
    await asking;
    expect(s.ta.busy()).toBe(false);
    expect(s.prepareCalls).toEqual([["a", { answer: "Tuesday 10:00" }]]);
    expect(s.ta.prepared()).toEqual(draft("Tuesday 10:00 works"));
    // Without words there is no guidance at all.
    await s.ta.ask();
    expect(s.prepareCalls[1]).toEqual(["a", undefined]);
  });

  it("passes the direction a question was answered with", async () => {
    const s = setup(() => view({ prepared: question }));
    s.openThread(A());
    await flush();
    expect(s.ta.pickDirection("2")).toBe(true);
    expect(s.ta.pickDirection("3")).toBe(false);
    expect(s.agent.directionOf("a")).toBe("Fri");
    await s.ta.ask("", s.agent.directionOf("a"));
    expect(s.prepareCalls).toEqual([["a", { direction: "Fri" }]]);
  });

  it("shows new work after a dismissal when the person asks again", async () => {
    let stored: PreparedWork | null = draft("first");
    const s = setup(() => view({ prepared: stored }));
    s.openThread(A());
    await flush();
    s.ta.dismiss();
    expect(s.ta.prepared()).toBeNull();
    stored = draft("second");
    await s.ta.ask();
    expect(s.ta.prepared()).toEqual(draft("second"));
  });

  it("keeps the offer when an ask fails, and says why for that thread only", async () => {
    const backend = {
      agentThread: async () => view({ prepared: draft("old") }),
      agentPrepare: async () => {
        throw new Error("nope");
      },
      onEvent: () => () => {},
    } as unknown as Backend;
    const agent = createAgentStore(backend, { openDraft: async () => {}, now: () => 1 });
    let open: OpenThreadRef = A();
    const ta = createThreadAgent({ backend, agent, open: () => open });
    ta.sync();
    await flush();
    ta.dismiss();
    await ta.ask();
    expect(ta.prepared()).toBeNull();
    expect(ta.problem()).toBe("The agent could not prepare this. Try again.");
    open = B();
    ta.sync();
    await flush();
    expect(ta.problem()).toBe("");
    open = A();
    expect(ta.problem()).toBe("The agent could not prepare this. Try again.");
  });

  it("opening threads never calls agentPrepare", async () => {
    const s = setup(() => view({ prepared: question }));
    for (let i = 0; i < 5; i++) {
      s.openThread(A(10 + i));
      s.openThread(B(20 + i));
      s.emit();
      s.fire();
      await flush();
    }
    s.openThread(null);
    expect(s.asked.length).toBeGreaterThan(5);
    expect(s.prepareCalls).toEqual([]);
  });
});
