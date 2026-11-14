import { visibleText } from "@matters/adapter-mime";
import { CONTRAST_PAIRS, THEME_TOKENS } from "@matters/contracts";
import type { AgentRunRequest, AgentRunResult, PlanLimits } from "@matters/core";
import {
  AgentRunError,
  CURRENT_OPEN,
  DESCRIBED_OPEN,
  everyKindOn,
  MAX_THEME_DESCRIPTION_CHARS,
  PREVIOUS_OPEN,
  PROBLEMS_OPEN,
} from "@matters/core";
import {
  createInMemoryStorage,
  FakeAgentRuntime,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
  settle,
} from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError, InvalidAgentSettingError } from "../src/backend/agentApi.ts";
import {
  AgentService,
  KICK_DEBOUNCE_MS,
  NOT_A_THEME,
  TEST_PROMPT_QUOTE,
} from "../src/backend/agentService.ts";

// ADR 0134, rules 12 to 15: a theme from a description is one turn of the kind `appearance`, on its
// own runtime, model and effort. No mail, no address, no account and no tools go with it; no
// account is asked; the answer is the theme's text and nothing else is done with it here.

const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
const MAIL_TEXT = "The invoice for October is attached, please pay by Friday.";
const MOSS = { name: "Moss", dark: { bg: "#18201a", chrome: "#1d261f" } };
const MOSS_TEXT = JSON.stringify(MOSS, null, 2);

const verdictOfTest = {
  verdicts: [{ thread: 1, fit: 3, why: "It promises it.", message: 1, quote: TEST_PROMPT_QUOTE }],
};
const week = (usedPercent: number): PlanLimits => ({
  session: { usedPercent: 10, resetsAtMs: NOW + 3_600_000 },
  week: { usedPercent, resetsAtMs: NOW + 3 * DAY },
  usingOverage: false,
  seenAtMs: NOW,
});

type Answer = (request: AgentRunRequest) => AgentRunResult | Promise<AgentRunResult>;

/**
 * The testkit's runtime, answering the made-up test by itself and every other turn with `answer`,
 * which a test sets. Steps are queued ahead: a test never runs out of them.
 */
function answering(runtime: FakeAgentRuntime) {
  const state: { answer: Answer } = { answer: () => ({ value: { theme: MOSS_TEXT } }) };
  for (let i = 0; i < 40; i++) {
    runtime.script((request) =>
      request.untrusted.includes(TEST_PROMPT_QUOTE)
        ? { value: verdictOfTest }
        : state.answer(request),
    );
  }
  return state;
}

async function build() {
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const insights = new InMemoryAgentInsightStore();
  const settings = new InMemoryAgentSettings();
  await storage.accounts.add({
    id: "acc1",
    address: "me@example.com",
    displayName: "Milo Example",
    imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
    createdAtMs: 1,
  });
  const message = makeMessage({
    seq: 1,
    accountId: "acc1",
    threadId: "t1",
    providerId: "t1-1",
    dateMs: NOW - DAY,
    from: { name: "Anna", address: "anna@example.org" },
    to: [{ address: "me@example.com" }],
    subject: "Invoice October",
    labelIds: ["inbox"],
  });
  const { keys } = await storage.store.upsertMessages([message]);
  await storage.bodies.putBodies(keys.map((key) => ({ key, threadId: "t1", text: MAIL_TEXT })));
  // A runtime on a plan, ready, and one on this machine that no account agreed to.
  const plan = new FakeAgentRuntime({
    id: "plan",
    name: "Plan runtime",
    info: { plan: "pro", models: ["haiku", "sonnet", "opus"] },
  });
  const local = FakeAgentRuntime.onThisMachine({
    models: ["m-small", "m-large"],
    info: { status: "found" },
  });
  const planAnswers = answering(plan);
  const localAnswers = answering(local);
  const service = new AgentService({
    runtimes: [plan, local],
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    accounts: storage.accounts,
    insights,
    settings,
    drafts: storage.drafts,
    saveDraft: async () => {
      throw new Error("a theme never saves a draft");
    },
    clock,
    visibleText,
    onChanged: () => {},
  });
  const pass = async () => {
    service.kick();
    await clock.advance(KICK_DEBOUNCE_MS + 100);
    await service.idle();
    await settle();
  };
  /** AI on for the plan runtime, every kind on it, the reading paused so only asks run. */
  const enable = async () => {
    await service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await service.pauseReading();
  };
  const themeCalls = (r: FakeAgentRuntime) =>
    r.calls.filter((c) => c.untrusted.includes(DESCRIBED_OPEN));
  return {
    service,
    settings,
    insights,
    plan,
    local,
    planAnswers,
    localAnswers,
    clock,
    pass,
    enable,
    themeCalls,
  };
}

