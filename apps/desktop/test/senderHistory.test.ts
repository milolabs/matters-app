// ADR 0066, rule 1: the line that tells a model how often the person wrote to a sender's company
// (kept by ADR 0117, rule 7). The store is hand-made so that only Sent mail is read.
import type { Message, WrittenTo } from "@matters/core";
import { describe, expect, it } from "vitest";
import { senderHistory } from "../src/backend/agentReads.ts";

const NOW = Date.UTC(2026, 10, 5, 12);
const ME = "me@example.com";

describe("the history line (ADR 0066, rule 1)", () => {
  const sent = {
    "anna@northwind.example": { sent: 3, lastMs: Date.UTC(2025, 5, 1) },
    "tax@mail.northwind.example": { sent: 1, lastMs: Date.UTC(2026, 1, 1) },
    "ola@gmail.com": { sent: 2, lastMs: Date.UTC(2024, 0, 1) },
  };
  const message = (from: string, own = false): Message =>
    ({
      key: 1,
      dateMs: NOW,
      from: { address: own ? ME : from },
      to: [{ address: own ? from : ME }],
      cc: [],
    }) as unknown as Message;
  const store = (map: Record<string, WrittenTo>) => ({
    listWrittenTo: async () => new Map(Object.entries(map)),
  });
  const own = new Set([ME]);

  it("counts messages to the whole company and gives the year of the last", async () => {
    expect(await senderHistory(store(sent), NOW, [message("new@northwind.example")], own)).toBe(
      "You wrote 4 messages to this company, the last in 2026",
    );
    expect(await senderHistory(store(sent), NOW, [message("new@elsewhere.example")], own)).toBe(
      "You have never written to this company",
    );
  });

  it("speaks of the sender, not a company, at a shared mail domain", async () => {
    expect(await senderHistory(store(sent), NOW, [message("ola@gmail.com")], own)).toBe(
      "You wrote 2 messages to this sender, the last in 2024",
    );
    expect(await senderHistory(store(sent), NOW, [message("eve@gmail.com")], own)).toBe(
      "You have never written to this sender",
    );
  });

  it("does not count the thread's own reply, which the model sees in the thread", async () => {
    const thread = [
      message("tax@mail.northwind.example"),
      message("tax@mail.northwind.example", true),
    ];
    const only = { "tax@mail.northwind.example": { sent: 1, lastMs: NOW } };
    expect(await senderHistory(store(only), NOW, thread, own)).toBe(
      "You have never written to this company",
    );
  });

  it("is absent while no Sent mail is known at all, and carries no address", async () => {
    expect(
      await senderHistory(store({}), NOW, [message("a@northwind.example")], own),
    ).toBeUndefined();
    const line = await senderHistory(store(sent), NOW, [message("a@northwind.example")], own);
    expect(line).not.toMatch(/@|northwind/);
  });
});
