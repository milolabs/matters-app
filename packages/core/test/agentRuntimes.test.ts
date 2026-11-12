import { describe, expect, it } from "vitest";
import {
  AgentRunError,
  buildPreparedRequest,
  buildPromptRequest,
  DEFAULT_AGENT_EFFORTS,
  DEFAULT_AGENT_MODELS,
  DEFAULT_AGENT_SETTINGS,
  effortFor,
  inputCharsFor,
  isAgentRunError,
  LEGACY_RUNTIME_ID,
  levelsFor,
  MAX_PARALLEL_TURNS,
  MAX_PROMPT_BATCH_CHARS,
  mayRun,
  mayRunOn,
  modelUsesTools,
  patchAgentSettings,
  promptBatchChars,
  readAgentSettings,
  renderThread,
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
});

describe("settings read back in both shapes (rule 4)", () => {
  const flat = {
    enabled: true,
    runtimeId: "claude-code",
    models: { understand: "sonnet", write: "opus", answer: "sonnet", titles: "off" },
    efforts: { understand: "medium", write: "max", answer: "default", titles: "low" },
    weekSharePercent: 25,
    usedByUsPercent: 3,
  };

  it("reads flat models and efforts from before as the choices of the runtime they name", () => {
    const s = readAgentSettings(flat);
    expect(s.models).toEqual(flat.models);
    expect(s.efforts).toEqual(flat.efforts);
    expect(s.choices).toEqual({ "claude-code": { models: flat.models, efforts: flat.efforts } });
    expect(s).toMatchObject({ enabled: true, runtimeId: "claude-code", weekSharePercent: 25 });
  });

  it("reads them as Claude Code's when no runtime was chosen, and chooses none", () => {
    const { runtimeId: _r, ...none } = flat;
    const s = readAgentSettings(none);
    expect(s.runtimeId).toBeUndefined();
    expect(s.choices?.[LEGACY_RUNTIME_ID]?.models).toEqual(flat.models);
  });

  it("reads choices per runtime, and the chosen runtime's as models and efforts", () => {
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
    expect(s.models.understand).toBe("qwen3:8b");
    expect(s.efforts.understand).toBe("default");
    expect(s.choices?.["claude-code"]?.models.write).toBe("opus");
  });

  it("defends against values a build does not know", () => {
    const s = readAgentSettings({
      runtimeId: 5,
      choices: { "": { models: {} }, x: "no", ollama: { models: { write: 3 }, efforts: "high" } },
    });
    expect(s.runtimeId).toBeUndefined();
    expect(Object.keys(s.choices ?? {})).toEqual(["ollama"]);
    expect(s.choices?.ollama).toEqual({
      models: DEFAULT_AGENT_MODELS,
      efforts: DEFAULT_AGENT_EFFORTS,
    });
    expect(readAgentSettings(null)).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(readAgentSettings([1])).toEqual(DEFAULT_AGENT_SETTINGS);
  });

  it("writes models and efforts to the runtime the patch names, and reads another's back", () => {
    let s = readAgentSettings(flat);
    s = patchAgentSettings(s, {
      runtimeId: "ollama",
      models: { understand: "q", write: "q", answer: "q", titles: "q" },
    });
    expect(s.models.write).toBe("q");
    expect(s.efforts).toEqual(DEFAULT_AGENT_EFFORTS);
    s = patchAgentSettings(s, { runtimeId: "claude-code" });
    expect(s.models).toEqual(flat.models);
    expect(s.efforts).toEqual(flat.efforts);
    s = patchAgentSettings(s, { limits: { usingOverage: false, seenAtMs: 1 } });
    s = patchAgentSettings(s, { limits: null });
    expect("limits" in s).toBe(false);
    // What is written reads back the same.
    expect(readAgentSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
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
    });
    expect(startingChoices({ models: local, defaultModel: "gone" })?.models.write).toBe("qwen3:8b");
    expect(startingChoices({ models: [] })).toBeNull();
  });

  it("names the kinds whose model is not listed; titles off is not a model", () => {
    const models = { understand: "qwen3:8b", write: "gone", answer: "qwen3:8b", titles: "off" };
    expect(unlistedKinds({ models }, { models: local })).toEqual(["write"]);
    expect(unlistedKinds({ models }, null)).toEqual([]);
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

describe("a runtime on a plan that reports no windows (ADR 0120, rule 9)", () => {
  const budget = { weekSharePercent: 10, usedByUsPercent: 50 };
  const full = {
    session: { usedPercent: 100, resetsAtMs: NOW + 1000 },
    week: { usedPercent: 100, resetsAtMs: NOW + 1000 },
    usingOverage: true,
    seenAtMs: NOW,
  };

  it("passes the gates of the windows at every priority, and runs one turn at a time", () => {
    for (const p of ["P0", "P1", "P2", "P3"] as const) {
      expect(mayRunOn({ noWindows: true }, p, full, budget, NOW)).toEqual({ ok: true });
      expect(mayRunOn({ noWindows: true }, p, undefined, budget, NOW)).toEqual({ ok: true });
    }
    expect(turnsAtOnce({ noWindows: true, turnsAtOnce: 4 })).toBe(1);
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
      models: { understand: "small", write: "big", answer: "big", titles: "small" },
      efforts: DEFAULT_AGENT_EFFORTS,
    });
  });
});
