import type { AgentRuntimeInfo, AgentStatus, PlanLimits } from "@matters/core";
import { everyKindOn, kindInfo } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  answeredByLine,
  consentText,
  customShare,
  EFFORT_WORDS,
  effortOptions,
  effortShown,
  hasNoPlan,
  instructionScopeWords,
  kindsWords,
  kindWaits,
  ledgerEffort,
  loopOffered,
  ourShare,
  planButton,
  questionButtonText,
  ruleText,
  sentLine,
  shareChoice,
  shareHint,
  shareOptions,
  signInCommand,
  splitYours,
  statusWords,
  talkRuntimeName,
  talkRuntimes,
  usedForLine,
  vendorName,
  wholeFilesText,
  writtenByLine,
} from "../src/renderer/agentText.ts";

const NOW = Date.UTC(2026, 10, 5, 10, 42);
const models = { understand: "haiku", write: "sonnet", answer: "sonnet", titles: "haiku" };
const LIMITS: PlanLimits = {
  session: { usedPercent: 39, resetsAtMs: NOW + 3_600_000 },
  week: { usedPercent: 22, resetsAtMs: NOW + 3 * 86_400_000 },
  usingOverage: false,
  seenAtMs: NOW - 60_000,
};
const claudeInfo: AgentRuntimeInfo = {
  id: "claude-code",
  name: "Claude Code",
  status: "ready",
  models: ["haiku", "sonnet"],
};
/** Every kind of work on `runtime`, with its plan's windows (`null`: none seen yet). */
const status = (
  over: Partial<AgentStatus> = {},
  runtime: AgentRuntimeInfo = claudeInfo,
  limits: PlanLimits | null = LIMITS,
): AgentStatus => ({
  settings: {
    enabled: true,
    kindRuntime: everyKindOn(runtime.id),
    models,
    efforts: { understand: "low", write: "default", answer: "default", titles: "low" },
    weekSharePercent: 10,
    plans: {
      [runtime.id]: { usedByUsPercent: 4.2, ...(limits === null ? {} : { limits }) },
    },
  },
  runtimes: [{ id: runtime.id, name: runtime.name, info: runtime }],
  unlisted: [],
  consents: [],
  progress: { state: "idle" },
  ledger: [],
  ...over,
});

describe("the status line", () => {
  it("shows the session's percent left, late under 20", () => {
    expect(planButton(status(), "claude-code", NOW)).toEqual({
      text: "Claude Code 61% left",
      late: false,
    });
    const s = status({}, claudeInfo, {
      usingOverage: false,
      seenAtMs: NOW,
      session: { usedPercent: 85, resetsAtMs: NOW + 1000 },
    });
    expect(planButton(s, "claude-code", NOW)).toEqual({ text: "Claude Code 15% left", late: true });
  });

  it("says when limits are not known, and when work is paused", () => {
    const unknown = status({}, claudeInfo, null);
    expect(planButton(unknown, "claude-code", NOW)?.text).toBe(
      "Claude Code · limits not known yet",
    );
    const paused = status({
      progress: {
        state: "paused",
        reason: "sessionLimit",
        untilMs: new Date(2026, 10, 5, 14, 0).getTime(),
      },
    });
    expect(planButton(paused, "claude-code", new Date(2026, 10, 5, 10, 0).getTime())?.text).toBe(
      "Paused until 14:00 · plan limit",
    );
  });

  it("says our share and who wrote a draft: always the writing model", () => {
    expect(ourShare(status(), "claude-code")).toBe("Matters this week: about 4% of Claude");
    expect(writtenByLine(kindInfo(status(), "write"), models)).toBe(
      "Claude Code, Sonnet, your plan",
    );
    expect(writtenByLine(null, { ...models, write: "opus" })).toBe("Agent, Opus, your plan");
  });

  it("reads Write the draft once a way forward is chosen, and Answer until then", () => {
    expect(questionButtonText(false, true)).toBe("Write the draft");
    expect(questionButtonText(false, false)).toBe("Answer");
    expect(questionButtonText(true, true)).toBe("Writing…");
    expect(questionButtonText(true, false)).toBe("Writing…");
  });
});

describe("the person's words", () => {
  it("underlines only what occurs word for word", () => {
    expect(splitYours("Hi,\n\nI pay Friday.\n\nBye", ["I pay Friday."])).toEqual([
      { text: "Hi,\n\n", yours: false },
      { text: "I pay Friday.", yours: true },
      { text: "\n\nBye", yours: false },
    ]);
    expect(splitYours("Hi", ["other"])).toEqual([{ text: "Hi", yours: false }]);
  });
});

