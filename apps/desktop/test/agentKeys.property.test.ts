// Property tests (ADR 0125) of the person's own API key (ADR 0141, rules 5 and 6): saves, removals,
// presses of the reading switch, tests and turns are asked for in any order, and every wait of the
// vault, a look and a turn ends in any order. Once all has ended, two things must hold:
//
// 1. The reading switch is what the commands of the key, run one at a time in the order they were
//    asked for, leave it at: a save or a removal turns it off, a press sets it. Each save and
//    removal answers with it off.
// 2. What is shown of the runtime, its stored test and a refusal are the key's now in the vault:
//    a refusal shown is one of a turn on that key, ready is its own test's.
import { visibleText } from "@matters/adapter-mime";
import type {
  AgentKey,
  AgentKeyVaultPort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentStatus,
  StoredAccount,
} from "@matters/core";
import { AgentRunError, keyReadingOn, runtimeInfo } from "@matters/core";
import {
  createInMemoryStorage,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
  settle,
} from "@matters/testkit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AgentService, TEST_PROMPT_QUOTE } from "../src/backend/agentService.ts";

const NOW = Date.UTC(2026, 10, 16, 12);
const ID = "anthropic-api";
/** A made-up key; one that ends in `-bad` is refused by the stand-in provider. */
const keyText = (n: number, bad: boolean) =>
  `sk-ant-test-${String(n).padStart(4, "0")}11111111111111111111111111-made-up${bad ? "-bad" : ""}`;

const account: StoredAccount = {
  id: "acc1",
  address: "acc1@example.com",
  displayName: "acc1",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "acc1" },
  createdAtMs: 1,
};

/** Every wait of the stand-ins goes through the scheduler once the setup is done. */
class Waits {
  live = false;
  private readonly s: fc.Scheduler;
  constructor(s: fc.Scheduler) {
    this.s = s;
  }
  async wait(label: string): Promise<void> {
    if (this.live) await this.s.schedule(Promise.resolve(), label);
  }
}

class Vault implements AgentKeyVaultPort {
  readonly kept = new Map<string, AgentKey>();
  private readonly waits: Waits;
  constructor(waits: Waits) {
    this.waits = waits;
  }
  async get(runtimeId: string) {
    return this.kept.get(runtimeId) ?? null;
  }
  async set(runtimeId: string, key: AgentKey) {
    await this.waits.wait("vault set");
    this.kept.set(runtimeId, key);
  }
  async delete(runtimeId: string) {
    await this.waits.wait("vault delete");
    this.kept.delete(runtimeId);
  }
}

/**
 * A runtime billed to a key. It reads the vault when a look begins and when a turn's request is
 * sent, as the adapter does, and answers for that key whenever the scheduler lets it. Every other
 * turn that was stopped while it waited still answers: its answer was already on the way.
 */
class Keyed {
  readonly id = ID;
  readonly name = "Anthropic API";
  private readonly vault: Vault;
  private readonly waits: Waits;
  constructor(vault: Vault, waits: Waits) {
    this.vault = vault;
    this.waits = waits;
  }
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = { id: this.id, name: this.name, noPlan: true, billed: true } as const;
    const key = this.vault.kept.get(this.id);
    await this.waits.wait("look");
    if (key === undefined) return { ...base, status: "noKey", models: [], problem: "Paste a key." };
    return {
      ...base,
      status: "found",
      models: ["claude-haiku-5-5", "claude-opus-5-5"],
      defaultModel: "claude-opus-5-5",
      defaultModels: { understand: "claude-haiku-5-5", titles: "claude-haiku-5-5" },
      keySavedAtMs: key.savedAtMs,
      ...(key.id === undefined ? {} : { keyId: key.id }),
    };
  }
  private turns = 0;
  /** The next turn is refused whatever its key, as a rate limit for now is. */
  limitNext = false;
  /** The ids of the keys the provider refused a turn of. */
  readonly refused = new Set<string>();
  async run(
    request: AgentRunRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentRunResult> {
    const deaf = this.turns++ % 2 === 1;
    // The key is read as the request is sent.
    await this.waits.wait("send");
    const key = this.vault.kept.get(this.id);
    const limited = this.limitNext;
    this.limitNext = false;
    await this.waits.wait("turn");
    if (options?.signal?.aborted === true && !deaf) throw new AgentRunError("failed", "Cancelled.");
    if (key === undefined || key.key.endsWith("-bad") || limited) {
      if (key?.id !== undefined) this.refused.add(key.id);
      throw new AgentRunError("refused", "Anthropic refused the key.");
    }
    if (request.untrusted.includes(TEST_PROMPT_QUOTE)) {
      return {
        value: {
          verdicts: [
            { thread: 1, fit: 3, why: "It promises it.", message: 1, quote: TEST_PROMPT_QUOTE },
          ],
        },
      };
    }
    return { value: {} };
  }
}

