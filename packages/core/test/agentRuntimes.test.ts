import { describe, expect, it } from "vitest";
import type { AgentRuntimeInfo } from "../src/index.ts";
import {
  AGENT_WORK_KINDS,
  AgentRunError,
  buildPreparedRequest,
  buildPromptRequest,
  DEFAULT_AGENT_EFFORTS,
  DEFAULT_AGENT_MODELS,
  DEFAULT_AGENT_SETTINGS,
  effortFor,
  everyKindOn,
  inputCharsFor,
  isAgentRunError,
  kindsOn,
  kindTakesMail,
  LEGACY_RUNTIME_ID,
  levelsFor,
  MAX_PARALLEL_TURNS,
  MAX_PROMPT_BATCH_CHARS,
  mailRuntimesInUse,
  mayRun,
  mayRunOn,
  modelUsesTools,
  patchAgentSettings,
  promptBatchChars,
  readAgentSettings,
  renderThread,
  runtimesInUse,
  startingChoices,
  threadRoom,
  turnsAtOnce,
  unlistedKinds,
  WHOLE_MEDIA_TYPES,
  wholeTypesFor,
} from "../src/index.ts";

// ADR 0119: a runtime on this machine. Choices per runtime, levels per model, and a runtime with
// no plan.

const NOW = Date.UTC(2026, 10, 12, 12);
const local = ["qwen3:8b", "llama3.2:3b"];

describe("levelsFor (rule 9)", () => {
  it("gives a model its own levels, none for a model not named, else the runtime's", () => {
    const perModel = {
      efforts: ["low", "high"] as const,
      modelEfforts: { "qwen3:8b": [], "gpt-oss:20b": ["low", "medium", "high"] as const },
    };
    expect(levelsFor(perModel, "gpt-oss:20b")).toEqual(["low", "medium", "high"]);
    expect(levelsFor(perModel, "qwen3:8b")).toEqual([]);
    expect(levelsFor(perModel, "unknown")).toEqual([]);
    expect(levelsFor(perModel, "toString")).toEqual([]);
    expect(levelsFor({ efforts: ["low", "max"] }, "sonnet")).toEqual(["low", "max"]);
    expect(levelsFor(null, "x")).toBeUndefined();
  });

  it("decides the effort a kind sends from the levels of its model", () => {
    const s = { efforts: { ...DEFAULT_AGENT_EFFORTS, write: "high" as const } };
    const info = { modelEfforts: { a: ["low", "high"] as const, b: [] } };
    expect(effortFor("write", s, levelsFor(info, "a"))).toBe("high");
    expect(effortFor("write", s, levelsFor(info, "b"))).toBeUndefined();
    expect(effortFor("understand", s, levelsFor(info, "a"))).toBe("low");
  });
});

describe("mayRunOn and turnsAtOnce (rule 7)", () => {
  const budget = { weekSharePercent: 10, usedByUsPercent: 50 };
  const full = {
    session: { usedPercent: 100, resetsAtMs: NOW + 1000 },
    week: { usedPercent: 100, resetsAtMs: NOW + 1000 },
    usingOverage: true,
    seenAtMs: NOW,
  };

  it("always passes for a runtime with no plan, at every priority", () => {
    for (const p of ["P0", "P1", "P2", "P3"] as const) {
      expect(mayRunOn({ noPlan: true }, p, full, budget, NOW)).toEqual({ ok: true });
      expect(mayRunOn({ noPlan: true }, p, undefined, budget, NOW)).toEqual({ ok: true });
    }
  });

  it("is mayRun, unchanged, for a runtime with a plan", () => {
    for (const p of ["P0", "P1", "P2", "P3"] as const) {
      for (const limits of [full, undefined]) {
        expect(mayRunOn({}, p, limits, budget, NOW)).toEqual(mayRun(p, limits, budget, NOW));
        expect(mayRunOn(null, p, limits, budget, NOW)).toEqual(mayRun(p, limits, budget, NOW));
      }
    }
    expect(mayRunOn({}, "P3", undefined, budget, NOW).ok).toBe(false);
  });

  it("runs one turn at a time with no plan, else what the runtime takes, at most the app's", () => {
    expect(turnsAtOnce({ noPlan: true })).toBe(1);
    expect(turnsAtOnce({ noPlan: true, turnsAtOnce: 3 })).toBe(1);
    expect(turnsAtOnce(null)).toBe(MAX_PARALLEL_TURNS);
    expect(turnsAtOnce({})).toBe(MAX_PARALLEL_TURNS);
    expect(turnsAtOnce({ turnsAtOnce: 2 })).toBe(2);
    expect(turnsAtOnce({ turnsAtOnce: 99 })).toBe(MAX_PARALLEL_TURNS);
    expect(turnsAtOnce({ turnsAtOnce: 0 })).toBe(1);
    expect(turnsAtOnce({ turnsAtOnce: Number.NaN })).toBe(MAX_PARALLEL_TURNS);
  });

  it("is each runtime's own, so one with no plan does not hold back one on a plan (ADR 0121, rule 7)", () => {
    const local = { noPlan: true, turnsAtOnce: 4 };
    const plan = { turnsAtOnce: 3 };
    expect([local, plan].map((r) => turnsAtOnce(r))).toEqual([1, 3]);
  });
});

