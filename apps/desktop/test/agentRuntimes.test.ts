import { visibleText } from "@matters/adapter-mime";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  StoredAccount,
} from "@matters/core";
import { AgentRunError, PREPARED_INSTRUCTIONS } from "@matters/core";
import {
  createInMemoryStorage,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
  settle,
} from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError, InvalidAgentSettingError } from "../src/backend/agentApi.ts";
import { AgentService, KICK_DEBOUNCE_MS, TEST_PROMPT_QUOTE } from "../src/backend/agentService.ts";

// ADR 0119: runtimes are a list and one is chosen; only the chosen one runs, consent is per runtime,
// choices are kept per runtime, a model that is gone is said and not replaced, and a runtime with
// no plan has no plan's gates.

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;

const account = (id: string, address: string): StoredAccount => ({
  id,
  address,
  displayName: id,
  imap: { host: "imap.example.com", port: 993, security: "tls", username: id },
  createdAtMs: 1,
});

const verdictOfTest = {
  verdicts: [{ thread: 1, fit: 3, why: "It promises it.", message: 1, quote: TEST_PROMPT_QUOTE }],
};
const draft = { kind: "draft", body: "Hello Anna,\n\nTuesday works.", nudge: false };

/** A runtime that answers the test and the draft, and can hold a turn until it is stopped. */
class Runtime {
  readonly calls: AgentRunRequest[] = [];
  /** Turns that were stopped by their signal. */
  stopped = 0;
  /** While set, a draft turn waits here until its signal ends it. */
  hold = false;
  /** What a turn says of the plan's windows. */
  limits: AgentRunResult["limits"];
  info: AgentRuntimeInfo;
  readonly id: string;
  readonly name: string;
  constructor(id: string, name: string, info: Partial<AgentRuntimeInfo> = {}) {
    this.id = id;
    this.name = name;
    this.info = { id, name, status: "found", models: ["small", "large"], ...info };
  }

  async inspect(): Promise<AgentRuntimeInfo> {
    return this.info;
  }

  get mail(): AgentRunRequest[] {
    return this.calls.filter((c) => !c.untrusted.includes(TEST_PROMPT_QUOTE));
  }

  async run(
    request: AgentRunRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentRunResult> {
    this.calls.push(request);
    if (request.untrusted.includes(TEST_PROMPT_QUOTE)) return { value: verdictOfTest };
    if (this.hold) {
      await new Promise<void>((_, reject) => {
        options?.signal?.addEventListener("abort", () => {
          this.stopped++;
          reject(new AgentRunError("failed", "Cancelled."));
        });
      });
    }
    return {
      value: request.instructions === PREPARED_INSTRUCTIONS ? draft : {},
      ...(this.limits === undefined ? {} : { limits: this.limits }),
    };
  }
}

async function build() {
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const insights = new InMemoryAgentInsightStore();
  const settings = new InMemoryAgentSettings();
  await storage.accounts.add(account("acc1", "me@example.com"));
  const plan = new Runtime("plan", "Plan runtime", {
    plan: "pro",
    efforts: ["low", "medium", "high"],
    models: ["haiku", "sonnet", "opus"],
  });
  const local = new Runtime("local", "Local", {
    models: ["m-small", "m-large"],
    defaultModel: "m-large",
    noPlan: true,
    onThisMachine: true,
    turnsAtOnce: 1,
    modelEfforts: { "m-small": [], "m-large": ["low", "high"] },
  });
  const codex = new Runtime("codex", "Codex", {
    plan: "ChatGPT",
    models: ["sol", "luna"],
    defaultModel: "sol",
    defaultModels: { understand: "luna", titles: "luna" },
    modelEfforts: { sol: ["low", "high"], luna: ["low"] },
    noWindows: true,
    turnsAtOnce: 1,
  });
  const service = new AgentService({
    runtimes: [plan, local, codex],
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
  });
  const message = makeMessage({
    seq: 1,
    accountId: "acc1",
    threadId: "t1",
    providerId: "t1-1",
    dateMs: NOW - DAY,
    from: { name: "Anna", address: "anna@example.org" },
    to: [{ address: "me@example.com" }],
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
  return { service, settings, insights, plan, local, codex, clock, pass };
}

describe("runtimes are a list, and one is chosen (ADR 0119, rules 2 and 3)", () => {
  it("lists every runtime, chooses none by itself, and runs nothing until one is chosen", async () => {
    const h = await build();
    const first = await h.service.status();
    expect(first.runtime).toBeNull();
    expect(first.runtimes).toEqual([
      { id: "plan", name: "Plan runtime", info: null },
      { id: "local", name: "Local", info: null },
      { id: "codex", name: "Codex", info: null },
    ]);
    const looked = await h.service.inspect();
    expect(looked.runtime).toBeNull();
    expect(looked.runtimes.map((r) => r.info?.status)).toEqual(["found", "found", "found"]);
    expect(looked.settings.runtimeId).toBeUndefined();
    await h.service.testRuntime();
    expect(h.plan.calls).toEqual([]);
    expect(h.local.calls).toEqual([]);
    await expect(h.service.chooseRuntime("elsewhere")).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    await expect(
      h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "elsewhere" }),
    ).rejects.toBeInstanceOf(InvalidAgentSettingError);
  });

  it("runs only the chosen runtime; another needs its own consent", async () => {
    const h = await build();
    await h.service.chooseRuntime("plan");
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.pass();
    expect((await h.service.testRuntime()).runtime?.status).toBe("ready");
    await h.service.prepare("t1");
    expect(h.plan.mail).toHaveLength(1);
    expect(h.local.calls).toEqual([]);

    // Choosing another agrees to nothing: it waits for the consent question, and sends nothing.
    const chosen = await h.service.chooseRuntime("local");
    expect(chosen.settings).toMatchObject({ runtimeId: "local", enabled: true });
    expect(chosen.consents).toEqual([]);
    await h.pass();
    expect((await h.service.status()).progress).toMatchObject({ state: "off", reason: "consent" });
    await expect(h.service.prepare("t1")).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(h.local.mail).toEqual([]);
    expect(h.plan.mail).toHaveLength(1);
    // The consent for the other runtime is kept, as it was given.
    expect((await h.settings.listConsents()).map((c) => c.runtimeId)).toEqual(["plan"]);

    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime();
    await h.service.prepare("t1");
    expect(h.local.mail).toHaveLength(1);
    expect(h.plan.mail).toHaveLength(1);
  });

  it("agreeing for a runtime chooses it, and stops what ran on the other", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.testRuntime();
    h.plan.hold = true;
    const running = h.service.prepare("t1").catch((e: unknown) => e);
    for (let i = 0; i < 50 && h.plan.mail.length === 0; i++) await settle();
    expect(h.plan.mail).toHaveLength(1);
    await h.service.chooseRuntime("local");
    expect(await running).toBeInstanceOf(AgentUnavailableError);
    expect(h.plan.stopped).toBe(1);
    expect(h.local.mail).toEqual([]);
  });
});

