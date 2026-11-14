// A theme from a description, the page's side (ADR 0134, rules 15 and 16): the one retry with what
// failed, and the line that says who makes the theme or what is missing.
import type { AppearanceInfo, ThemeAddAnswer, ThemeProblem } from "@matters/contracts";
import type { AgentStatus, ThemeInput } from "@matters/core";
import { DEFAULT_AGENT_SETTINGS, everyKindOn, patchAgentSettings } from "@matters/core";
import { describe, expect, it } from "vitest";
import { kindWaits } from "../src/renderer/agentText.ts";
import { makeTheme, type ThemeMakingDeps, themeMaker } from "../src/renderer/themeMaking.ts";

const appearance: AppearanceInfo = {
  mode: "system",
  fixedScheme: "dark",
  theme: "own-0123456789ab",
  themeChosen: true,
  themes: [],
  fallback: null,
};
const kept: ThemeAddAnswer = {
  ok: true,
  theme: { id: "own-0123456789ab", name: "Moss", source: "own", schemes: ["dark"], swatches: [] },
  appearance,
};
const contrast: ThemeProblem = {
  kind: "contrast",
  mode: "dark",
  ink: "ink",
  surface: "bg",
  ratio: 1.3,
  needed: 4.5,
  message: "In dark, the text (ink) on the ground (bg) is 1.30:1; it needs 4.5:1.",
};
const refused: ThemeAddAnswer = { ok: false, problems: [contrast] };