describe("the words of a rule", () => {
  it("says what a rule does", () => {
    expect(ruleText({ scope: "sender", subject: "alerts@x.com" })).toBe(
      "No reply needed from alerts@x.com",
    );
    expect(ruleText({ scope: "domain", subject: "x.com" })).toBe("No reply needed from x.com");
    expect(ruleText({ scope: "type", subject: "programLike" })).toBe(
      "No reply needed from addresses that look like programs (alerts@, updates@…)",
    );
  });

  it("describes a rule about a kind in the person's words (ADR 0068, rule 3)", () => {
    expect(ruleText({ scope: "category", subject: "offer" })).toBe("Don't show offers");
    expect(ruleText({ scope: "category", subject: "official" })).toBe(
      "Don't show mail from public offices",
    );
    expect(ruleText({ scope: "sender", subject: "a@b.example" })).toBe(
      "No reply needed from a@b.example",
    );
  });
});

describe("the words of an instruction", () => {
  it("says where it applies", () => {
    expect(instructionScopeWords("general")).toBe("In general");
    expect(instructionScopeWords("understand")).toBe("When reading");
    expect(instructionScopeWords("write")).toBe("When writing");
    expect(instructionScopeWords("thread")).toBe("For this thread");
  });
});

describe("the effort beside each model (ADR 0118)", () => {
  const all = { efforts: ["low", "medium", "high", "xhigh", "max"] } as const;

  it("offers Default and only the levels the runtime lists, lowest first (rule 4)", () => {
    expect(effortOptions(all)).toEqual([
      ["default", "Default"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra high"],
      ["max", "Max"],
    ]);
    expect(effortOptions({ efforts: ["high", "low"] })).toEqual([
      ["default", "Default"],
      ["low", "Low"],
      ["high", "High"],
    ]);
  });

  it("offers nothing, so no control shows, when the runtime lists none or is not known", () => {
    expect(effortOptions({ efforts: [] })).toEqual([]);
    expect(effortOptions({})).toEqual([]);
    expect(effortOptions(null)).toEqual([]);
  });

  it("shows a stored level the runtime does not list as Default, which is what is sent", () => {
    expect(effortShown("max", { efforts: ["low", "medium"] })).toBe("default");
    expect(effortShown("medium", { efforts: ["low", "medium"] })).toBe("medium");
    expect(effortShown("default", all)).toBe("default");
  });

  it("names the effort of a ledger line, and nothing for a line without one (rule 7)", () => {
    expect(ledgerEffort({ effort: "xhigh" })).toBe("extra high effort");
    expect(ledgerEffort({ effort: "low" })).toBe("low effort");
    expect(ledgerEffort({})).toBe("");
    expect(EFFORT_WORDS.default).toBe("Default");
  });
});

describe("a runtime on this machine (ADR 0119)", () => {
  const ollama = {
    id: "ollama",
    name: "Ollama",
    status: "found" as const,
    models: ["qwen3:8b", "reasoner:20b"],
    modelEfforts: { "qwen3:8b": [], "reasoner:20b": ["low", "high"] as const },
    noPlan: true,
    onThisMachine: true,
  };

  it("says each state in a few words, and none of a sign-in for one on this Mac", () => {
    expect(statusWords(null)).toBe("Not looked at yet");
    expect(statusWords({ ...ollama, status: "notRunning" })).toBe("Not running");
    expect(statusWords({ ...ollama, status: "noModel" })).toBe("No model installed");
    expect(statusWords(ollama)).toBe("Installed · not checked yet");
    expect(statusWords({ ...ollama, status: "ready" })).toBe("Ready");
    expect(
      statusWords({ id: "claude-code", name: "Claude Code", status: "found", models: [] }),
    ).toBe("Signed in · not checked yet");
  });

  it("offers the levels of the model chosen for the work, and none for a model with none (rule 9)", () => {
    expect(effortOptions(ollama, "reasoner:20b")).toEqual([
      ["default", "Default"],
      ["low", "Low"],
      ["high", "High"],
    ]);
    expect(effortOptions(ollama, "qwen3:8b")).toEqual([]);
    expect(effortOptions(ollama)).toEqual([]);
    expect(effortShown("max", ollama, "reasoner:20b")).toBe("default");
    expect(effortShown("high", ollama, "reasoner:20b")).toBe("high");
  });

  it("shows no plan: no plan button but a pause, and words that say where it ran (rule 7)", () => {
    const local = status({}, ollama, null);
    expect(hasNoPlan(kindInfo(local, "understand"))).toBe(true);
    expect(hasNoPlan(kindInfo(status(), "understand"))).toBe(false);
    expect(planButton(local, "ollama", NOW)).toBeNull();
    expect(
      planButton(
        { ...local, progress: { state: "paused", reason: "pausedByPerson" } },
        "ollama",
        NOW,
      ),
    ).toMatchObject({ late: true });
    expect(writtenByLine(ollama, { ...models, write: "qwen3:8b" })).toBe(
      "Ollama, Qwen3:8b, on this Mac",
    );
    expect(writtenByLine(kindInfo(status(), "write"), models)).toBe(
      "Claude Code, Sonnet, your plan",
    );
    expect(answeredByLine("Ollama", "qwen3:8b")).toBe("Ollama, Qwen3:8b, on this Mac");
    expect(answeredByLine("Claude Code", "sonnet")).toBe("Claude Code, Sonnet, your plan");
    expect(sentLine("Ollama")).toBe(
      "Read this thread with Ollama, on this Mac. Nothing left this Mac.",
    );
  });
});

describe("the search in a loop is offered only where it runs (ADR 0083; ADR 0119, rule 10)", () => {
  it("shows the setting for a runtime with tools, and not for one without", () => {
    const base = { id: "x", name: "X", status: "ready" as const, models: [] };
    expect(loopOffered({ ...base, tools: true }, "m")).toBe(true);
    expect(loopOffered(base, "m")).toBe(false);
    expect(loopOffered(null, "m")).toBe(false);
    // Per model: the setting follows the model chosen for writing (ADR 0119, rule 10).
    const some = { ...base, tools: true, toolModels: ["qwen3:8b"] };
    expect(loopOffered(some, "qwen3:8b")).toBe(true);
    expect(loopOffered(some, "gemma:2b")).toBe(false);
  });
});

describe("Codex, on the person's ChatGPT plan (ADR 0120)", () => {
  const codex = {
    id: "codex",
    name: "Codex",
    status: "ready" as const,
    plan: "plus",
    models: ["gpt-6.1-sol", "gpt-6-luna"],
    pausesOnLimit: true,
    modelFiles: { "gpt-6.1-sol": ["image/png" as const], "gpt-6-luna": [] },
  };
  const claude = { id: "claude-code", name: "Claude Code", status: "ready" as const, models: [] };

  it("says mail goes to OpenAI under the ChatGPT plan, only when asked and for views with a prompt", () => {
    expect(consentText(codex)).toBe(
      "Mail goes to OpenAI, under your ChatGPT plan, only when you ask about it, and for views with a prompt, such as Needs you, which read new mail as it comes. Your ChatGPT privacy settings apply to what is sent.",
    );
    expect(consentText(claude)).toBe(
      "Mail goes to Claude only when you ask about it, and for views with a prompt, such as Needs you, which read new mail as it comes. Your Claude privacy settings apply to what is sent.",
    );
    expect(consentText({ ...claude, id: "ollama", name: "Ollama", onThisMachine: true })).toContain(
      "your mail stays on this Mac",
    );
    expect(vendorName(codex)).toBe("OpenAI");
    expect(vendorName(claude)).toBe("Claude");
    expect(vendorName({ id: "other", name: "Other" })).toBe("Other");
  });

  it("names each runtime's own command to sign in", () => {
    expect(signInCommand(codex)).toBe("codex login");
    expect(signInCommand(claude)).toBe("claude auth login");
  });

  it("shows its windows as any plan's, and the pause a refusal made (rule 9)", () => {
    const s = status({}, codex);
    expect(planButton(s, "codex", NOW)).toEqual({ text: "Codex 61% left", late: false });
    expect(planButton(status({}, codex, null), "codex", NOW)).toEqual({
      text: "Codex · limits not known yet",
      late: false,
    });
    expect(
      planButton(
        { ...s, progress: { state: "paused", reason: "limit", untilMs: NOW + 3_600_000 } },
        "codex",
        NOW,
      )?.text,
    ).toMatch(/^Paused until .* · plan limit$/);
  });

  it("says what goes whole of a file with no text on each runtime (rule 7)", () => {
    expect(wholeFilesText(codex)).toBe(
      "With Codex, a photo that has no text goes whole, up to three a question; a scan in a PDF does not.",
    );
    expect(wholeFilesText(claude)).toContain("With Claude Code, a scan or a photo");
    expect(wholeFilesText({ ...codex, modelFiles: {} })).toBe("");
    expect(wholeFilesText(null)).toBe("");
  });
});

describe("a runtime for each kind of work (ADR 0121)", () => {
  const ollama: AgentRuntimeInfo = {
    id: "ollama",
    name: "Ollama",
    status: "ready",
    models: ["qwen3:8b"],
    noPlan: true,
  };
  const codex: AgentRuntimeInfo = { id: "codex", name: "Codex", status: "signedOut", models: [] };
  /** Understanding mail on Ollama, writing and questions on Claude Code, titles on Codex. */
  const spread = (over: Partial<AgentStatus> = {}): AgentStatus => {
    const base = status();
    return {
      ...base,
      settings: {
        ...base.settings,
        kindRuntime: {
          understand: "ollama",
          write: "claude-code",
          answer: "claude-code",
          titles: "codex",
        },
        plans: {
          "claude-code": { usedByUsPercent: 4.2, limits: LIMITS },
          codex: { usedByUsPercent: 0.5 },
        },
      },
      runtimes: [
        { id: "claude-code", name: "Claude Code", info: claudeInfo },
        { id: "ollama", name: "Ollama", info: ollama },
        { id: "codex", name: "Codex", info: codex },
      ],
      consents: [
        { accountId: "a", runtimeId: "claude-code", grantedAtMs: 1 },
        { accountId: "b", runtimeId: "ollama", grantedAtMs: 1 },
      ],
      ...over,
    };
  };

  it("says what each runtime is used for", () => {
    expect(usedForLine(spread(), "claude-code")).toBe("Used for writing and questions");
    expect(usedForLine(spread(), "ollama")).toBe("Used for understanding mail");
    expect(usedForLine(status(), "claude-code")).toBe("Used for all work");
    expect(usedForLine(status(), "ollama")).toBe("Not used");
    expect(kindsWords(["understand", "write", "titles"])).toBe(
      "understanding mail, writing and talk titles",
    );
  });

  it("says why a kind waits while the others run (rule 3)", () => {
    expect(kindWaits(spread(), "titles")).toBe("Waits: Codex is not signed in.");
    expect(kindWaits(spread(), "write")).toBe("");
    expect(kindWaits(spread(), "understand")).toBe("");
    const none = spread({ consents: [] });
    expect(kindWaits(none, "write")).toBe(
      "Waits: you have not let Claude Code read any account yet.",
    );
  });

  it("shows each plan's own windows and share (rule 6)", () => {
    expect(planButton(spread(), "claude-code", NOW)?.text).toBe("Claude Code 61% left");
    expect(planButton(spread(), "ollama", NOW)).toBeNull();
    expect(ourShare(spread(), "codex")).toBe("Matters this week: less than 1% of OpenAI");
    expect(ourShare(spread(), "claude-code")).toBe("Matters this week: about 4% of Claude");
  });

  it("lists for a talk every runtime that is ready and agreed to for its mail (rule 8)", () => {
    expect(talkRuntimes(spread(), null).map((r) => r.id)).toEqual(["claude-code", "ollama"]);
    expect(talkRuntimes(spread(), "a").map((r) => r.id)).toEqual(["claude-code"]);
    expect(talkRuntimes(spread(), "b")).toEqual([
      { id: "ollama", name: "Ollama", models: ["qwen3:8b"] },
    ]);
    expect(talkRuntimeName(spread(), "all", null)).toBe("Claude Code");
    expect(talkRuntimeName(spread(), "thread", { runtimeId: "ollama" })).toBe("Ollama");
    expect(talkRuntimeName(null, "all", null)).toBe("The agent");
  });
});

describe("the background limit (ADR 0131)", () => {
  it("lists the shares, no limit and a custom one", () => {
    expect(shareOptions()).toEqual([
      ["5", "Up to 5% of my week"],
      ["10", "Up to 10% of my week"],
      ["25", "Up to 25% of my week"],
      ["50", "Up to 50% of my week"],
      ["none", "No limit"],
      ["custom", "Custom…"],
    ]);
  });

  it("shows a stored share as its preset, no limit or custom", () => {
    expect(shareChoice(10)).toBe("10");
    expect(shareChoice(50)).toBe("50");
    expect(shareChoice(100)).toBe("none");
    expect(shareChoice(40)).toBe("custom");
    expect(shareChoice(0)).toBe("custom");
  });

  it("takes a typed share only as a whole number from 1 to 99", () => {
    expect(customShare("40")).toBe(40);
    expect(customShare(" 7 ")).toBe(7);
    expect(customShare("99")).toBe(99);
    for (const bad of ["", "0", "100", "-5", "12.5", "1e1", "abc", "40%"]) {
      expect(customShare(bad)).toBeUndefined();
    }
  });

  it("says what no limit means", () => {
    expect(shareHint("none")).toBe(
      "Runs until the plan's limit, then waits for the reset. Never on paid credits.",
    );
    expect(shareHint("10")).toBe(
      "Of each plan that shows limits. It stops there, never on paid credits.",
    );
    expect(shareHint("custom")).toBe(shareHint("10"));
  });
});
