import { describe, expect, it } from "vitest";
import {
  AGENT_EFFORTS,
  type AgentEffort,
  DEFAULT_AGENT_EFFORTS,
  DEFAULT_AGENT_SETTINGS,
  effortFor,
  isAgentEffortSetting,
  readEfforts,
  resolveEffort,
  withEffort,
} from "../src/index.ts";

// ADR 0118: effort is set per kind of work.

const ALL: readonly AgentEffort[] = AGENT_EFFORTS;

describe("the levels (rule 2)", () => {
  it("are five, lowest first, and `default` is a setting but not a level", () => {
    expect(AGENT_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const value of ["default", ...AGENT_EFFORTS])
      expect(isAgentEffortSetting(value)).toBe(true);
    for (const value of ["", "LOW", "ultra", 1, null, undefined]) {
      expect(isAgentEffortSetting(value)).toBe(false);
    }
  });
});

describe("resolveEffort (rules 2 and 4)", () => {
  it("sends nothing for the default", () => {
    expect(resolveEffort("default", ALL)).toBeUndefined();
    expect(resolveEffort(undefined, ALL)).toBeUndefined();
  });

  it("sends a level the runtime lists", () => {
    for (const level of AGENT_EFFORTS) expect(resolveEffort(level, ALL)).toBe(level);
    expect(resolveEffort("medium", ["low", "medium"])).toBe("medium");
  });

  it("sends nothing for a level the runtime does not list, or when it lists none", () => {
    expect(resolveEffort("max", ["low", "medium", "high"])).toBeUndefined();
    expect(resolveEffort("low", [])).toBeUndefined();
    expect(resolveEffort("low", undefined)).toBeUndefined();
  });
});

describe("effortFor (rule 1)", () => {
  const settings = {
    efforts: {
      understand: "medium",
      write: "default",
      answer: "max",
      titles: "low",
      appearance: "high",
    },
  } as const;

  it("takes the setting of the kind of work", () => {
    expect(effortFor("understand", settings, ALL)).toBe("medium");
    expect(effortFor("write", settings, ALL)).toBeUndefined();
    expect(effortFor("answer", settings, ALL)).toBe("max");
    expect(effortFor("titles", settings, ALL)).toBe("low");
    expect(effortFor("appearance", settings, ALL)).toBe("high");
  });

  it("holds the runtime's list to each of them", () => {
    expect(effortFor("answer", settings, ["low", "medium", "high"])).toBeUndefined();
    expect(effortFor("understand", settings, [])).toBeUndefined();
  });

  it("starts at low for mail and titles, the default for writing and questions (rule 3)", () => {
    expect(DEFAULT_AGENT_SETTINGS.efforts).toEqual(DEFAULT_AGENT_EFFORTS);
    expect(effortFor("understand", DEFAULT_AGENT_SETTINGS, ALL)).toBe("low");
    expect(effortFor("titles", DEFAULT_AGENT_SETTINGS, ALL)).toBe("low");
    expect(effortFor("write", DEFAULT_AGENT_SETTINGS, ALL)).toBeUndefined();
    expect(effortFor("answer", DEFAULT_AGENT_SETTINGS, ALL)).toBeUndefined();
    // Making a theme starts at the default (ADR 0134, rule 13).
    expect(effortFor("appearance", DEFAULT_AGENT_SETTINGS, ALL)).toBeUndefined();
    expect(DEFAULT_AGENT_EFFORTS.appearance).toBe("default");
  });
});

describe("readEfforts (rule 8)", () => {
  it("reads nothing stored as the starting values", () => {
    for (const raw of [undefined, null, "high", 3, []]) {
      expect(readEfforts(raw)).toEqual(DEFAULT_AGENT_EFFORTS);
    }
  });

  it("keeps each known value and gives each unknown or missing kind its start", () => {
    expect(
      readEfforts({ understand: "xhigh", write: "LOW", titles: "default", other: "max" }),
    ).toEqual({
      understand: "xhigh",
      write: "default",
      answer: "default",
      titles: "default",
      appearance: "default",
    });
    expect(readEfforts({ answer: "high" })).toEqual({ ...DEFAULT_AGENT_EFFORTS, answer: "high" });
  });
});

describe("withEffort", () => {
  it("is the field when there is an effort and nothing when there is none", () => {
    expect(withEffort("high")).toEqual({ effort: "high" });
    expect(withEffort(undefined)).toEqual({});
    expect("effort" in withEffort(undefined)).toBe(false);
  });
});