/** The backend's turns and main's check, scripted, with what each was asked. */
function rig(turns: (string | Error)[], checks: (ThemeAddAnswer | null)[]) {
  const asked: ThemeInput[] = [];
  const added: string[] = [];
  let stop = false;
  const deps: ThemeMakingDeps = {
    make: async (input) => {
      asked.push(input);
      const next = turns.shift();
      if (next === undefined) throw new Error("no turn scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    add: async (text) => {
      added.push(text);
      return checks.shift() ?? null;
    },
    stopped: () => stop,
  };
  return { deps, asked, added, stopAt: () => (stop = true) };
}

describe("the one retry (ADR 0134, rule 15)", () => {
  it("adds a theme main keeps on the first answer, and asks nothing more", async () => {
    const h = rig(["first"], [kept]);
    const made = await makeTheme(h.deps, { description: "moss" });
    expect(made).toEqual({ kind: "added", answer: kept, tries: 1 });
    expect(h.asked).toEqual([{ description: "moss" }]);
    expect(h.added).toEqual(["first"]);
  });

  it("asks once more with the answer and what failed, and adds the second when main keeps it", async () => {
    const h = rig(["bad", "good"], [refused, kept]);
    const made = await makeTheme(h.deps, { description: "moss", current: "{}" });
    expect(made).toMatchObject({ kind: "added", tries: 2 });
    expect(h.asked).toEqual([
      { description: "moss", current: "{}" },
      {
        description: "moss",
        current: "{}",
        retry: { previous: "bad", problems: [contrast.message] },
      },
    ]);
    expect(h.added).toEqual(["bad", "good"]);
  });

  it("shows the problems of the second answer when it is refused too, and asks no third time", async () => {
    const second: ThemeProblem = { ...contrast, ratio: 2.1, message: "Second." };
    const h = rig(["bad", "worse"], [refused, { ok: false, problems: [second] }]);
    expect(await makeTheme(h.deps, { description: "moss" })).toEqual({
      kind: "refused",
      problems: [second],
    });
    expect(h.asked).toHaveLength(2);
  });

  it("says the turn's sentence when it fails, and does not try again", async () => {
    const h = rig(
      [new Error("Plan runtime is not ready. Check it in Settings, then try again.")],
      [],
    );
    expect(await makeTheme(h.deps, { description: "moss" })).toEqual({
      kind: "failed",
      message: "Plan runtime is not ready. Check it in Settings, then try again.",
    });
    expect(h.asked).toHaveLength(1);
    expect(h.added).toEqual([]);
    // A retry that fails ends there too.
    const r = rig(
      ["bad", new Error("The assistant's answer was not a theme. Try again.")],
      [refused],
    );
    expect(await makeTheme(r.deps, { description: "moss" })).toMatchObject({ kind: "failed" });
    expect(r.added).toEqual(["bad"]);
  });

  it("says so when main cannot keep it", async () => {
    const h = rig(["first"], [null]);
    expect(await makeTheme(h.deps, { description: "moss" })).toMatchObject({ kind: "failed" });
  });

  it("adds nothing once stopped, whatever the turn gave", async () => {
    const h = rig(["first"], [kept]);
    const make = h.deps.make;
    h.deps.make = async (input) => {
      const text = await make(input);
      h.stopAt();
      return text;
    };
    expect(await makeTheme(h.deps, { description: "moss" })).toEqual({ kind: "stopped" });
    expect(h.added).toEqual([]);
    const e = rig([new Error("Stopped.")], []);
    e.stopAt();
    expect(await makeTheme(e.deps, { description: "moss" })).toEqual({ kind: "stopped" });
  });
});

const status = (over: Partial<AgentStatus["settings"]> = {}, info = {}): AgentStatus => {
  const settings = patchAgentSettings(DEFAULT_AGENT_SETTINGS, {
    enabled: true,
    kindRuntime: { ...everyKindOn("plan"), appearance: "local" },
    choices: { local: { models: { appearance: "qwen3:8b" } } },
  });
  return {
    settings: { ...settings, ...over },
    runtimes: [
      {
        id: "plan",
        name: "Claude Code",
        info: { id: "plan", name: "Claude Code", status: "ready", models: ["sonnet"] },
      },
      {
        id: "local",
        name: "Ollama",
        info: {
          id: "local",
          name: "Ollama",
          status: "ready",
          models: ["qwen3:8b"],
          onThisMachine: true,
          noPlan: true,
          ...info,
        },
      },
    ],
    unlisted: [],
    // Only the plan runtime has an account agreed to it.
    consents: [{ accountId: "acc1", runtimeId: "plan", grantedAtMs: 1 }],
    progress: { state: "idle" },
    ledger: [],
  };
};

describe("who makes the theme (ADR 0134, rule 16)", () => {
  it("names the runtime and model of the kind, with no account agreed to it", () => {
    expect(themeMaker(status())).toEqual({
      ready: true,
      by: "Made by Ollama, Qwen3:8b, on this Mac.",
    });
    // It waits on no account (rule 14), where a kind that takes mail would.
    expect(kindWaits(status(), "appearance")).toBe("");
    const mailOnLocal = status({ kindRuntime: { ...everyKindOn("plan"), write: "local" } });
    expect(kindWaits(mailOnLocal, "write")).toBe(
      "Waits: you have not let Ollama read any account yet.",
    );
  });

  it("is offered for a runtime not checked yet: the turn checks it first", () => {
    expect(themeMaker(status({}, { status: "found" })).ready).toBe(true);
  });

  it("says what is missing and where to fix it", () => {
    expect(themeMaker(null)).toEqual({ ready: false, why: "Looking at the agent…" });
    expect(themeMaker(status({ enabled: false }))).toEqual({
      ready: false,
      why: "AI is off. Turn it on in Settings › Agents to make a theme from words.",
    });
    expect(themeMaker(status({ kindRuntime: { understand: "plan" } }))).toEqual({
      ready: false,
      why: "Choose who makes themes in Settings › Agents.",
    });
    expect(themeMaker(status({}, { status: "notRunning" }))).toMatchObject({ ready: false });
    expect((themeMaker(status({}, { status: "notRunning" })) as { why: string }).why).toMatch(
      /^Ollama is .+\. Check it in Settings › Agents\.$/,
    );
    expect(themeMaker({ ...status(), unlisted: ["appearance"] })).toEqual({
      ready: false,
      why: "qwen3:8b is not available on Ollama now. Choose another model for appearance in Settings › Agents.",
    });
  });
});