describe("models and efforts are kept per runtime (ADR 0119, rule 4)", () => {
  it("starts a runtime on its own models, and changing back loses nothing", async () => {
    const h = await build();
    await h.service.chooseRuntime("plan");
    expect((await h.service.status()).settings.models).toEqual({
      understand: "haiku",
      write: "sonnet",
      answer: "sonnet",
      titles: "haiku",
    });
    await h.service.setModels({ write: "opus" }, { write: "high" });
    const local = await h.service.chooseRuntime("local");
    // No fixed names: every kind starts on the model the runtime names, titles too.
    expect(local.settings.models).toEqual({
      understand: "m-large",
      write: "m-large",
      answer: "m-large",
      titles: "m-large",
    });
    await h.service.setModels({ understand: "m-small" });
    const back = await h.service.chooseRuntime("plan");
    expect(back.settings.models.write).toBe("opus");
    expect(back.settings.efforts.write).toBe("high");
    expect((await h.service.chooseRuntime("local")).settings.models.understand).toBe("m-small");
  });

  it("says a model the runtime no longer lists, and does not run that kind", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime();
    await h.service.setModels({ write: "m-small" });
    h.local.info = { ...h.local.info, models: ["m-large"] };
    const status = await h.service.inspect();
    expect(status.unlisted).toEqual(["write"]);
    const before = h.local.mail.length;
    const error = await h.service.prepare("t1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).message).toBe(
      "m-small is not available on Local now. Choose another model for writing in Settings.",
    );
    expect(h.local.mail).toHaveLength(before);
    // The model for reading gone too: the reading in the background waits, and says why.
    await h.service.setModels({ write: "m-large" });
    await h.settings.update({ models: { ...(await h.settings.get()).models, understand: "x" } });
    await h.pass();
    expect((await h.service.status()).progress).toMatchObject({
      state: "off",
      reason: "runtime",
      problem:
        "x is not available on Local now. Choose another model for understanding mail in Settings.",
    });
  });
});

describe("effort follows the model (ADR 0119, rule 9)", () => {
  it("sends a level only when the model chosen for the work lists it", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime();
    // The test stays at `low` when its model takes it: the starting model does.
    expect(h.local.calls[0]?.effort).toBe("low");
    await h.service.setModels({ write: "m-large" }, { write: "high" });
    await h.service.prepare("t1");
    expect(h.local.mail.at(-1)?.effort).toBe("high");
    await h.service.setModels({ write: "m-small" });
    await h.service.prepare("t1");
    expect(h.local.mail.at(-1)?.effort).toBeUndefined();
  });
});

