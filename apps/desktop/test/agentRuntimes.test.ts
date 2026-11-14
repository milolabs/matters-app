import { visibleText } from "@matters/adapter-mime";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentStatus,
  StoredAccount,
} from "@matters/core";
import {
  AgentRunError,
  everyKindOn,
  kindInfo,
  PREPARED_INSTRUCTIONS,
  planUseOf,
  runtimeInfo,
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
import { AgentUnavailableError, InvalidAgentSettingError } from "../src/backend/agentApi.ts";
import { AgentService, KICK_DEBOUNCE_MS, TEST_PROMPT_QUOTE } from "../src/backend/agentService.ts";

// ADR 0119: runtimes are a list; consent is per runtime, choices are kept per runtime, a model that
// is gone is said and not replaced, and a runtime with no plan has no plan's gates. ADR 0121: each
// kind of work has its own runtime; a turn runs on the runtime of its kind and on no other, with the
// accounts that agreed to it, and each plan keeps its own windows.

/** The runtime for understanding mail as the status shows it. */
const reading = (status: AgentStatus) => kindInfo(status, "understand");

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
    pausesOnLimit: true,
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
  /** A second account with a thread of its own. */
  const addThread = async (accountId: string, threadId: string) => {
    await storage.accounts.add(account(accountId, `${accountId}@example.com`));
    const other = makeMessage({
      seq: 2,
      accountId,
      threadId,
      providerId: `${threadId}-1`,
      dateMs: NOW - DAY,
      from: { name: "Bob", address: "bob@example.org" },
      to: [{ address: `${accountId}@example.com` }],
      subject: "Lunch",
      labelIds: ["inbox"],
    });
    const added = await storage.store.upsertMessages([other]);
    await storage.bodies.putBodies(
      added.keys.map((key) => ({ key, threadId, text: "Lunch on Friday?" })),
    );
  };
  return { service, settings, insights, plan, local, codex, clock, pass, addThread };
}

const ALL = ["understand", "write", "answer", "titles"] as const;

describe("runtimes are a list, and each kind of work has one (ADR 0119, rule 2; ADR 0121, rules 1 to 3)", () => {
  it("lists every runtime, puts no kind on one by itself, and runs nothing until one is", async () => {
    const h = await build();
    const first = await h.service.status();
    expect(first.runtimes).toEqual([
      { id: "plan", name: "Plan runtime", info: null },
      { id: "local", name: "Local", info: null },
      { id: "codex", name: "Codex", info: null },
    ]);
    const looked = await h.service.inspect();
    expect(looked.runtimes.map((r) => r.info?.status)).toEqual(["found", "found", "found"]);
    expect(looked.settings.kindRuntime).toEqual({});
    // No runtime in use: none is tested.
    await h.service.testRuntime();
    expect(h.plan.calls).toEqual([]);
    expect(h.local.calls).toEqual([]);
    await expect(h.service.setKindRuntime(["write"], "elsewhere")).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    await expect(h.service.testRuntime("elsewhere")).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    await expect(
      h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "elsewhere" }),
    ).rejects.toBeInstanceOf(InvalidAgentSettingError);
  });

  it("puts every kind on the first runtime connected; agreeing to another moves none (rule 12)", async () => {
    const h = await build();
    const on = await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    expect(on.settings.kindRuntime).toEqual(everyKindOn("plan"));
    const other = await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    expect(other.settings.kindRuntime).toEqual(everyKindOn("plan"));
    expect(other.consents.map((c) => c.runtimeId).sort()).toEqual(["local", "plan"]);
  });

  it("checks a runtime no kind is on when the person asks, so it can be connected first (rule 2)", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    const s = await h.service.testRuntime("local");
    expect(runtimeInfo(s, "local")?.status).toBe("ready");
    expect(h.local.mail).toEqual([]);
    // Without a runtime named, only the ones in use are tested.
    const tested = h.local.calls.length;
    await h.service.testRuntime();
    expect(h.local.calls).toHaveLength(tested);
  });

  it("runs each kind on its own runtime, side by side, and on no other", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.setKindRuntime(["understand"], "local");
    // The pass tests every runtime in use that an account agreed to (ADR 0121, consequences).
    await h.pass();
    const s = await h.service.status();
    expect(runtimeInfo(s, "plan")?.status).toBe("ready");
    expect(runtimeInfo(s, "local")?.status).toBe("ready");
    await h.service.prepare("t1");
    expect(h.plan.mail).toHaveLength(1);
    expect(h.local.mail).toEqual([]);
    // Checking a reply is help with a reply: writing, so it runs where writing does, on the
    // model that runtime keeps for reading. Its answer here is not one the code accepts.
    await h.service.checkReply("t1", "Tuesday is fine.").catch(() => {});
    expect(h.plan.mail).toHaveLength(2);
    expect(h.plan.mail.at(-1)?.model).toBe("haiku");
    expect(h.local.mail).toEqual([]);
    // The ledger names the runtime of each turn (rule 11).
    const lines = await h.insights.listLedger(10);
    expect(lines.filter((l) => l.purpose === "prepare").every((l) => l.runtimeId === "plan")).toBe(
      true,
    );
  });

  it("a kind whose runtime cannot be used waits and says why; the others go on (rule 3)", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    h.codex.info = { ...h.codex.info, status: "signedOut" };
    await h.service.setKindRuntime(["write"], "codex");
    await h.pass();
    const error = await h.service.prepare("t1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).message).toBe(
      "Codex is not ready. Check it in Settings, then try again.",
    );
    expect(h.codex.calls).toEqual([]);
    // Nothing moved to the other runtime by itself.
    expect(h.plan.mail).toEqual([]);
    // Reading for views goes on, on its own runtime.
    const s = await h.service.status();
    expect(s.progress).toEqual({ state: "idle" });
    expect(runtimeInfo(s, "plan")?.status).toBe("ready");
  });

  it("a moved kind stops what runs for it; another kind's turn goes on", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.testRuntime();
    h.plan.hold = true;
    const running = h.service.prepare("t1").catch((e: unknown) => e);
    for (let i = 0; i < 50 && h.plan.mail.length === 0; i++) await settle();
    expect(h.plan.mail).toHaveLength(1);
    // Understanding mail moves: the draft, which is writing, is not stopped.
    await h.service.setKindRuntime(["understand"], "local");
    await settle();
    expect(h.plan.stopped).toBe(0);
    // Writing moves: its turn stops, and nothing went to the new runtime.
    await h.service.setKindRuntime(["write"], "local");
    expect(await running).toBeInstanceOf(AgentUnavailableError);
    expect(h.plan.stopped).toBe(1);
    expect(h.local.mail).toEqual([]);
  });
});

