import type { AgentRunRequest, AgentRuntimePort } from "@matters/core";
import { isAgentRunError } from "@matters/core";
import { beforeEach, describe, expect, it } from "vitest";

/** What the shared suite of a runtime needs: a fresh runtime, and what its stand-in answers. */
export interface AgentRuntimeContractSetup {
  /** A runtime pointed at its stand-in. */
  readonly make: () => AgentRuntimePort;
  /** Called before each case, after the stand-in is fresh: what it answers to a look. */
  readonly prepare?: () => void | Promise<void>;
  /** A model name the runtime does not list. */
  readonly unknownModel: string;
}

const REQUEST: Omit<AgentRunRequest, "model"> = {
  instructions: "Answer in the schema.",
  untrusted: "A made-up message.",
  schema: { type: "object", properties: { ok: { type: "boolean" } } },
};

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/**
 * What every runtime of the agent keeps to, whatever it speaks (ADR 0051, rule 1; ADR 0119; ADR
 * 0141): its id and name hold; looking says what it is under the same id and never rejects; a turn
 * fails only with `AgentRunError`, for a model it does not list, for a Stop before it started, and
 * for a tool server that is not ours.
 */
export function describeAgentRuntimeContract(name: string, setup: AgentRuntimeContractSetup) {
  describe(`${name} (AgentRuntimePort contract)`, () => {
    beforeEach(async () => {
      await setup.prepare?.();
    });

    it("has a stable id and name, and looking says the same", async () => {
      const runtime = setup.make();
      expect(runtime.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(runtime.name.length).toBeGreaterThan(0);
      const info = await runtime.inspect();
      expect(info.id).toBe(runtime.id);
      expect(info.name).toBe(runtime.name);
      expect(Array.isArray(info.models)).toBe(true);
      if (info.status !== "found" && info.status !== "ready") {
        expect(typeof info.problem).toBe("string");
      }
    });

    it("refuses a model it does not list, with AgentRunError", async () => {
      const error = await rejection(setup.make().run({ ...REQUEST, model: setup.unknownModel }));
      expect(isAgentRunError(error)).toBe(true);
    });

    it("a turn stopped before it started fails with AgentRunError", async () => {
      const stop = new AbortController();
      stop.abort();
      const info = await setup.make().inspect();
      const model = info.models[0] ?? setup.unknownModel;
      const error = await rejection(
        setup.make().run({ ...REQUEST, model }, { signal: stop.signal }),
      );
      expect(isAgentRunError(error)).toBe(true);
    });

    it("a turn with tools takes no tool server but ours", async () => {
      const runtime = setup.make();
      if (runtime.runWithTools === undefined) return;
      const error = await rejection(
        runtime.runWithTools(
          { ...REQUEST, model: setup.unknownModel },
          {
            server: {
              name: "x",
              url: "https://example.com/mcp",
              token: "t".repeat(32),
              tools: ["search_mail"],
            },
          },
        ),
      );
      expect(isAgentRunError(error)).toBe(true);
    });
  });
}
