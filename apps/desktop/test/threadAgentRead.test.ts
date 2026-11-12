import type { PreparedWork } from "@matters/core";
import { describe, expect, it } from "vitest";
import { type AgentReadDeps, readThreadAgent } from "../src/backend/agentReads.ts";

const KEY = 77;

const draft: PreparedWork = { kind: "draft", body: "Hi", nudge: false };

interface Setup {
  readonly enabled?: boolean;
  readonly consented?: boolean;
  readonly prepared?: PreparedWork | null;
  readonly missing?: boolean;
}

function setup(o: Setup = {}) {
  const reads: string[] = [];
  const asked: unknown[][] = [];
  const note =
    <T>(name: string, value: T) =>
    async (..._args: unknown[]) => {
      reads.push(name);
      return value;
    };
  const deps = {
    settings: {
      get: note("settings", {
        enabled: o.enabled ?? true,
        kindRuntime: { understand: "fake", write: "fake", answer: "fake", titles: "fake" },
      }),
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
      getPrepared: async (...args: unknown[]) => {
        reads.push("prepared");
        asked.push(args);
        return o.prepared === null ? null : { work: o.prepared ?? draft };
      },
    },
  } as unknown as AgentReadDeps;
  return { deps, reads, asked };
}

const read = (o?: Setup) => {
  const { deps, reads, asked } = setup(o);
  return readThreadAgent(deps, "t1").then((view) => ({ view, reads, asked }));
};

describe("what the agent already has for one thread (ADR 0063, ADR 0117)", () => {
  it("gives the prepared work, and no stored reading", async () => {
    const { view } = await read();
    expect(view).toEqual({ available: true, prepared: draft });
  });

  it("is unavailable while AI is off, and reads nothing else", async () => {
    const { view, reads } = await read({ enabled: false });
    expect(view).toEqual({ available: false, prepared: null });
    expect(reads).toEqual(["settings"]);
  });

  it("is unavailable for an account without consent, and reads no work", async () => {
    const { view, reads } = await read({ consented: false });
    expect(view).toEqual({ available: false, prepared: null });
    expect(reads).not.toContain("prepared");
  });

  it("is unavailable for a thread that is not there", async () => {
    expect((await read({ missing: true })).view.available).toBe(false);
  });

  it("asks for the work prepared for the thread's current last message", async () => {
    const { asked } = await read();
    expect(asked).toEqual([["t1", KEY]]);
  });

  it("is available with no prepared work when there is none, and keeps any kind of work", async () => {
    expect((await read({ prepared: null })).view).toEqual({ available: true, prepared: null });
    const { view } = await read({ prepared: { kind: "needs", missing: "x", directions: [] } });
    expect(view.prepared).toMatchObject({ kind: "needs" });
  });
});