describe("a theme from a description (ADR 0134, rules 12 to 15)", () => {
  it("is one turn on the kind's runtime, model and effort, given nothing but the description and the format", async () => {
    const h = await build();
    await h.enable();
    await h.service.setModels({ appearance: "opus" }, { appearance: "high" });
    const { text } = await h.service.makeTheme({ description: "  moss   and\nslate  " });
    expect(JSON.parse(text)).toEqual(MOSS);

    const [call, ...more] = h.themeCalls(h.plan);
    expect(more).toEqual([]);
    expect(call?.model).toBe("opus");
    expect(call?.effort).toBe("high");
    // No files and no tools: the runtime's tool turn is not used, and nothing goes whole.
    expect(call?.files).toBeUndefined();
    expect(call?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["theme"],
      properties: { theme: { type: "string", minLength: 2, maxLength: 16 * 1024 } },
    });
    // The person's words, made one line, under their own heading; nothing of the mailbox.
    expect(call?.untrusted).toContain(`${DESCRIBED_OPEN}\nmoss and slate\n`);
    const all = `${call?.instructions}\n${call?.untrusted}`;
    for (const absent of [
      "me@example.com",
      "anna@example.org",
      "acc1",
      "Milo Example",
      "Anna",
      "Invoice October",
      MAIL_TEXT,
      CURRENT_OPEN,
      PREVIOUS_OPEN,
      PROBLEMS_OPEN,
    ]) {
      expect(all, absent).not.toContain(absent);
    }
    // What a theme is, from the tables main checks with: every token and every pair.
    for (const token of THEME_TOKENS) expect(call?.instructions).toContain(`- ${token}: `);
    for (const [ink, surfaces] of Object.entries(CONTRAST_PAIRS)) {
      expect(call?.instructions).toContain(`- ${ink} on ${surfaces?.join(", ")}`);
    }
    expect(call?.instructions).toContain("at least 4.5:1");
    expect(call?.instructions).toContain("no CSS, no url");
  });

  it("counts as work the person asked for, named in the ledger with its kind and no account", async () => {
    const h = await build();
    await h.enable();
    // The plan's week is far over what background work may use: a turn the person asks for runs.
    h.planAnswers.answer = () => ({ value: { theme: MOSS_TEXT }, limits: week(92) });
    await h.service.setWeekShare(5);
    await h.service.makeTheme({ description: "moss" });
    await h.service.makeTheme({ description: "moss again" });
    expect(h.themeCalls(h.plan)).toHaveLength(2);
    const [line] = await h.insights.listLedger(1);
    expect(line).toEqual({
      atMs: NOW,
      runtimeId: "plan",
      accountId: "",
      purpose: "appearance",
      threads: 0,
    });
    // What it used is the plan's, as for any turn (ADR 0121, rule 6).
    expect((await h.settings.get()).plans?.plan?.limits?.week?.usedPercent).toBe(92);
  });

  it("sends the theme that is on, and on the retry the answer refused and its problems", async () => {
    const h = await build();
    await h.enable();
    await h.service.makeTheme({
      description: "warmer",
      current: '{"name": "Paper", "light": {"bg": "#fbf9f4"}}',
      retry: {
        previous: '{"name": "Warm", "light": {"ink": "#dddddd"}}',
        problems: ["In light, the text (ink) on the ground (bg) is 1.36:1; it needs 4.5:1."],
      },
    });
    const call = h.themeCalls(h.plan)[0];
    expect(call?.untrusted).toContain(`${CURRENT_OPEN}\n{"name": "Paper"`);
    expect(call?.untrusted).toContain(`${PREVIOUS_OPEN}\n{"name": "Warm"`);
    expect(call?.untrusted).toContain(`${PROBLEMS_OPEN}\n- In light, the text (ink)`);
  });

  it("takes the theme bare, fenced or with words around it, and anything else is not a theme", async () => {
    const h = await build();
    await h.enable();
    const make = async (theme: unknown) => {
      h.planAnswers.answer = () => ({ value: { theme } });
      return (await h.service.makeTheme({ description: "moss" })).text;
    };
    expect(JSON.parse(await make(`\`\`\`json\n${MOSS_TEXT}\n\`\`\``))).toEqual(MOSS);
    expect(JSON.parse(await make(`Here it is:\n${MOSS_TEXT}\nEnjoy.`))).toEqual(MOSS);
    expect(JSON.parse(await make(MOSS))).toEqual(MOSS);
    // Not checked here: main is the judge, as for a file (rule 12).
    expect(await make('{"name": "x", "light": {"bg": "url(x)"}}')).toBe(
      '{"name": "x", "light": {"bg": "url(x)"}}',
    );
    for (const bad of ["no theme today", "[1, 2]", '{"name": ', "", 42, null]) {
      h.planAnswers.answer = () => ({ value: { theme: bad } });
      await expect(h.service.makeTheme({ description: "moss" }), String(bad)).rejects.toThrow(
        NOT_A_THEME,
      );
    }
    h.planAnswers.answer = () => ({ value: "not even an object" });
    await expect(h.service.makeTheme({ description: "moss" })).rejects.toThrow(NOT_A_THEME);
  });

  it("refuses a blank or long description without a turn", async () => {
    const h = await build();
    await h.enable();
    await expect(h.service.makeTheme({ description: " \n " })).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    await expect(
      h.service.makeTheme({ description: "x".repeat(MAX_THEME_DESCRIPTION_CHARS + 1) }),
    ).rejects.toBeInstanceOf(InvalidAgentSettingError);
    expect(h.themeCalls(h.plan)).toEqual([]);
  });

  it("says why when its runtime cannot be used, and never runs anywhere else (rule 15)", async () => {
    const h = await build();
    // AI off: nothing runs.
    await expect(h.service.makeTheme({ description: "moss" })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    await h.enable();
    const fails = async (error: Error, says: string | RegExp) => {
      h.planAnswers.answer = () => {
        throw error;
      };
      await expect(h.service.makeTheme({ description: "moss" })).rejects.toThrow(says);
    };
    await fails(new AgentRunError("limit", "Limit."), "allowance is used up");
    await fails(
      new AgentRunError("effortRefused", "Opus does not take the effort max."),
      "Opus does not take the effort max.",
    );
    await fails(new AgentRunError("failed", "spawn ENOENT /secret/path"), /could not make a theme/);
    await fails(new AgentRunError("notSignedIn", "x"), "signed out or not using your plan");
    // Signed out now: the runtime waits for the person, and the turn is not run.
    h.plan.info = { ...h.plan.info, status: "signedOut" };
    await h.service.inspect();
    const before = h.plan.calls.length;
    await expect(h.service.makeTheme({ description: "moss" })).rejects.toThrow(
      "Plan runtime is not ready",
    );
    expect(h.plan.calls.length).toBe(before);
    // The other runtime, ready to be tested and free, was never asked to make it.
    expect(h.themeCalls(h.local)).toEqual([]);
  });

  it("says when the kind's model is gone, and puts no other in its place", async () => {
    const h = await build();
    await h.enable();
    await h.service.setModels({ appearance: "opus" });
    h.plan.info = { ...h.plan.info, models: ["haiku", "sonnet"] };
    await h.service.inspect();
    await expect(h.service.makeTheme({ description: "moss" })).rejects.toThrow(
      "opus is not available on Plan runtime now. Choose another model for making themes in Settings.",
    );
    expect(h.themeCalls(h.plan)).toEqual([]);
  });

  it("can be stopped: a stopped turn gives nothing, and is still counted", async () => {
    const h = await build();
    await h.enable();
    let release: (() => void) | undefined;
    h.planAnswers.answer = () =>
      new Promise<AgentRunResult>((resolve) => {
        release = () => resolve({ value: { theme: MOSS_TEXT } });
      });
    const making = h.service.makeTheme({ description: "moss" });
    await settle();
    expect(release).toBeDefined();
    // One at a time.
    await expect(h.service.makeTheme({ description: "slate" })).rejects.toThrow(
      "still making a theme",
    );
    await h.service.makeThemeStop();
    release?.();
    await expect(making).rejects.toThrow("Stopped.");
    expect((await h.insights.listLedger(1))[0]?.purpose).toBe("appearance");
    // Stopping when nothing runs does nothing, and the next ask runs.
    await h.service.makeThemeStop();
    h.planAnswers.answer = () => ({ value: { theme: MOSS_TEXT } });
    expect((await h.service.makeTheme({ description: "moss" })).text).toBe(MOSS_TEXT);
  });
});