describe("settings read back in every shape (ADR 0119, rule 4; ADR 0121, rule 12)", () => {
  const flat = {
    enabled: true,
    runtimeId: "claude-code",
    models: { understand: "sonnet", write: "opus", answer: "sonnet", titles: "off" },
    efforts: { understand: "medium", write: "max", answer: "default", titles: "low" },
    weekSharePercent: 25,
    usedByUsPercent: 3,
  };
  const all = (id: string) => ({
    understand: id,
    write: id,
    answer: id,
    titles: id,
    appearance: id,
  });
  // What settings from before read as: making a theme starts on writing's model and runtime, at
  // the default effort (ADR 0134, rule 13).
  const readModels = { ...flat.models, appearance: flat.models.write };
  const readEffortsOf = { ...flat.efforts, appearance: "default" };

  it("reads flat models and efforts from before as the choices of the runtime they name", () => {
    const s = readAgentSettings(flat);
    expect(s.models).toEqual(readModels);
    expect(s.efforts).toEqual(readEffortsOf);
    expect(s.choices).toEqual({ "claude-code": { models: readModels, efforts: readEffortsOf } });
    expect(s).toMatchObject({
      enabled: true,
      kindRuntime: all("claude-code"),
      weekSharePercent: 25,
    });
    expect("runtimeId" in s).toBe(false);
  });

  it("reads them as Claude Code's when no runtime was chosen, and puts no kind anywhere", () => {
    const { runtimeId: _r, ...none } = flat;
    const s = readAgentSettings(none);
    expect(s.kindRuntime).toEqual({});
    expect(s.choices?.[LEGACY_RUNTIME_ID]?.models).toEqual(readModels);
  });

  it("reads one chosen runtime as every kind on it, with its own choices", () => {
    const stored = {
      ...flat,
      runtimeId: "ollama",
      choices: {
        "claude-code": { models: flat.models, efforts: flat.efforts },
        ollama: {
          models: { understand: "qwen3:8b", write: "qwen3:8b", answer: "qwen3:8b", titles: "off" },
          efforts: {
            understand: "default",
            write: "default",
            answer: "default",
            titles: "default",
          },
        },
      },
    };
    const s = readAgentSettings(stored);
    expect(s.kindRuntime).toEqual(all("ollama"));
    expect(s.models.understand).toBe("qwen3:8b");
    expect(s.efforts.understand).toBe("default");
    expect(s.choices?.["claude-code"]?.models.write).toBe("opus");
  });

  it("reads the stored windows and our use as the chosen runtime's plan (ADR 0121, rule 6)", () => {
    const limits = { week: { usedPercent: 40, resetsAtMs: 9 }, usingOverage: false, seenAtMs: 5 };
    const s = readAgentSettings({ ...flat, runtimeId: "codex", limits, usedWeekResetsAtMs: 9 });
    expect(s.plans).toEqual({ codex: { limits, usedByUsPercent: 3, usedWeekResetsAtMs: 9 } });
    expect("limits" in s || "usedByUsPercent" in s || "usedWeekResetsAtMs" in s).toBe(false);
    // Settings with nothing used and nothing seen keep no plan.
    expect(readAgentSettings({ ...flat, usedByUsPercent: 0 }).plans).toEqual({});
  });

  it("reads a runtime per kind, each kind's model from its runtime's choices", () => {
    const s = readAgentSettings({
      enabled: true,
      kindRuntime: { understand: "ollama", write: "claude-code", answer: "codex", bogus: "x" },
      choices: {
        ollama: { models: { ...all("q"), titles: "off" } },
        "claude-code": { models: flat.models, efforts: flat.efforts },
      },
      plans: { codex: { usedByUsPercent: 2 }, "": { usedByUsPercent: 9 } },
    });
    // Stored before making themes was a kind: it starts where writing is (ADR 0134, rule 13).
    expect(s.kindRuntime).toEqual({
      understand: "ollama",
      write: "claude-code",
      answer: "codex",
      appearance: "claude-code",
    });
    expect(s.models).toEqual({
      understand: "q",
      write: "opus",
      // Codex keeps nothing yet: the start, until the service gives it its own.
      answer: DEFAULT_AGENT_MODELS.answer,
      titles: DEFAULT_AGENT_MODELS.titles,
      appearance: "opus",
    });
    expect(s.efforts.write).toBe("max");
    expect(s.plans).toEqual({ codex: { usedByUsPercent: 2 } });
  });

  it("defends against values a build does not know", () => {
    const s = readAgentSettings({
      runtimeId: 5,
      kindRuntime: { understand: 3, write: "" },
      choices: { "": { models: {} }, x: "no", ollama: { models: { write: 3 }, efforts: "high" } },
      plans: "no",
    });
    expect(s.kindRuntime).toEqual({});
    expect(Object.keys(s.choices ?? {})).toEqual(["ollama"]);
    expect(s.choices?.ollama).toEqual({
      models: DEFAULT_AGENT_MODELS,
      efforts: DEFAULT_AGENT_EFFORTS,
    });
    expect(s.plans).toEqual({});
    expect(readAgentSettings(null)).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(readAgentSettings([1])).toEqual(DEFAULT_AGENT_SETTINGS);
  });

  it("moves a kind and keeps what every runtime holds; nothing is cleared (ADR 0121, rules 5, 6)", () => {
    let s = readAgentSettings({
      ...flat,
      limits: { usingOverage: false, seenAtMs: 1 },
    });
    s = patchAgentSettings(s, {
      kindRuntime: { understand: "ollama" },
      choices: { ollama: { models: all("q") } },
    });
    expect(s.models).toEqual({ ...readModels, understand: "q" });
    expect(s.efforts.understand).toBe(DEFAULT_AGENT_EFFORTS.understand);
    expect(s.plans?.["claude-code"]?.limits).toEqual({ usingOverage: false, seenAtMs: 1 });
    s = patchAgentSettings(s, { kindRuntime: { understand: "claude-code" } });
    expect(s.models).toEqual(readModels);
    expect(s.efforts).toEqual(readEffortsOf);
    s = patchAgentSettings(s, { plan: { runtimeId: "ollama", usedByUsPercent: 0 } });
    s = patchAgentSettings(s, { plan: { runtimeId: "claude-code", limits: null } });
    expect("limits" in (s.plans?.["claude-code"] ?? {})).toBe(false);
    expect(s.choices?.ollama?.models).toEqual(all("q"));
    // What is written reads back the same.
    expect(readAgentSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("names the runtimes in use once each, in the order of the kinds", () => {
    const s = patchAgentSettings(DEFAULT_AGENT_SETTINGS, {
      kindRuntime: { understand: "ollama", write: "codex", answer: "ollama" },
    });
    expect(runtimesInUse(s)).toEqual(["ollama", "codex"]);
    expect(kindsOn(s, "ollama")).toEqual(["understand", "answer"]);
    expect(runtimesInUse(DEFAULT_AGENT_SETTINGS)).toEqual([]);
  });
});

describe("startingChoices and unlistedKinds (rule 4)", () => {
  it("keeps the app's own models for a runtime that lists them all", () => {
    expect(startingChoices({ models: ["haiku", "sonnet", "opus"] })).toEqual({
      models: DEFAULT_AGENT_MODELS,
      efforts: DEFAULT_AGENT_EFFORTS,
    });
  });

  it("starts every kind on the runtime's default, else its first model; none with no model", () => {
    expect(startingChoices({ models: local, defaultModel: "qwen3:8b" })?.models).toEqual({
      understand: "qwen3:8b",
      write: "qwen3:8b",
      answer: "qwen3:8b",
      titles: "qwen3:8b",
      appearance: "qwen3:8b",
    });
    expect(startingChoices({ models: local, defaultModel: "gone" })?.models.write).toBe("qwen3:8b");
    expect(startingChoices({ models: [] })).toBeNull();
  });

  it("names the kinds whose model their runtime does not list; titles off is not a model", () => {
    const models = {
      understand: "qwen3:8b",
      write: "gone",
      answer: "qwen3:8b",
      titles: "off",
      appearance: "qwen3:8b",
    };
    const kindRuntime = { understand: "ollama", write: "ollama", answer: "plan", titles: "ollama" };
    const infos: Record<string, { models: readonly string[] }> = {
      ollama: { models: local },
      plan: { models: ["sonnet"] },
    };
    expect(unlistedKinds({ models, kindRuntime }, (id) => infos[id])).toEqual(["write", "answer"]);
    expect(unlistedKinds({ models, kindRuntime }, () => null)).toEqual([]);
    expect(unlistedKinds({ models, kindRuntime: {} }, (id) => infos[id])).toEqual([]);
  });
});

describe("tooLong (rule 8)", () => {
  it("is a run error a caller can act on", () => {
    expect(isAgentRunError(new AgentRunError("tooLong", "Too long for qwen3:8b."))).toBe(true);
  });
});

describe("batches sized to the model (rule 8)", () => {
  const thread = (n: number, chars: number) => ({
    thread: {
      subject: `Thread ${n}`,
      messages: [
        {
          key: n,
          dateMs: NOW - n * 60_000,
          from: { name: "Robin", address: "robin@example.org" },
          fromOwn: false,
          text: `Please decide by Friday.\n${"x".repeat(chars)}`,
        },
      ],
    },
    signals: { unread: true, starred: false, answered: false, messages: 1 },
  });

  it("keeps today's batch without a size, and makes smaller ones on a model that takes less", () => {
    const ten = Array.from({ length: 10 }, (_, i) => thread(i + 1, 3000));
    expect(buildPromptRequest(ten, "decide", NOW).sent).toHaveLength(10);
    expect(promptBatchChars(undefined)).toBe(MAX_PROMPT_BATCH_CHARS);
    const small = buildPromptRequest(ten, "decide", NOW, 12_000);
    expect(small.sent.length).toBeGreaterThan(0);
    expect(small.sent.length).toBeLessThan(10);
    expect(small.request.untrusted.length).toBeLessThanOrEqual(12_000);
  });

  it("clips one thread too long for the model to fit, and never leaves it out", () => {
    const long = [thread(1, 50_000)];
    const { request, sent } = buildPromptRequest(long, "decide", NOW, 8000);
    expect(sent).toEqual([0]);
    expect(request.untrusted.length).toBeLessThanOrEqual(8000);
    expect(request.untrusted).toContain("Please decide by Friday.");
    expect(request.untrusted).toContain("[... clipped:");
  });

  it("clips the thread of a one-thread turn to its room", () => {
    const one = thread(1, 7000).thread;
    const room = 3000;
    const body = buildPreparedRequest(one, NOW, undefined, undefined, room);
    expect(body.untrusted.length).toBeLessThanOrEqual(room);
    expect(buildPreparedRequest(one, NOW).untrusted.length).toBeGreaterThan(7000);
    expect(renderThread(one, NOW, room, true).length).toBeLessThanOrEqual(room);
  });

  it("reads what a model takes from the runtime, and nothing when it says nothing", () => {
    expect(inputCharsFor({ modelInputChars: { a: 9000.7 } }, "a")).toBe(9000);
    expect(inputCharsFor({ modelInputChars: { a: 9000 } }, "b")).toBeUndefined();
    expect(inputCharsFor({}, "a")).toBeUndefined();
    expect(threadRoom(undefined, 100)).toBeUndefined();
    expect(threadRoom(500, 1000)).toBe(0);
  });
});

describe("attachments where the model can (rule 10)", () => {
  it("says which models may use tools", () => {
    expect(modelUsesTools({ tools: true }, "any")).toBe(true);
    expect(modelUsesTools({ tools: true, toolModels: ["qwen3:8b"] }, "qwen3:8b")).toBe(true);
    expect(modelUsesTools({ tools: true, toolModels: ["qwen3:8b"] }, "coder")).toBe(false);
    expect(modelUsesTools({ toolModels: ["qwen3:8b"] }, "qwen3:8b")).toBe(false);
    expect(modelUsesTools(null, "x")).toBe(false);
  });

  it("says what each model takes whole", () => {
    expect(wholeTypesFor(undefined, true, "sonnet")).toEqual(WHOLE_MEDIA_TYPES);
    expect(wholeTypesFor(undefined, false, "sonnet")).toEqual([]);
    const local = { modelFiles: { seeing: ["image/png" as const], blind: [] } };
    expect(wholeTypesFor(local, true, "seeing")).toEqual(["image/png"]);
    expect(wholeTypesFor(local, true, "blind")).toEqual([]);
    expect(wholeTypesFor(local, true, "other")).toEqual([]);
  });
});

describe("a runtime whose windows are read apart from turns (ADR 0120, rule 9)", () => {
  const budget = { weekSharePercent: 10, usedByUsPercent: 50 };
  const full = {
    session: { usedPercent: 100, resetsAtMs: NOW + 1000 },
    week: { usedPercent: 100, resetsAtMs: NOW + 1000 },
    usingOverage: true,
    seenAtMs: NOW,
  };

  it("is held to the gates of the windows as any runtime with a plan, and runs turns side by side", () => {
    const codex: AgentRuntimeInfo = {
      id: "codex",
      name: "Codex",
      status: "ready",
      models: [],
      pausesOnLimit: true,
    };
    for (const p of ["P0", "P1", "P2", "P3"] as const) {
      expect(mayRunOn(codex, p, full, budget, NOW)).toEqual(mayRun(p, full, budget, NOW));
      expect(mayRunOn(codex, p, undefined, budget, NOW)).toEqual(mayRun(p, undefined, budget, NOW));
    }
    expect(mayRunOn(codex, "P0", full, budget, NOW).ok).toBe(false);
    expect(turnsAtOnce(codex)).toBe(MAX_PARALLEL_TURNS);
  });

  it("carries the time a limit lifts on the error, when the runtime said it", () => {
    expect(new AgentRunError("limit", "x", NOW).untilMs).toBe(NOW);
    expect(new AgentRunError("limit", "x").untilMs).toBeUndefined();
    expect(new AgentRunError("limit", "x", Number.NaN).untilMs).toBeUndefined();
  });
});

describe("starting choices per kind of work (ADR 0120)", () => {
  it("starts each kind on the model the runtime suggests for it, when it lists it", () => {
    expect(
      startingChoices({
        models: ["big", "small"],
        defaultModel: "big",
        defaultModels: { understand: "small", titles: "small", write: "gone" },
      }),
    ).toEqual({
      models: {
        understand: "small",
        write: "big",
        answer: "big",
        titles: "small",
        // Nothing suggested for it: where writing starts (ADR 0134, rule 13).
        appearance: "big",
      },
      efforts: DEFAULT_AGENT_EFFORTS,
    });
    expect(
      startingChoices({
        models: ["big", "small", "mid"],
        defaultModel: "big",
        defaultModels: { write: "small", appearance: "mid" },
      })?.models.appearance,
    ).toBe("mid");
    expect(
      startingChoices({ models: ["big", "small"], defaultModels: { write: "small" } })?.models
        .appearance,
    ).toBe("small");
  });
});

describe("making themes is a kind of work (ADR 0134, rules 13 and 14)", () => {
  it("is listed fifth, after the four kinds before it, and takes no mail", () => {
    expect(AGENT_WORK_KINDS).toEqual(["understand", "write", "answer", "titles", "appearance"]);
    expect(AGENT_WORK_KINDS.filter((k) => !kindTakesMail(k))).toEqual(["appearance"]);
    expect(DEFAULT_AGENT_MODELS.appearance).toBe(DEFAULT_AGENT_MODELS.write);
    expect(DEFAULT_AGENT_EFFORTS.appearance).toBe("default");
    expect(everyKindOn("x")).toEqual({
      understand: "x",
      write: "x",
      answer: "x",
      titles: "x",
      appearance: "x",
    });
  });

  it("reads settings stored before it as the kind on writing's runtime and model, losing nothing", () => {
    // As written by the build before this kind: a runtime per kind, choices for two runtimes.
    const before = {
      enabled: true,
      kindRuntime: { understand: "ollama", write: "codex", answer: "codex", titles: "ollama" },
      choices: {
        ollama: {
          models: { understand: "q", write: "q", answer: "q", titles: "off" },
          efforts: { understand: "low", write: "default", answer: "default", titles: "low" },
        },
        codex: {
          models: { understand: "luna", write: "sol", answer: "sol", titles: "luna" },
          efforts: { understand: "low", write: "high", answer: "medium", titles: "low" },
        },
      },
      weekSharePercent: 25,
      plans: { codex: { usedByUsPercent: 3 } },
      readingPaused: true,
    };
    const s = readAgentSettings(before);
    expect(s.kindRuntime).toEqual({ ...before.kindRuntime, appearance: "codex" });
    expect(s.models).toEqual({
      understand: "q",
      write: "sol",
      answer: "sol",
      titles: "off",
      appearance: "sol",
    });
    expect(s.efforts).toEqual({
      understand: "low",
      write: "high",
      answer: "medium",
      titles: "low",
      appearance: "default",
    });
    // Each runtime keeps what it held, and gains the kind on its own writing model.
    expect(s.choices?.ollama?.models).toEqual({ ...before.choices.ollama.models, appearance: "q" });
    expect(s.choices?.codex?.efforts).toEqual({
      ...before.choices.codex.efforts,
      appearance: "default",
    });
    expect(s).toMatchObject({ enabled: true, weekSharePercent: 25, readingPaused: true });
    expect(s.plans).toEqual({ codex: { usedByUsPercent: 3 } });
    // Once written, it reads back the same, and the kind can then move on its own.
    expect(readAgentSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
    const moved = patchAgentSettings(s, { kindRuntime: { appearance: "ollama" } });
    expect(moved.kindRuntime.write).toBe("codex");
    expect(moved.models.appearance).toBe("q");
    expect(readAgentSettings(JSON.parse(JSON.stringify(moved))).kindRuntime.appearance).toBe(
      "ollama",
    );
  });

  it("is not put anywhere when writing is on no runtime", () => {
    const s = readAgentSettings({ kindRuntime: { understand: "ollama" } });
    expect(s.kindRuntime).toEqual({ understand: "ollama" });
  });

  it("names a runtime in use for it only among the runtimes in use, not those mail goes to", () => {
    const s = patchAgentSettings(DEFAULT_AGENT_SETTINGS, {
      kindRuntime: { ...everyKindOn("plan"), appearance: "local" },
    });
    expect(runtimesInUse(s)).toEqual(["plan", "local"]);
    expect(mailRuntimesInUse(s)).toEqual(["plan"]);
    expect(kindsOn(s, "local")).toEqual(["appearance"]);
  });
});
