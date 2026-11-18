import type { AgentRuntimeInfo } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  answeredByLine,
  billedLine,
  consentText,
  readingWaitActs,
  readingWaitText,
  statusWords,
  writtenByLine,
} from "../src/renderer/agentText.ts";

// ADR 0141, rules 5 and 6: the states of a runtime on the person's own key, and money said plainly.

const keyed = (over: Partial<AgentRuntimeInfo> = {}): AgentRuntimeInfo => ({
  id: "anthropic-api",
  name: "Anthropic API",
  status: "found",
  models: ["claude-opus-5-5"],
  noPlan: true,
  billed: true,
  ...over,
});

describe("a runtime on the person's own key, in words", () => {
  it("names each state", () => {
    expect(statusWords(keyed({ status: "noKey", models: [] }))).toBe("No API key yet");
    expect(statusWords(keyed())).toBe("Key saved · not checked yet");
    expect(statusWords(keyed({ status: "keyRefused" }))).toBe("The key was refused");
    expect(statusWords(keyed({ status: "ready" }))).toBe("Ready · key saved");
  });

  it("says in one sentence who bills each turn, and the consent question says it too", () => {
    expect(billedLine(keyed())).toBe("Every turn is billed by Anthropic to your API key.");
    const consent = consentText(keyed());
    expect(consent).toContain("Mail goes to Anthropic");
    expect(consent).toContain("Every turn is billed by Anthropic to your API key.");
    expect(consent).toContain("once you let it read in the background");
  });

  it("says an answer came on the key, not a plan", () => {
    expect(answeredByLine("Anthropic API", "claude-opus-5-5")).toBe(
      "Anthropic API, Claude-opus-5-5, your API key",
    );
    expect(
      writtenByLine(keyed(), {
        understand: "claude-haiku-5-5",
        write: "claude-opus-5-5",
        answer: "claude-opus-5-5",
        titles: "claude-haiku-5-5",
        appearance: "claude-opus-5-5",
      }),
    ).toBe("Anthropic API, Claude-opus-5-5, your API key");
  });

  it("says why nothing reads in the background, and that it is the person's to change", () => {
    expect(readingWaitText({ kind: "keyOff" }, "Anthropic API", 0)).toBe(
      "Waits: reading in the background on Anthropic API is off",
    );
    expect(readingWaitActs({ kind: "keyOff" })).toBe(true);
  });
});
