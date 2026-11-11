import type { PreparedWork, ThingFeedback, ThreadAnalysis } from "@matters/core";
import { describe, expect, it } from "vitest";
import { type AgentReadDeps, readThreadAgent } from "../src/backend/agentReads.ts";

const NOW = 1_800_000_000_000;
const KEY = 77;

const factOf = (who: "you" | "them") => ({
  kind: "ask" as const,
  who,
  evidence: { quote: "Please send", messageKey: KEY },
});

const analysis = (over: Partial<ThreadAnalysis> = {}): ThreadAnalysis => ({
  threadId: "t1",
  lastMessageKey: KEY,
  analyzerVersion: 99,
  analyzedAtMs: NOW - 1000,
  state: "onYou",
  headline: "Send the offer",
  facts: [factOf("you")],
  stakes: "none",
  confidence: 0.9,
  ...over,
});

const draft: PreparedWork = { kind: "draft", body: "Hi", nudge: false };

interface Setup {
  readonly enabled?: boolean;
  readonly consented?: boolean;
  readonly analysis?: ThreadAnalysis | null;
  readonly feedback?: readonly ThingFeedback[];
  readonly rules?: readonly unknown[];
  readonly prepared?: PreparedWork | null;
  readonly missing?: boolean;
}

function setup(o: Setup = {}) {
  const reads: string[] = [];
  const note =
    <T>(name: string, value: T) =>
    async (..._args: unknown[]) => {
      reads.push(name);
      return value;
    };
  const deps = {
    settings: {
      get: note("settings", { enabled: o.enabled ?? true, runtimeId: "fake" }),
      listConsents: note(
        "consents",
        o.consented === false ? [] : [{ accountId: "acc1", runtimeId: "fake" }],
      ),
    },
    store: {
      getThread: async () => {
        reads.push("thread");
        return o.missing === true
          ? null
          : {
              thread: { accountId: "acc1", lastMessageKey: KEY },
              messages: [{ from: { address: "anna@northwind.example" } }],
            };
      },
    },
    accounts: { list: note("accounts", [{ address: "me@example.com" }]) },
    insights: {
      listAnalyses: note("analyses", o.analysis === null ? [] : [o.analysis ?? analysis()]),
      getPrepared: async () => {
        reads.push("prepared");
        return o.prepared === null ? null : { work: o.prepared ?? draft };
      },
      listFeedback: note("feedback", o.feedback ?? []),
      listRules: note("rules", o.rules ?? []),
    },
  } as unknown as AgentReadDeps;
  return { deps, reads };
}

const read = (o?: Setup) => {
  const { deps, reads } = setup(o);
  return readThreadAgent(deps, "t1", NOW).then((view) => ({ view, reads }));
};

describe("what the agent already has for one thread (ADR 0063)", () => {
  it("gives the reading and the prepared work", async () => {
    const { view } = await read();
    expect(view).toEqual({
      available: true,
      reading: { state: "onYou", headline: "Send the offer" },
      facts: [{ kind: "ask", who: "you", quote: "Please send", messageKey: KEY }],
      prepared: draft,
    });
    expect(
      (await read({ analysis: analysis({ state: "waiting", facts: [factOf("them")] }) })).view
        .reading?.state,
    ).toBe("waiting");
  });

  it("is unavailable while AI is off, and reads nothing else", async () => {
    const { view, reads } = await read({ enabled: false });
    expect(view).toEqual({ available: false, reading: null, facts: [], prepared: null });
    expect(reads).toEqual(["settings"]);
  });

  it("is unavailable for an account without consent, and reads no analysis or work", async () => {
    const { view, reads } = await read({ consented: false });
    expect(view).toEqual({ available: false, reading: null, facts: [], prepared: null });
    expect(reads).not.toContain("analyses");
    expect(reads).not.toContain("prepared");
    expect(reads).not.toContain("feedback");
  });

  it("is unavailable for a thread that is not there", async () => {
    expect((await read({ missing: true })).view.available).toBe(false);
  });

  it("reads only this thread's analysis", async () => {
    const { deps } = setup();
    let asked: unknown;
    (deps.insights as { listAnalyses: unknown }).listAnalyses = async (...args: unknown[]) => {
      asked = args;
      return [analysis()];
    };
    await readThreadAgent(deps, "t1", NOW);
    expect(asked).toEqual([expect.any(Number), ["t1"]]);
  });

  it("shows no reading when it is of an earlier message, or there is none", async () => {
    expect((await read({ analysis: analysis({ lastMessageKey: KEY - 1 }) })).view).toMatchObject({
      available: true,
      reading: null,
      prepared: draft,
    });
    expect((await read({ analysis: null })).view.reading).toBeNull();
  });

  it("shows no reading when it is not on the person or waiting, or not sure enough", async () => {
    expect((await read({ analysis: analysis({ state: "fyi" }) })).view.reading).toBeNull();
    expect((await read({ analysis: analysis({ confidence: 0.1 }) })).view.reading).toBeNull();
  });

  it("shows no reading when the person hid it, or a rule covers the thread", async () => {
    const closed: ThingFeedback = {
      threadId: "t1",
      lastMessageKey: KEY,
      senderAddress: "anna@northwind.example",
      kind: "notImportant",
      atMs: NOW - 10,
    };
    expect((await read({ feedback: [closed] })).view.reading).toBeNull();
    const rule = { id: 1, scope: "sender", subject: "anna@northwind.example", action: "noReply" };
    const covered = await read({ rules: [rule] });
    expect(covered.view.reading).toBeNull();
    expect(covered.view.available).toBe(true);
  });

  it("keeps prepared work even when there is no reading", async () => {
    const { view } = await read({
      analysis: null,
      prepared: { kind: "needs", missing: "x", directions: [] },
    });
    expect(view.prepared).toMatchObject({ kind: "needs" });
  });

  it("carries the facts with their quote, message and due date (ADR 0075)", async () => {
    const dueMs = Date.UTC(2026, 10, 12);
    const { view } = await read({
      analysis: analysis({
        facts: [
          { kind: "promise", who: "you", dueMs, evidence: { quote: "I will pay", messageKey: 5 } },
          factOf("them"),
        ],
      }),
    });
    expect(view.facts).toEqual([
      { kind: "promise", who: "you", dueMs, quote: "I will pay", messageKey: 5 },
      { kind: "ask", who: "them", quote: "Please send", messageKey: KEY },
    ]);
  });

  it("gives no facts whenever it gives no reading", async () => {
    const none = (o: Setup) => read(o).then((r) => r.view.facts);
    expect(await none({ enabled: false })).toEqual([]);
    expect(await none({ consented: false })).toEqual([]);
    expect(await none({ missing: true })).toEqual([]);
    expect(await none({ analysis: null })).toEqual([]);
    expect(await none({ analysis: analysis({ lastMessageKey: KEY - 1 }) })).toEqual([]);
    expect(await none({ analysis: analysis({ state: "fyi" }) })).toEqual([]);
    expect(await none({ analysis: analysis({ confidence: 0.1 }) })).toEqual([]);
    const rule = { id: 1, scope: "sender", subject: "anna@northwind.example", action: "noReply" };
    expect(await none({ rules: [rule] })).toEqual([]);
    const closed: ThingFeedback = {
      threadId: "t1",
      lastMessageKey: KEY,
      senderAddress: "anna@northwind.example",
      kind: "notImportant",
      atMs: NOW - 10,
    };
    expect(await none({ feedback: [closed] })).toEqual([]);
  });
});
