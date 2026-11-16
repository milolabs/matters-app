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
  private readonly vault: Vault;
  constructor(vault: Vault) {
    this.vault = vault;
  }
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = { id: this.id, name: this.name, noPlan: true, billed: true } as const;
    const key = await this.vault.get(this.id);
    if (key === null) return { ...base, status: "noKey", models: [], problem: "Paste a key." };
    return {
      ...base,
      status: "found",
      models: ["claude-haiku-5-5", "claude-opus-5-5"],
      defaultModel: "claude-opus-5-5",
      defaultModels: { understand: "claude-haiku-5-5", titles: "claude-haiku-5-5" },
      keySavedAtMs: key.savedAtMs,
    };
  }
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(request);
    if (this.refuse) throw new AgentRunError("refused", "Anthropic refused the key.");
    return { value: request.untrusted.includes(TEST_PROMPT_QUOTE) ? verdictOfTest : {} };
  }
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
  const service = new AgentService({
    runtimes: [keyed],
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
  });
  const pass = async () => {
    service.kick();
    await clock.advance(KICK_DEBOUNCE_MS + 100);
    await service.idle();
    await settle();
  };
  return { service, vault, keyed, settings, insights, clock, pass, told };
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
    expect(h.vault.kept.get("anthropic-api")).toEqual({ key: KEY, savedAtMs: NOW });
    expect(runtimeInfo(after, "anthropic-api")?.status).toBe("found");
    // Nothing a window is told holds the key, nor a part of it.
    const told = JSON.stringify([after, await h.service.status(), h.told]);
    expect(told).not.toContain(KEY);
    expect(told).not.toContain(KEY.slice(-8));
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