describe("consent follows the mail (ADR 0121, rule 4)", () => {
  it("each turn works with the accounts that agreed to the runtime of its kind", async () => {
    const h = await build();
    await h.addThread("acc2", "u1");
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc2"], runtimeId: "local" });
    await h.service.setKindRuntime(["write"], "local");
    await h.service.testRuntime();
    // acc1 agreed to Plan runtime only: its mail never goes to Local.
    const error = await h.service.prepare("t1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).message).toBe(
      "This account has not been agreed to for Local. Choose it in Settings › Agents.",
    );
    expect(h.local.mail).toEqual([]);
    expect(h.plan.mail).toEqual([]);
    // acc2 agreed to Local: its thread goes there.
    await h.service.prepare("u1");
    expect(h.local.mail).toHaveLength(1);
    expect(h.local.mail[0]?.untrusted).toContain("Lunch on Friday?");
  });

  it("takes back the consent for one runtime only", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    const s = await h.service.revokeConsent("acc1", "local");
    expect(s.consents.map((c) => c.runtimeId)).toEqual(["plan"]);
    const ledger = await h.insights.listLedger(10);
    expect(ledger.find((l) => l.purpose === "revoke")?.runtimeId).toBe("local");
  });
});

describe("a talk can change its runtime (ADR 0121, rule 8)", () => {
  it("runs a talk about a thread on the runtime and model chosen in it, for that talk only", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime("local");
    await h.service.testRuntime();
    // Its answer is not one the code accepts; what matters here is where it went.
    await h.service.talk("t1", "When?", { runtimeId: "local", model: "m-small" }).catch(() => {});
    expect(h.local.mail.map((c) => c.model)).toEqual(["m-small"]);
    expect(h.plan.mail).toEqual([]);
    // Nothing of the settings changed.
    expect((await h.settings.get()).kindRuntime).toEqual(everyKindOn("plan"));
    await h.service.talk("t1", "When?").catch(() => {});
    expect(h.plan.mail.map((c) => c.model)).toEqual(["sonnet"]);
  });

  it("refuses a model the runtime does not list, and a runtime the account did not agree to", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.testRuntime("local");
    await expect(
      h.service.talk("t1", "When?", { runtimeId: "local", model: "gone" }),
    ).rejects.toBeInstanceOf(InvalidAgentSettingError);
    await expect(
      h.service.talk("t1", "When?", { runtimeId: "local", model: "m-small" }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(
      h.service.talkAll("Anything from Anna?", null, { runtimeId: "local", model: "m-small" }),
    ).rejects.toMatchObject({
      message: "No account has been agreed to for Local. Choose one in Settings › Agents.",
    });
    expect(h.local.mail).toEqual([]);
  });

  it("runs a question across all mail wholly on the runtime chosen in its talk", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime("local");
    await h.service
      .talkAll("Anything from Anna?", null, { runtimeId: "local", model: "m-small" })
      .catch(() => {});
    // The plan turn ran on Local, on the model Local keeps for reading.
    expect(h.local.mail.length).toBeGreaterThan(0);
    expect(h.local.mail[0]?.model).toBe("m-large");
    expect(h.plan.mail).toEqual([]);
  });
});

