import { visibleText } from "@matters/adapter-mime";
import type {
  AgentKey,
  AgentKeyVaultPort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  StoredAccount,
} from "@matters/core";
import { AgentRunError, runtimeInfo } from "@matters/core";
import {
  createInMemoryStorage,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
  settle,
} from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { InvalidAgentSettingError } from "../src/backend/agentApi.ts";
import { AgentService, KICK_DEBOUNCE_MS, TEST_PROMPT_QUOTE } from "../src/backend/agentService.ts";

// ADR 0141: a runtime on the person's own API key. The key is kept in the vault and never in what
// a window is told; a new key is tested again; removing it takes the consent back; and nothing
// runs on it in the background until the person turns that on.

const NOW = Date.UTC(2026, 10, 16, 12);
const KEY = "sk-ant-test-1111111111111111111111111111-made-up";

const account = (id: string): StoredAccount => ({
  id,
  address: `${id}@example.com`,
  displayName: id,
  imap: { host: "imap.example.com", port: 993, security: "tls", username: id },
  createdAtMs: 1,
});

const verdictOfTest = {
  verdicts: [{ thread: 1, fit: 3, why: "It promises it.", message: 1, quote: TEST_PROMPT_QUOTE }],
};

/** The vault, in memory: what main keeps, by runtime. */
class Vault implements AgentKeyVaultPort {
  readonly kept = new Map<string, AgentKey>();
  async get(runtimeId: string) {
    return this.kept.get(runtimeId) ?? null;
  }
  async set(runtimeId: string, key: AgentKey) {
    this.kept.set(runtimeId, key);
  }
  async delete(runtimeId: string) {
    this.kept.delete(runtimeId);
  }
}

/** A runtime billed to a key, which reads the vault as the real adapter does. */
class Keyed {
  readonly id = "anthropic-api";
  readonly name = "Anthropic API";
  readonly calls: AgentRunRequest[] = [];
  refuse = false;
  /** While set, a turn waits until `release` or its signal ends it. */
  hold = false;
  release: (() => void) | null = null;
  /** Turns that were stopped by their signal. */
  stopped = 0;
  /** While set, a held turn does not hear its signal: its answer was already on the way. */
  deaf = false;
  /** While set, the next look reads the vault and then waits for this before it answers. */
  inspectGate: Promise<void> | null = null;
  private readonly vault: Vault;
  constructor(vault: Vault) {
    this.vault = vault;
  }
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = { id: this.id, name: this.name, noPlan: true, billed: true } as const;
    const key = await this.vault.get(this.id);
    const gate = this.inspectGate;
    this.inspectGate = null;
    if (gate !== null) await gate;
    if (key === null) return { ...base, status: "noKey", models: [], problem: "Paste a key." };
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
  async run(
    request: AgentRunRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentRunResult> {
    this.calls.push(request);
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        if (this.deaf) return;
        options?.signal?.addEventListener("abort", () => {
          this.stopped++;
          reject(new AgentRunError("failed", "Cancelled."));
        });
      });
    }
    if (this.refuse) throw new AgentRunError("refused", "Anthropic refused the key.");
    return { value: request.untrusted.includes(TEST_PROMPT_QUOTE) ? verdictOfTest : {} };
  }
}

/** A runtime on a plan, which the kinds of work can be on while a talk chooses the key's. */
class Plain {
  readonly id = "plan";
  readonly name = "Plan runtime";
  async inspect(): Promise<AgentRuntimeInfo> {
    return { id: this.id, name: this.name, status: "found", plan: "pro", models: ["small"] };
  }
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return { value: request.untrusted.includes(TEST_PROMPT_QUOTE) ? verdictOfTest : {} };
  }
}

