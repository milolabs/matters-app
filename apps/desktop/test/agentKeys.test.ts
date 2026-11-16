import { visibleText } from "@matters/adapter-mime";
import type {
  AgentKey,
  AgentKeyVaultPort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  StoredAccount,
  TalkSummary,
} from "@matters/core";
import {
  AgentRunError,
  REMEMBER_INSTRUCTIONS,
  runtimeInfo,
  TALK_ALL_INSTRUCTIONS,
  TALK_FOLLOW_INSTRUCTIONS,
  TALK_PLAN_INSTRUCTIONS,
  TALK_TITLE_INSTRUCTIONS,
} from "@matters/core";
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
  /** While set, the next write waits for this, then keeps the key, or fails with `failSet`. */
  setGate: Promise<void> | null = null;
  failSet = false;
  /** A write is waiting at the gate. */
  setting = false;
  async get(runtimeId: string) {
    return this.kept.get(runtimeId) ?? null;
  }
  async set(runtimeId: string, key: AgentKey) {
    const gate = this.setGate;
    this.setGate = null;
    if (gate !== null) {
      this.setting = true;
      await gate;
      this.setting = false;
    }
    if (this.failSet) {
      this.failSet = false;
      throw new Error("The keychain is locked.");
    }
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
  /** The id of the key in the vault as each request was sent. */
  readonly sentOn: (string | undefined)[] = [];
  /** What a turn that is not the test answers; none: an empty object. */
  answer: ((request: AgentRunRequest) => unknown) | null = null;
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
    this.sentOn.push(this.vault.kept.get(this.id)?.id);
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
    if (request.untrusted.includes(TEST_PROMPT_QUOTE)) return { value: verdictOfTest };
    return { value: this.answer?.(request) ?? {} };
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

/** A gate a test opens by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
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
  await storage.index.indexMessages([
    { message: { ...message, key: keys[0] ?? message.key }, bodyText: "Can we meet on Tuesday?" },
  ]);
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
  // Rule 6: the commands of a runtime's key run one at a time. A press of the switch while a key
  // is saved runs once the save has ended: the new key starts off, and the press is for it.
  it("keeps the new key's switch off while the save waits for the turns of the old key, and runs a press after it (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
    await h.service.idle();
    // With reading on, the pass tests the key by itself; its answer does not hear the stop, so
    // the save waits for the pass.
    h.keyed.hold = true;
    h.keyed.deaf = true;
    await h.service.setKeyReading("anthropic-api", true);
    await until(() => h.keyed.release !== null);
    const saving = h.service.saveKey("anthropic-api", `${KEY}-2`);
    await settle();
    const pressing = h.service.setKeyReading("anthropic-api", true);
    for (let i = 0; i < 10; i++) await settle();
    expect((await h.settings.get()).keyReading ?? []).toEqual([]);
    h.keyed.hold = false;
    h.keyed.release?.();
    const saved = await saving;
    expect(saved.settings.keyReading ?? []).toEqual([]);
    expect((await pressing).settings.keyReading).toEqual(["anthropic-api"]);
  });

  it("keeps the new key's switch off while the vault is written, and runs a press after it (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    const vault = gate();
    h.vault.setGate = vault.wait;
    const saving = h.service.saveKey("anthropic-api", `${KEY}-2`);
    await until(() => h.vault.setting);
    const pressing = h.service.setKeyReading("anthropic-api", true);
    for (let i = 0; i < 10; i++) await settle();
    expect((await h.settings.get()).keyReading ?? []).toEqual([]);
    vault.open();
    expect((await saving).settings.keyReading ?? []).toEqual([]);
    expect((await pressing).settings.keyReading).toEqual(["anthropic-api"]);
  });

  it("runs a command of the key that waited behind one that failed (rule 6)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    const vault = gate();
    h.vault.setGate = vault.wait;
    h.vault.failSet = true;
    const saving = h.service.saveKey("anthropic-api", `${KEY}-2`).catch((e: unknown) => e);
    await until(() => h.vault.setting);
    const pressing = h.service.setKeyReading("anthropic-api", true);
    for (let i = 0; i < 10; i++) await settle();
    expect((await h.settings.get()).keyReading ?? []).toEqual([]);
    vault.open();
    expect(await saving).toBeInstanceOf(InvalidAgentSettingError);
    expect((await pressing).settings.keyReading).toEqual(["anthropic-api"]);
    expect(h.vault.kept.get("anthropic-api")?.key).toBe(KEY);
  });

  // Rule 5: a refusal is the key's it ran on. Each path a person asks on takes the ticket of the
  // key when its turn begins.
  const asks = {
    prepare: (h: Awaited<ReturnType<typeof build>>) => h.service.prepare("t1"),
    talk: (h: Awaited<ReturnType<typeof build>>) => h.service.talk("t1", "When?"),
  } as const;
  for (const [path, ask] of Object.entries(asks)) {
    it(`does not take a refusal of the key before as the new key's, on ${path} (rule 5)`, async () => {
      const h = await build();
      await h.service.saveKey("anthropic-api", KEY);
      await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
      await h.service.testRuntime("anthropic-api");
      h.keyed.hold = true;
      h.keyed.deaf = true;
      h.keyed.refuse = true;
      const asking = ask(h).then(
        () => "done",
        (e: Error) => e.message,
      );
      await until(() => h.keyed.release !== null);
      await h.service.saveKey("anthropic-api", `${KEY}-2`);
      h.keyed.release?.();
      await asking;
      expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("found");
    });
  }

  // Rule 5: what was found ready on the key before says nothing of the new one. A turn asked for
  // before the new key is looked at tests that key first, and goes on it only once it passed.
  it("tests a new key before a turn the person asks for on it, though the key before is still shown ready (rule 5)", async () => {
    const h = await build();
    await h.service.saveKey("anthropic-api", KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
    await h.service.testRuntime("anthropic-api");
    // The save's own look of the new key waits; meanwhile the key before is shown ready.
    const look = gate();
    h.keyed.inspectGate = look.wait;
    const saving = h.service.saveKey("anthropic-api", `${KEY}-2`);
    await until(() => h.keyed.inspectGate === null);
    const calls = h.keyed.calls.length;
    const asking = h.service.prepare("t1").catch((e: unknown) => e);
    await until(() => h.keyed.calls.length > calls + 1);
    look.open();
    await saving;
    await asking;
    const newKey = h.vault.kept.get("anthropic-api")?.id;
    const sent = h.keyed.calls.slice(calls).map((r, i) => ({
      test: r.untrusted.includes(TEST_PROMPT_QUOTE),
      on: h.keyed.sentOn[calls + i],
    }));
    expect(sent).toEqual([
      { test: true, on: newKey },
      { test: false, on: newKey },
    ]);
  });

  // Its search turn, and its reading of a few threads matched by the filters alone.
  for (const query of ['prompt:"when do we meet"', 'from:anna prompt:"when do we meet"']) {
    it(`does not take a refusal of the key before as the new key's, on a prompt: ${query} (rule 5)`, async () => {
      const h = await build();
      await h.service.saveKey("anthropic-api", KEY);
      await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
      await h.service.testRuntime("anthropic-api");
      // The turn starts on the key before, and its refusal comes once the new key is kept.
      h.keyed.hold = true;
      h.keyed.deaf = true;
      h.keyed.refuse = true;
      const running = h.service.promptRun(query).catch((e: unknown) => e);
      await until(() => h.keyed.release !== null);
      await h.service.saveKey("anthropic-api", `${KEY}-2`);
      h.keyed.release?.();
      await running;
      expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("found");
    });

    // A prompt asked while the vault is written holds for neither key: its gate passes for no
    // key, so nothing of it goes, on the key before nor on the new one.
    it(`sends nothing of a prompt asked while the vault was written: ${query} (rule 5)`, async () => {
      const h = await build();
      await h.service.saveKey("anthropic-api", KEY);
      await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "anthropic-api" });
      await h.service.testRuntime("anthropic-api");
      const vault = gate();
      h.vault.setGate = vault.wait;
      const saving = h.service.saveKey("anthropic-api", `${KEY}-2`);
      await until(() => h.vault.setting);
      h.keyed.refuse = true;
      const calls = h.keyed.calls.length;
      const running = h.service.promptRun(query).catch((e: unknown) => e);
      for (let i = 0; i < 10; i++) await settle();
      vault.open();
      await saving;
      await running;
      expect(h.keyed.calls.slice(calls)).toEqual([]);
      expect(runtimeInfo(await h.service.status(), "anthropic-api")?.status).toBe("found");
    });
  }
});

// Rule 6: work no press of the person's started takes the ticket of the key before it reads what
// it decides from, and goes only while that key and its switch still allow it; rule 5: what any
// turn found is stored only while its key holds as the write begins. The ledger counts it anyway.
describe("background work on the person's own API key (ADR 0141, rules 5 and 6)", () => {
  const ID = "anthropic-api";
  const WORDS = "Never answer Anna about this";
  type H = Awaited<ReturnType<typeof build>>;

  /** A key kept, agreed to, tested, and reading in the background. */
  async function reading(): Promise<H> {
    const h = await build();
    await h.service.saveKey(ID, KEY);
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: ID });
    await h.service.testRuntime(ID);
    await h.service.setKeyReading(ID, true);
    await h.service.idle();
    await settle();
    return h;
  }

  /** Makes one method wait at a gate the test opens, from its next call on. */
  function held<T extends object, K extends keyof T>(target: T, name: K) {
    const original = target[name] as (...args: unknown[]) => Promise<unknown>;
    const open = gate();
    let waiting = false;
    (target as Record<K, unknown>)[name] = async (...args: unknown[]) => {
      waiting = true;
      await open.wait;
      return original.apply(target, args);
    };
    return {
      waiting: () => waiting,
      /** The method answers at once again, and the call that waits goes on. */
      open: () => {
        (target as Record<K, unknown>)[name] = original;
        open.open();
      },
    };
  }

  const remembers = (r: AgentRunRequest) => r.instructions === REMEMBER_INSTRUCTIONS;
  const names = (r: AgentRunRequest) => r.instructions === TALK_TITLE_INSTRUCTIONS;
  const nameTalkSoon = (h: H, talk: TalkSummary) =>
    (h.service as unknown as { nameTalkSoon(t: TalkSummary): Promise<void> }).nameTalkSoon(talk);

  async function aTalk(h: H): Promise<TalkSummary> {
    const talk = await h.insights.createTalk(NOW);
    await h.insights.appendTalk([
      { threadId: null, talkId: talk.id, atMs: NOW, role: "you", text: "When do we meet Anna?" },
    ]);
    return (await h.insights.getTalk(talk.id)) ?? talk;
  }

  it("remembers with the key reading in the background, and names a talk", async () => {
    const h = await reading();
    h.keyed.answer = (r) =>
      remembers(r) ? { items: [{ scope: "sender" }] } : names(r) ? { title: "Meeting Anna" } : {};
    const remembered = await h.service.remember("t1", WORDS);
    expect(remembered.items.map((i) => i.kind)).toEqual(["rule"]);
    const talk = await aTalk(h);
    await nameTalkSoon(h, talk);
    expect(await h.insights.getTalk(talk.id)).toMatchObject({ title: "Meeting Anna" });
  });

  for (const change of ["replaced", "switched off"] as const) {
    it(`sends no remembering turn when the key is ${change} while it reads the thread`, async () => {
      const h = await reading();
      h.keyed.answer = (r) => (remembers(r) ? { items: [{ scope: "sender" }] } : {});
      const calls = h.keyed.calls.length;
      const thread = held(h.deps.store, "getThread");
      const remembering = h.service.remember("t1", WORDS);
      await until(thread.waiting);
      if (change === "replaced") await h.service.saveKey(ID, `${KEY}-2`);
      else await h.service.setKeyReading(ID, false);
      thread.open();
      expect(await remembering).toEqual({ items: [] });
      // Nothing went, on the new key whose switch is off nor on any other; nothing was counted.
      expect(h.keyed.calls.slice(calls).filter(remembers)).toEqual([]);
      expect((await h.insights.listLedger(20)).some((e) => e.purpose === "remember")).toBe(false);
      expect(await h.insights.listRules()).toEqual([]);
    });

    it(`sends no turn to name a talk when the key is ${change} while it reads the talk`, async () => {
      const h = await reading();
      h.keyed.answer = (r) => (names(r) ? { title: "Meeting Anna" } : {});
      const talk = await aTalk(h);
      const calls = h.keyed.calls.length;
      const listed = held(h.insights, "listTalk");
      const naming = nameTalkSoon(h, talk);
      await until(listed.waiting);
      if (change === "replaced") await h.service.saveKey(ID, `${KEY}-2`);
      else await h.service.setKeyReading(ID, false);
      listed.open();
      await naming;
      expect(h.keyed.calls.slice(calls).filter(names)).toEqual([]);
      expect((await h.insights.getTalk(talk.id))?.titleBy).toBeUndefined();
    });
  }

  // Rule 5: the turn the person asked for is taken at its gate and handed down, so a key saved
  // while what goes with it is read stops it: nothing goes on the new key, for which no gate ran.
  const helpers = {
    rewriteDraft: (h: H) =>
      h.service.rewriteDraft({ threadId: "t1" }, "Tuesday is fine for me, Anna.", "shorter"),
    answerQuestions: (h: H) => h.service.answerQuestions("t1", "Tuesday is fine."),
  } as const;
  for (const [path, ask] of Object.entries(helpers)) {
    it(`sends no ${path} turn on a key saved after its gate, and says it stopped`, async () => {
      const h = await build();
      await h.service.saveKey(ID, KEY);
      await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: ID });
      await h.service.testRuntime(ID);
      const calls = h.keyed.calls.length;
      const listed = held(h.insights, "listInstructions");
      const asking = ask(h).then(
        () => "done",
        (e: Error) => e.message,
      );
      // The gates passed for the key before; the standing instructions are read.
      await until(listed.waiting);
      await h.service.saveKey(ID, `${KEY}-2`);
      listed.open();
      expect(await asking).toBe("Stopped.");
      expect(h.keyed.calls.slice(calls)).toEqual([]);
      // Nothing went, so nothing was counted.
      expect((await h.insights.listLedger(20)).some((e) => e.purpose === "prepare")).toBe(false);
    });
  }

  it("stores no rule of a turn whose key is replaced before it is written, and counts the turn", async () => {
    const h = await reading();
    h.keyed.answer = (r) => (remembers(r) ? { items: [{ scope: "sender" }] } : {});
    const rules = held(h.insights, "listRules");
    const remembering = h.service.remember("t1", WORDS);
    await until(rules.waiting);
    // The turn answered on the key before; the rule is not yet written.
    const sent = h.keyed.calls.filter(remembers);
    expect(sent).toHaveLength(1);
    await h.service.saveKey(ID, `${KEY}-2`);
    rules.open();
    expect(await remembering).toEqual({ items: [] });
    expect(await h.insights.listRules()).toEqual([]);
    const ledger = await h.insights.listLedger(20);
    expect(ledger.filter((e) => e.purpose === "remember")).toHaveLength(1);
  });

  it("stores no answer across all mail whose key is replaced before it is written, and counts the turns", async () => {
    const h = await reading();
    const isAnswer = (r: AgentRunRequest) => r.instructions.startsWith(TALK_ALL_INSTRUCTIONS);
    h.keyed.answer = (r) => {
      if (r.instructions === TALK_PLAN_INSTRUCTIONS) {
        return {
          goal: "Find the meeting",
          assumptions: [],
          trails: [{ name: "Main", why: "It is likely", priority: 5, queries: ["Tuesday"] }],
          traps: [],
        };
      }
      if (r.instructions === TALK_FOLLOW_INSTRUCTIONS) {
        return { decision: "answer", keep: [], hypothesis: "The Tuesday thread" };
      }
      if (isAnswer(r)) {
        return {
          text: "Anna asks to meet on Tuesday.",
          threads: [
            {
              thread: 1,
              note: "asks about Tuesday",
              quotes: [{ message: 1, quote: "Can we meet on Tuesday?" }],
            },
          ],
        };
      }
      return {};
    };
    // Without a new key, the answer is kept.
    const asked = await h.service.talkAll("When do we meet?");
    expect(asked.entries.map((e) => e.role)).toEqual(["you", "agent"]);
    const ledger = (await h.insights.listLedger(50)).filter((e) => e.purpose === "talk").length;
    // The answer turn goes; the thread it names is read again before the answer is written.
    let thread: ReturnType<typeof held> | null = null;
    const answers = h.keyed.answer;
    h.keyed.answer = (r) => {
      if (isAnswer(r)) thread = held(h.deps.store, "getThread");
      return answers(r);
    };
    const asking = h.service.talkAll("And where?").then(
      () => "kept",
      (e: Error) => e.message,
    );
    await until(() => thread?.waiting() === true);
    await h.service.saveKey(ID, `${KEY}-2`);
    (thread as unknown as ReturnType<typeof held>).open();
    expect(await asking).toBe("Stopped.");
    // Nothing of the second question is stored; what it sent is counted.
    const talks = await h.service.talks();
    expect(talks.map((t) => [t.id, t.entries])).toEqual([[asked.talkId, 2]]);
    // As many lines as the first question's, which went the same way.
    expect((await h.insights.listLedger(50)).filter((e) => e.purpose === "talk").length).toBe(
      ledger * 2,
    );
  });
});