describe("models and efforts are kept per runtime (ADR 0119, rule 4; ADR 0121, rule 5)", () => {
  it("starts a runtime on its own models, and moving a kind back loses nothing", async () => {
    const h = await build();
    await h.service.setKindRuntime(ALL, "plan");
    expect((await h.service.status()).settings.models).toEqual({
      understand: "haiku",
      write: "sonnet",
      answer: "sonnet",
      titles: "haiku",
      appearance: "sonnet",
    });
    await h.service.setModels({ write: "opus" }, { write: "high" });
    const local = await h.service.setKindRuntime(["write", "understand"], "local");
    // No fixed names: every kind starts on the model the runtime names; the others stay.
    expect(local.settings.models).toEqual({
      understand: "m-large",
      write: "m-large",
      answer: "sonnet",
      titles: "haiku",
      appearance: "sonnet",
    });
    await h.service.setModels({ understand: "m-small" });
    // A model is checked against the runtime of its kind.
    await expect(h.service.setModels({ write: "opus" })).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    const back = await h.service.setKindRuntime(["write"], "plan");
    expect(back.settings.models.write).toBe("opus");
    expect(back.settings.efforts.write).toBe("high");
    expect(back.settings.models.understand).toBe("m-small");
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
    await h.settings.update({ choices: { local: { models: { understand: "x" } } } });
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

describe("windows, shares and limits are per runtime (ADR 0121, rule 6)", () => {
  const full = {
    session: { usedPercent: 100, resetsAtMs: NOW + DAY },
    week: { usedPercent: 100, resetsAtMs: NOW + DAY },
    usingOverage: true,
    seenAtMs: NOW,
  };

  it("a runtime with no plan passes its gate, and records no limits (ADR 0119, rule 7)", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.settings.update({ plan: { runtimeId: "plan", limits: full } });
    await h.service.testRuntime();
    await expect(h.service.prepare("t1")).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(h.plan.mail).toEqual([]);

    // Writing moves to the runtime with no plan: the used-up windows are another plan's.
    await h.service.setKindRuntime(["write"], "local");
    await h.service.testRuntime();
    h.local.limits = { usingOverage: false, seenAtMs: NOW + 1 };
    await h.service.prepare("t1");
    expect(h.local.mail).toHaveLength(1);
    const s = await h.service.status();
    // Nothing is kept for Local, and nothing of Plan runtime's was cleared by the move.
    expect(s.settings.plans?.local).toBeUndefined();
    expect(s.settings.plans?.plan?.limits).toEqual(full);
    expect(runtimeInfo(s, "local")?.limits).toBeUndefined();
    expect((await h.insights.listLedger(10)).some((l) => l.runtimeId === "local")).toBe(true);
  });

  it("keeps each plan's windows and our use apart; one plan full does not stop the other", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    await h.service.setKindRuntime(["write"], "codex");
    await h.settings.update({ plan: { runtimeId: "plan", limits: full, usedByUsPercent: 4 } });
    await h.service.testRuntime();
    const week = { usedPercent: 30, resetsAtMs: NOW + 5 * DAY };
    h.codex.limits = { week, usingOverage: false, seenAtMs: NOW };
    await h.service.prepare("t1");
    h.codex.limits = { week: { ...week, usedPercent: 32 }, usingOverage: false, seenAtMs: NOW };
    await h.service.prepare("t1");
    expect(h.codex.mail).toHaveLength(2);
    const s = await h.service.status();
    expect(planUseOf(s.settings, "codex")).toMatchObject({
      usedByUsPercent: 2,
      usedWeekResetsAtMs: NOW + 5 * DAY,
    });
    expect(planUseOf(s.settings, "plan")).toMatchObject({ limits: full, usedByUsPercent: 4 });
    // Each card shows its own windows.
    expect(runtimeInfo(s, "codex")?.limits?.week?.usedPercent).toBe(32);
    expect(runtimeInfo(s, "plan")?.limits).toEqual(full);
  });
});

describe("the test is for a model (ADR 0119)", () => {
  const tests = (r: Runtime) => r.calls.filter((c) => c.untrusted.includes(TEST_PROMPT_QUOTE));

  it("tests again when the model for understanding mail changes to one never tested", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "local" });
    await h.service.testRuntime();
    expect((await h.settings.getRuntimeRecord("local"))?.model).toBe("m-large");
    expect(reading(await h.service.status())?.status).toBe("ready");
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
    expect(reading(await h.service.status())?.status).toBe("ready");
    // No mail went with either test.
    expect(h.local.mail).toEqual([]);
  });

  it("with AI off, a new model is not checked yet until the person checks it", async () => {
    const h = await build();
    await h.service.setKindRuntime(ALL, "local");
    await h.service.testRuntime();
    expect(reading(await h.service.status())?.status).toBe("ready");
    await h.service.setModels({ understand: "m-small" });
    await settle();
    expect(reading(await h.service.status())?.status).toBe("found");
    expect(tests(h.local)).toHaveLength(1);
    // Back to the model that was tested: the record holds for the last one tested only.
    await h.service.setModels({ understand: "m-large" });
    expect(reading(await h.service.status())?.status).toBe("ready");
  });

  it("keeps a record from before, with no model, ready for the model chosen now", async () => {
    const h = await build();
    await h.settings.putRuntimeRecord({
      runtimeId: "plan",
      status: "ready",
      plan: "pro",
      testedAtMs: NOW - DAY,
    });
    await h.service.setKindRuntime(ALL, "plan");
    expect(reading(await h.service.status())?.status).toBe("ready");
    expect(h.plan.calls).toEqual([]);
  });
});