type Command =
  | { readonly kind: "save"; readonly bad: boolean }
  | { readonly kind: "remove" }
  | { readonly kind: "reading"; readonly on: boolean }
  | { readonly kind: "test" }
  | { readonly kind: "prepare" }
  | { readonly kind: "talk" }
  | { readonly kind: "prompt" }
  | { readonly kind: "limit" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("save" as const), bad: fc.boolean() }),
  fc.constant({ kind: "remove" as const }),
  fc.record({ kind: fc.constant("reading" as const), on: fc.boolean() }),
  fc.constant({ kind: "test" as const }),
  fc.constant({ kind: "prepare" as const }),
  fc.constant({ kind: "talk" as const }),
  fc.constant({ kind: "prompt" as const }),
  fc.constant({ kind: "limit" as const }),
);

async function build(s: fc.Scheduler) {
  const waits = new Waits(s);
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const settings = new InMemoryAgentSettings();
  await storage.accounts.add(account);
  const vault = new Vault(waits);
  const keyed = new Keyed(vault, waits);
  const service = new AgentService({
    runtimes: [keyed],
    keys: vault,
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    accounts: storage.accounts,
    insights: new InMemoryAgentInsightStore(),
    settings,
    drafts: storage.drafts,
    saveDraft: async () => {
      throw new Error("unused");
    },
    clock,
    visibleText,
    onChanged: () => {},
  });
  const message = makeMessage({
    seq: 1,
    accountId: "acc1",
    threadId: "t1",
    providerId: "t1-1",
    dateMs: NOW - 86_400_000,
    from: { name: "Anna", address: "anna@example.org" },
    to: [{ address: "acc1@example.com" }],
    subject: "Tuesday",
    labelIds: ["inbox"],
  });
  const { keys } = await storage.store.upsertMessages([message]);
  await storage.bodies.putBodies(
    keys.map((key) => ({ key, threadId: "t1", text: "Can we meet on Tuesday?" })),
  );
  // A key kept, agreed to and tested, before anything is asked for in any order.
  await service.saveKey(ID, keyText(0, false));
  await service.setEnabled({ accountIds: ["acc1"], runtimeId: ID });
  await service.testRuntime(ID);
  await service.idle();
  waits.live = true;
  return { service, vault, settings, keyed };
}

describe("the person's own API key, in any order (ADR 0141)", () => {
  it("keeps the switch and the state of the runtime the key's now in the vault, whatever ends first", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(command, { minLength: 1, maxLength: 8 }),
        async (s, commands) => {
          const h = await build(s);
          /** The commands of the key, in the order they were asked for. */
          const keyOrder: Command[] = [];
          const answers: Promise<AgentStatus | null>[] = [];
          let saved = 0;
          const ask = (c: Command): Promise<AgentStatus | null> => {
            switch (c.kind) {
              case "save":
                keyOrder.push(c);
                return h.service.saveKey(ID, keyText(++saved, c.bad));
              case "remove":
                keyOrder.push(c);
                return h.service.removeKey(ID);
              case "reading":
                keyOrder.push(c);
                return h.service.setKeyReading(ID, c.on).then(() => null);
              case "test":
                return h.service.testRuntime(ID).then(() => null);
              case "prepare":
                return h.service.prepare("t1").then(() => null);
              case "talk":
                return h.service.talk("t1", "When?").then(() => null);
              case "prompt":
                return h.service.promptRun('prompt:"when do we meet"').then(() => null);
              case "limit":
                h.keyed.limitNext = true;
                return Promise.resolve(null);
            }
          };
          const asked = commands.map((c) =>
            s
              .schedule(Promise.resolve(), `ask ${c.kind}`)
              .then(() => {
                const answer = ask(c);
                if (c.kind === "save" || c.kind === "remove") answers.push(answer);
                return answer;
              })
              .catch(() => null),
          );
          await s.waitFor(Promise.all(asked));
          // What the commands started (the pass, its test) ends too.
          for (let i = 0; i < 5; i++) {
            await s.waitIdle();
            await h.service.idle();
            await settle();
          }
          await s.waitIdle();

          // 1. The switch.
          let reading = false;
          for (const c of keyOrder) {
            if (c.kind === "reading") reading = c.on;
            else reading = false;
          }
          const now = await h.settings.get();
          expect(keyReadingOn(now, ID)).toBe(reading);
          for (const answer of answers) {
            const status = await answer.catch(() => null);
            if (status !== null) expect(keyReadingOn(status.settings, ID)).toBe(false);
          }

          // 2. The state shown, the stored test and a refusal.
          const kept = h.vault.kept.get(ID);
          const shown = runtimeInfo(await h.service.status(), ID);
          const record = await h.settings.getRuntimeRecord(ID);
          if (kept === undefined) {
            expect(shown?.status).toBe("noKey");
          } else {
            const bad = kept.key.endsWith("-bad");
            expect(shown?.status).not.toBe("noKey");
            // A refusal shown is one of a turn on this key.
            if (shown?.status === "keyRefused")
              expect(h.keyed.refused.has(kept.id ?? "")).toBe(true);
            if (shown?.status === "ready") {
              expect(bad).toBe(false);
              expect(record).toMatchObject({ status: "ready", keyId: kept.id });
            }
            if (record !== null && record.keyId === kept.id) {
              expect(record.status).toBe(bad ? "failed" : "ready");
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