/** Lets the turns started so far reach their runtime. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await settle();
  expect(done()).toBe(true);
}

async function build() {
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const insights = new InMemoryAgentInsightStore();
  const settings = new InMemoryAgentSettings();
  await storage.accounts.add(account("acc1"));
  const vault = new Vault();
  const keyed = new Keyed(vault);
  const told: string[] = [];
  const deps: ConstructorParameters<typeof AgentService>[0] = {
    runtimes: [keyed, new Plain()],
    keys: vault,
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    accounts: storage.accounts,
    insights,
    settings,
    drafts: storage.drafts,
    saveDraft: async () => {
      throw new Error("unused");
    },
    clock,
    visibleText,
    onChanged: () => {},
    onError: (message) => told.push(message),
  };
  const service = new AgentService(deps);
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
  const pass = async () => {
    service.kick();
    await clock.advance(KICK_DEBOUNCE_MS + 100);
    await service.idle();
    await settle();
  };
  return { service, deps, vault, keyed, settings, insights, clock, pass, told };
}

describe("the person's own API key (ADR 0141)", () => {
  it("takes a key only for a runtime billed to one, looked at or not", async () => {
    const h = await build();
    await expect(h.service.saveKey("anthropic-api", KEY)).resolves.toBeDefined();
    await expect(h.service.saveKey("elsewhere", KEY)).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
  });

  it("keeps the key in the vault and tells the window only that one is kept (rule 4)", async () => {
    const h = await build();
    const before = await h.service.inspect();
    expect(runtimeInfo(before, "anthropic-api")?.status).toBe("noKey");
    const after = await h.service.saveKey("anthropic-api", `  ${KEY}\n`);
    expect(h.vault.kept.get("anthropic-api")).toEqual({
      key: KEY,
      savedAtMs: NOW,
      id: expect.any(String),
    });
    // The id the key is kept with is random: nothing of the key's text is in it.
    const id = h.vault.kept.get("anthropic-api")?.id ?? "";
    expect(id).not.toContain(KEY.slice(-8));
    expect(runtimeInfo(after, "anthropic-api")?.status).toBe("found");
    // Nothing a window is told holds the key, nor a part of it, nor the id it is kept with.
    const told = JSON.stringify([after, await h.service.status(), h.told]);
    expect(told).not.toContain(KEY);
    expect(told).not.toContain(KEY.slice(-8));
    expect(told).not.toContain(id);
    // A key of a shape no provider gives is not kept, and the sentence does not repeat it.
    const error = await h.service.saveKey("anthropic-api", "not a key!").catch((e) => e);
    expect(error).toBeInstanceOf(InvalidAgentSettingError);
    expect(String(error.message)).not.toContain("not a key!");
    await expect(h.service.saveKey("claude-code", KEY)).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
  });

  it("is ready only after the test, and a new key is tested again (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    const tested = await h.service.testRuntime("anthropic-api");
    expect(runtimeInfo(tested, "anthropic-api")?.status).toBe("ready");
    // The same key looked at again stays ready, with no turn.
    const calls = h.keyed.calls.length;
    expect(runtimeInfo(await h.service.inspect(), "anthropic-api")?.status).toBe("ready");
    expect(h.keyed.calls).toHaveLength(calls);
    // A replaced key is not ready until it passed the test itself.
    await h.clock.advance(1000);
    const replaced = await h.service.saveKey("anthropic-api", `${KEY}-2`);
    expect(runtimeInfo(replaced, "anthropic-api")?.status).toBe("found");
  });

  it("does not take the test of the key before for one saved in the same millisecond (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    expect(runtimeInfo(await h.service.testRuntime("anthropic-api"), "anthropic-api")?.status).toBe(
      "ready",
    );
    // The clock does not move: the new key is saved at the time the old one was tested.
    const replaced = await h.service.saveKey("anthropic-api", `${KEY}-2`);
    expect(runtimeInfo(replaced, "anthropic-api")?.status).toBe("found");
    expect(runtimeInfo(await h.service.inspect(), "anthropic-api")?.status).toBe("found");
    // Nor for the same text saved again: a saved key is a new key, tested again.
    await h.service.testRuntime("anthropic-api");
    const again = await h.service.saveKey("anthropic-api", `${KEY}-2`);
    expect(runtimeInfo(again, "anthropic-api")?.status).toBe("found");
  });

  it("holds no stored test for a key kept before keys had an id (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.testRuntime("anthropic-api");
    // What an older build kept: the key without an id, and a record that names none.
    h.vault.kept.set("anthropic-api", { key: KEY, savedAtMs: NOW - 1 });
    await h.settings.putRuntimeRecord({
      runtimeId: "anthropic-api",
      status: "ready",
      model: "claude-haiku-5-5",
      testedAtMs: NOW,
    });
    const fresh = new AgentService(h.deps);
    expect(runtimeInfo(await fresh.inspect(), "anthropic-api")?.status).toBe("found");
  });

  it("turns reading in the background off when a key is saved, the same key again too (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setKeyReading("anthropic-api", true);
    await h.settings.update({ keyReading: ["anthropic-api", "other"] });
    const replaced = await h.service.saveKey("anthropic-api", `${KEY}-2`);
    expect(replaced.settings.keyReading).toEqual(["other"]);
    await h.service.setKeyReading("anthropic-api", true);
    const again = await h.service.saveKey("anthropic-api", `${KEY}-2`);
    expect(again.settings.keyReading).toEqual(["other"]);
  });

  it("does not keep a test that ran on the key before the one saved while it ran (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    h.keyed.hold = true;
    const testing = h.service.testRuntime("anthropic-api");
    await until(() => h.keyed.release !== null);
    // A new key is saved while the test of the old one waits for its answer, which then passes.
    await h.clock.advance(1000);
    await h.service.saveKey("anthropic-api", `${KEY}-2`);
    h.keyed.release?.();
    const s = await testing;
    expect(runtimeInfo(s, "anthropic-api")?.status).toBe("found");
    expect(await h.settings.getRuntimeRecord("anthropic-api")).toBeNull();
    // Nor does a look later take it for the new key.
    expect(runtimeInfo(await h.service.inspect(), "anthropic-api")?.status).toBe("found");
  });

  for (const change of ["removed", "replaced"] as const) {
    it(`stops a talk that chose the runtime when its key is ${change}, though no kind is on it (rule 4)`, async () => {
      const h = await build();
      await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
      await h.service.saveKey("anthropic-api", KEY);
      await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
      await h.service.testRuntime("anthropic-api");
      expect((await h.settings.get()).kindRuntime.write).toBe("plan");
      h.keyed.hold = true;
      const talking = h.service
        .talk("t1", "When?", { runtimeId: "anthropic-api", model: "claude-opus-5-5" })
        .then(
          () => "answered",
          (e: Error) => e.message,
        );
      await until(() => h.keyed.release !== null);
      if (change === "removed") await h.service.removeKey("anthropic-api");
      else await h.service.saveKey("anthropic-api", `${KEY}-2`);
      await until(() => h.keyed.stopped === 1);
      expect(await talking).not.toBe("answered");
      expect(await h.insights.listTalk("t1", 10)).toEqual([]);
    });
  }

  it("says the provider's refusal of the key in its class, and does not keep it as a test (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    h.keyed.refuse = true;
    const s = await h.service.testRuntime("anthropic-api");
    expect(runtimeInfo(s, "anthropic-api")).toMatchObject({
      status: "keyRefused",
      problem: "Anthropic refused the key.",
    });
    expect(await h.settings.getRuntimeRecord("anthropic-api")).toBeNull();
  });

  it("removing the key takes every account's consent back, and the kinds wait on it (rule 4)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
    await h.service.setKeyReading("anthropic-api", true);
    const s = await h.service.removeKey("anthropic-api");
    expect(h.vault.kept.size).toBe(0);
    expect(s.consents).toEqual([]);
    expect(s.settings.keyReading).toEqual([]);
    expect(s.settings.kindRuntime.understand).toBe("anthropic-api");
    expect(runtimeInfo(s, "anthropic-api")?.status).toBe("noKey");
    const ledger = await h.insights.listLedger(10);
    expect(ledger[0]).toMatchObject({ purpose: "revoke", runtimeId: "anthropic-api" });
  });

  it("tests no key in the background while its reading there is off, and tests it with the first ask (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
    await h.pass();
    // The test is a billed turn: with the switch off none goes by itself.
    expect(h.keyed.calls).toHaveLength(0);
    const s = await h.service.status();
    expect(runtimeInfo(s, "anthropic-api")?.status).toBe("found");
    expect(s.progress).toEqual({ state: "off", reason: "keyOff" });
    // Nor when the model it is tested on changes.
    await h.service.setModels({ understand: "claude-opus-5-5" });
    await settle();
    await h.service.idle();
    expect(h.keyed.calls).toHaveLength(0);
    // The first thing the person asks for on it tests it first, then runs.
    await h.service.rewriteDraft({ threadId: "t1" }, "Hi there", "formal").catch(() => {});
    expect(h.keyed.calls.map((c) => c.untrusted.includes(TEST_PROMPT_QUOTE))).toEqual([
      true,
      false,
    ]);
    expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("ready");
  });

  it("keeps nothing new when the switch of the key before cannot be turned off (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setKeyReading("anthropic-api", true);
    const before = h.vault.kept.get("anthropic-api");
    const update = h.settings.update.bind(h.settings);
    h.settings.update = async (patch) => {
      if ("keyReading" in patch) throw new Error("disk full");
      return update(patch);
    };
    const error = await h.service.saveKey("anthropic-api", `${KEY}-2`).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidAgentSettingError);
    expect(h.vault.kept.get("anthropic-api")).toEqual(before);
    expect((await h.settings.get()).keyReading).toEqual(["anthropic-api"]);
  });

  it("does not show a test as the new key's when the key is replaced while its record is written (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    const put = h.settings.putRuntimeRecord.bind(h.settings);
    let write: (() => void) | null = null;
    h.settings.putRuntimeRecord = async (record) => {
      await new Promise<void>((resolve) => {
        write = resolve;
      });
      return put(record);
    };
    const testing = h.service.testRuntime("anthropic-api");
    await until(() => write !== null);
    h.settings.putRuntimeRecord = put;
    await h.clock.advance(1000);
    await h.service.saveKey("anthropic-api", `${KEY}-2`);
    (write as unknown as () => void)();
    expect(runtimeInfo(await testing, "anthropic-api")?.status).toBe("found");
    expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("found");
    expect(runtimeInfo(await h.service.inspect(), "anthropic-api")?.status).toBe("found");
  });

  it("does not show a look at the key before once a new key is saved during it (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.testRuntime("anthropic-api");
    let open: () => void = () => {};
    h.keyed.inspectGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The look reads the old key, whose test passed, and waits; the new key is saved and looked at.
    const looking = h.service.inspect();
    await settle();
    await h.clock.advance(1000);
    await h.service.saveKey("anthropic-api", `${KEY}-2`);
    open();
    expect(runtimeInfo(await looking, "anthropic-api")?.status).toBe("found");
    expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("found");
  });

  it("does not take a refusal of a turn stopped by a new key as the new key's (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
    await h.service.testRuntime("anthropic-api");
    h.keyed.hold = true;
    h.keyed.deaf = true;
    h.keyed.refuse = true;
    const rewriting = h.service.rewriteDraft({ threadId: "t1" }, "Hi there", "formal").then(
      () => "done",
      (e: Error) => e.message,
    );
    await until(() => h.keyed.release !== null);
    await h.service.saveKey("anthropic-api", `${KEY}-2`);
    h.keyed.release?.();
    await rewriting;
    expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("found");
  });

  it("reads nothing in the background until the person turns it on (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
    await h.pass();
    const off = await h.service.status();
    expect(off.progress).toEqual({ state: "off", reason: "keyOff" });
    const on = await h.service.setKeyReading("anthropic-api", true);
    expect(on.settings.keyReading).toEqual(["anthropic-api"]);
    await h.pass();
    expect((await h.service.status()).progress.reason).not.toBe("keyOff");
    const again = await h.service.setKeyReading("anthropic-api", false);
    expect(again.settings.keyReading).toEqual([]);
  });
});