describe("Codex is a runtime (ADR 0120)", () => {
  it("needs its own consent, and runs only the kinds put on it", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.testRuntime();
    await h.service.prepare("t1");
    expect(h.plan.mail).toHaveLength(1);

    const moved = await h.service.setKindRuntime(ALL, "codex");
    // Agreeing for the plan runtime agreed to nothing for Codex.
    expect(moved.consents.map((c) => c.runtimeId)).toEqual(["plan"]);
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
    const s = await h.service.setKindRuntime(ALL, "codex");
    expect(s.settings.models).toEqual({
      understand: "luna",
      write: "sol",
      answer: "sol",
      titles: "luna",
      appearance: "sol",
    });
  });

  it("keeps the windows it reads when looked at, and is held to them as any plan (rule 9)", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    // The windows of the plan runtime, used up: they say nothing of Codex's.
    await h.settings.update({
      plan: {
        runtimeId: "plan",
        limits: {
          session: { usedPercent: 100, resetsAtMs: NOW + DAY },
          week: { usedPercent: 100, resetsAtMs: NOW + DAY },
          usingOverage: true,
          seenAtMs: NOW,
        },
      },
    });
    const read = {
      session: { usedPercent: 12, resetsAtMs: NOW + 3_600_000 },
      week: { usedPercent: 30, resetsAtMs: NOW + 5 * DAY },
      usingOverage: false,
      seenAtMs: NOW,
    };
    h.codex.info = { ...h.codex.info, plan: "plus", limits: read };
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    await h.service.setKindRuntime(ALL, "codex");
    expect(planUseOf(await h.settings.get(), "codex").limits).toEqual(read);
    const s = await h.service.inspect();
    expect(runtimeInfo(s, "codex")?.limits).toEqual(read);
    // The plan runtime keeps its own windows, and shows none of Codex's.
    expect(runtimeInfo(s, "plan")?.limits?.week?.usedPercent).toBe(100);
    await h.service.testRuntime();
    await h.service.prepare("t1");
    expect(h.codex.mail).toHaveLength(1);

    // A turn's windows are kept as any plan's are; full, the person's own turn waits.
    h.codex.limits = { ...read, session: { usedPercent: 100, resetsAtMs: NOW + 3_600_000 } };
    await h.service.prepare("t1");
    expect(planUseOf(await h.settings.get(), "codex").limits?.session?.usedPercent).toBe(100);
    await expect(h.service.prepare("t1")).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(h.codex.mail).toHaveLength(2);
  });

  it("says the person's ChatGPT plan when a turn would run off it", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "codex" });
    h.codex.run = async () => {
      throw new AgentRunError("notPlan", "The turn would not run on a ChatGPT plan.");
    };
    const s = await h.service.testRuntime();
    expect(runtimeInfo(s, "codex")?.problem).toBe("The assistant is not using your ChatGPT plan.");
  });
});