describe("a runtime in use only for making themes (ADR 0134, rule 14; consequences)", () => {
  it("is in use, tested by itself with the made-up message, and works with no account agreed to it", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    expect((await h.settings.get()).kindRuntime).toEqual(everyKindOn("plan"));
    // Moving the kind asks no account and grants nothing.
    await h.service.setKindRuntime(["appearance"], "local");
    await h.pass();
    const status = await h.service.status();
    expect(status.settings.kindRuntime).toEqual({ ...everyKindOn("plan"), appearance: "local" });
    expect(status.consents.map((c) => c.runtimeId)).toEqual(["plan"]);
    // In use (ADR 0121, rule 2), so looked at and tested: with the made-up message, never mail.
    expect(status.runtimes.find((r) => r.id === "local")?.info?.status).toBe("ready");
    expect(h.local.calls.length).toBeGreaterThan(0);
    for (const c of h.local.calls) expect(c.untrusted).not.toContain(MAIL_TEXT);
    // It starts on the model the runtime names, at the default effort.
    expect(status.settings.models.appearance).toBe("m-small");
    expect(status.settings.efforts.appearance).toBe("default");

    const { text } = await h.service.makeTheme({ description: "moss" });
    expect(text).toBe(MOSS_TEXT);
    expect(h.themeCalls(h.local)).toHaveLength(1);
    expect(h.themeCalls(h.plan)).toEqual([]);
    expect((await h.insights.listLedger(1))[0]).toMatchObject({
      runtimeId: "local",
      accountId: "",
      purpose: "appearance",
      threads: 0,
    });
    // The other kinds stay where they were, with the accounts that agreed to their runtime.
    expect(status.settings.kindRuntime.write).toBe("plan");
  });

  it("is tested when the person asks for a theme, if it was not yet", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.pauseReading();
    await h.service.setKindRuntime(["appearance"], "local");
    // Paused, so no pass tested it; the ask does, first, with the made-up message.
    expect(h.local.calls).toEqual([]);
    await h.service.makeTheme({ description: "moss" });
    expect(h.local.calls.map((c) => c.untrusted.includes(TEST_PROMPT_QUOTE))).toEqual([
      true,
      false,
    ]);
  });

  it("does not run on the runtime the person moved the kind from while its gates waited (rule 15)", async () => {
    const h = await build();
    await h.service.setEnabled({ accountIds: ["acc1"], runtimeId: "plan" });
    await h.service.pauseReading();
    await h.service.setKindRuntime(["appearance"], "local");
    // The ask looks at the runtime first; that look waits until the test lets it go.
    let release: (() => void) | undefined;
    const inspect = h.local.inspect.bind(h.local);
    h.local.inspect = () =>
      new Promise((resolve) => {
        release = () => resolve(inspect());
      });
    const making = h.service.makeTheme({ description: "moss" });
    await settle();
    expect(release).toBeDefined();
    await h.service.setKindRuntime(["appearance"], "plan");
    release?.();
    await expect(making).rejects.toThrow("Stopped.");
    expect(h.themeCalls(h.local)).toEqual([]);
    expect(h.themeCalls(h.plan)).toEqual([]);
  });
});
