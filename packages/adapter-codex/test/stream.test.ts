import { describe, expect, it } from "vitest";
import { classifyFailure, dropNulls, itemVerdict, retryAt, strictSchema } from "../src/stream.ts";

describe("the schema in strict form, and the answer back in ours (ADR 0120, rule 5)", () => {
  const schema = {
    type: "object",
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["thread"],
          properties: {
            thread: { type: "integer", minimum: 1 },
            quote: { type: "string", minLength: 1, maxLength: 300 },
            kind: { type: "string", enum: ["a", "b"] },
          },
        },
      },
    },
  };

  it("closes every object, requires every property and makes the optional ones nullable", () => {
    expect(strictSchema(schema)).toEqual({
      type: "object",
      required: ["verdicts"],
      additionalProperties: false,
      properties: {
        verdicts: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["thread", "quote", "kind"],
            properties: {
              thread: { type: "integer", minimum: 1 },
              quote: { anyOf: [{ type: "string" }, { type: "null" }] },
              kind: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
            },
          },
        },
      },
    });
  });

  it("takes out the nulls of optional properties only", () => {
    expect(
      dropNulls(
        {
          verdicts: [
            { thread: 1, quote: null, kind: "a" },
            { thread: 2, quote: "q", kind: null },
          ],
        },
        schema,
      ),
    ).toEqual({
      verdicts: [
        { thread: 1, kind: "a" },
        { thread: 2, quote: "q" },
      ],
    });
    // A null where our schema requires a value stays, and the code that reads it refuses it.
    expect(dropNulls({ verdicts: null }, schema)).toEqual({ verdicts: null });
  });
});

describe("what Codex writes, read only to sort it", () => {
  it("knows the items that carry no action, and takes any other for an action", () => {
    expect(itemVerdict({ type: "agent_message", text: "x" })).toEqual({
      kind: "message",
      text: "x",
    });
    expect(itemVerdict({ type: "reasoning", text: "x" }).kind).toBe("quiet");
    expect(itemVerdict({ type: "error", message: "x" }).kind).toBe("quiet");
    for (const type of [
      "command_execution",
      "file_change",
      "web_search",
      "todo_list",
      "new_thing",
    ]) {
      expect(itemVerdict({ type }).kind).toBe("forbidden");
    }
    expect(itemVerdict(null).kind).toBe("forbidden");
  });

  it("sorts failures", () => {
    expect(classifyFailure("You’ve hit your usage limit.")).toBe("limit");
    expect(classifyFailure("429 Too Many Requests")).toBe("limit");
    expect(classifyFailure("401 Unauthorized")).toBe("notSignedIn");
    expect(classifyFailure("Your access token could not be refreshed")).toBe("notSignedIn");
    expect(classifyFailure("Your input exceeds the context window of this model")).toBe("tooLong");
    expect(classifyFailure("Unsupported value: 'reasoning.effort'")).toBe("effort");
    expect(classifyFailure("The model `x` does not exist")).toBe("modelGone");
    expect(classifyFailure("stream disconnected before completion")).toBe("failed");
  });

  it("reads when a limit lifts, in this Mac's time zone", () => {
    const now = new Date(2026, 10, 12, 9, 0).getTime();
    expect(retryAt("You’ve hit your usage limit. Try again at 3:45 PM.", now)).toBe(
      new Date(2026, 10, 12, 15, 45).getTime(),
    );
    expect(retryAt("… or try again at Nov 13th, 2026 12:05 AM.", now)).toBe(
      new Date(2026, 10, 13, 0, 5).getTime(),
    );
    expect(retryAt("Try again later.", now)).toBeUndefined();
    // A time that has passed is not a time to wait for.
    expect(retryAt("Try again at 8:00 AM.", now)).toBeUndefined();
  });
});