describe("a runtime with no plan (ADR 0119, rule 7)", () => {
  it("passes the plan's gate, and records no limits", async () => {
    const h = await build();
    // Windows of another runtime's plan, used up: they do not apply to a runtime with no plan.
    await h.settings.update({
      limits: {
        session: { usedPercent: 100, resetsAtMs: NOW + DAY },
        week: { usedPercent: 100, resetsAtMs: NOW + DAY },
        usingOverage: true,
        seenAtMs: NOW,
      },
    });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.testRuntime();
    await expect(h.service.prepare("t1")).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(h.plan.mail).toEqual([]);

    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime();
    const limitsBefore = (await h.settings.get()).limits;
    h.local.limits = { usingOverage: false, seenAtMs: NOW + 1 };
    await h.service.prepare("t1");
    expect(h.local.mail).toHaveLength(1);
    expect((await h.settings.get()).limits).toEqual(limitsBefore);
    expect((await h.service.status()).runtime?.limits).toBeUndefined();
    // The ledger still says what went.
    expect((await h.insights.listLedger(10)).some((l) => l.runtimeId === "local")).toBe(true);
  });
});

describe("the test is for a model (ADR 0119)", () => {
  const tests = (r: Runtime) => r.calls.filter((c) => c.untrusted.includes(TEST_PROMPT_QUOTE));

  it("tests again when the model for understanding mail changes to one never tested", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime();
    expect((await h.settings.getRuntimeRecord("local"))?.model).toBe("m-large");
    expect((await h.service.status()).runtime?.status).toBe("ready");
    await h.service.idle();
    const before = tests(h.local).length;
    expect(tests(h.local).every((c) => c.model === "m-large")).toBe(true);
    await h.service.setModels({ understand: "m-small" });
    for (let i = 0; i < 20 && tests(h.local).length === before; i++) await settle();
    expect(
      tests(h.local)
        .slice(before)
        .map((c) => c.model),
    ).toEqual(["m-small"]);
    expect((await h.settings.getRuntimeRecord("local"))?.model).toBe("m-small");
    expect((await h.service.status()).runtime?.status).toBe("ready");
    // No mail went with either test.
    expect(h.local.mail).toEqual([]);
  });

  it("with AI off, a new model is not checked yet until the person checks it", async () => {
    const h = await build();
    await h.service.chooseRuntime("local");
    await h.service.testRuntime();
    expect((await h.service.status()).runtime?.status).toBe("ready");
    await h.service.setModels({ understand: "m-small" });
    await settle();
    expect((await h.service.status()).runtime?.status).toBe("found");
    expect(tests(h.local)).toHaveLength(1);
    // Back to the model that was tested: the record holds for the last one tested only.
    await h.service.setModels({ understand: "m-large" });
    expect((await h.service.status()).runtime?.status).toBe("ready");
  });

  it("keeps a record from before, with no model, ready for the model chosen now", async () => {
    const h = await build();
    await h.settings.putRuntimeRecord({
      runtimeId: "plan",
      status: "ready",
      plan: "pro",
      testedAtMs: NOW - DAY,
    });
    await h.service.chooseRuntime("plan");
    expect((await h.service.status()).runtime?.status).toBe("ready");
    expect(h.plan.calls).toEqual([]);
  });
});

describe("Codex is a runtime (ADR 0120)", () => {
  it("needs its own consent, and only it runs once chosen", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.testRuntime();
    await h.service.prepare("t1");
    expect(h.plan.mail).toHaveLength(1);

    const chosen = await h.service.chooseRuntime("codex");
    // Agreeing for Claude Code agreed to nothing for Codex.
    expect(chosen.consents).toEqual([]);
    await h.pass();
    expect((await h.service.status()).progress).toMatchObject({ state: "off", reason: "consent" });
    await expect(h.service.prepare("t1")).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(h.codex.calls).toEqual([]);

    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    await h.service.testRuntime();
    await h.service.prepare("t1");
    expect(h.codex.mail).toHaveLength(1);
    expect(h.plan.mail).toHaveLength(1);
    expect(h.local.calls).toEqual([]);
    expect((await h.settings.listConsents()).map((c) => c.runtimeId).sort()).toEqual([
      "codex",
      "plan",
    ]);
  });

  it("starts each kind of work on the model Codex suggests for it", async () => {
    const h = await build();
    const s = await h.service.chooseRuntime("codex");
    expect(s.settings.models).toEqual({
      understand: "luna",
      write: "sol",
      answer: "sol",
      titles: "luna",
    });
  });

  it("is not held back by windows it does not report, and records none (rule 9)", async () => {
    const h = await build();
    await h.settings.update({
      limits: {
        session: { usedPercent: 100, resetsAtMs: NOW + DAY },
        week: { usedPercent: 100, resetsAtMs: NOW + DAY },
        usingOverage: true,
        seenAtMs: NOW,
      },
    });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    await h.service.testRuntime();
    await h.service.prepare("t1");
    expect(h.codex.mail).toHaveLength(1);
  });

  it("says the person's ChatGPT plan when a turn would run off it", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    h.codex.run = async () => {
      throw new AgentRunError("notPlan", "The turn would not run on a ChatGPT plan.");
    };
    const s = await h.service.testRuntime();
    expect(s.runtime?.problem).toBe("The assistant is not using your ChatGPT plan.");
  });
});
