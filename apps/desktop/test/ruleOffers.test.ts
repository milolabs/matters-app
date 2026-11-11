import type { ThingFeedback } from "@matters/core";
import { describe, expect, it } from "vitest";
import { type AgentReadDeps, readRuleOffer } from "../src/backend/agentReads.ts";

const said = (
  threadId: string,
  senderAddress: string,
  kind: ThingFeedback["kind"],
  atMs = 1,
): ThingFeedback => ({ threadId, lastMessageKey: 1, senderAddress, kind, atMs });

function deps(sender: string, feedback: readonly ThingFeedback[]): AgentReadDeps {
  return {
    store: {
      getThread: async () => ({
        thread: { accountId: "a" },
        messages: [{ from: { address: sender } }],
      }),
    },
    accounts: { list: async () => [{ address: "me@example.com" }] },
    insights: { listRules: async () => [], listFeedback: async () => feedback },
  } as unknown as AgentReadDeps;
}

describe("what saying no adds up to (ADR 0058, rule 4)", () => {
  const SENDER = "anna@northwind.example";

  it("offers the sender after one closing", async () => {
    const offer = await readRuleOffer(deps(SENDER, [said("t", SENDER, "closed")]), "t");
    expect(offer).toEqual({ scope: "sender", subject: SENDER });
  });

  it("waits for the second Not important", async () => {
    const once = [said("t", SENDER, "notImportant")];
    expect(await readRuleOffer(deps(SENDER, once), "t")).toBeNull();
    const twice = [...once, said("u", SENDER, "notImportant")];
    expect(await readRuleOffer(deps(SENDER, twice), "t")).toEqual({
      scope: "sender",
      subject: SENDER,
    });
  });

  it("offers the domain after three from more than one sender", async () => {
    const list = [
      said("t", SENDER, "closed"),
      said("u", "bob@northwind.example", "notImportant"),
      said("v", "bob@northwind.example", "closed"),
    ];
    expect(await readRuleOffer(deps(SENDER, list), "t")).toEqual({
      scope: "domain",
      subject: "northwind.example",
    });
  });

  it("stays with the sender when one person is all the domain has", async () => {
    const list = [
      said("t", SENDER, "closed"),
      said("u", SENDER, "closed"),
      said("v", SENDER, "closed"),
    ];
    expect(await readRuleOffer(deps(SENDER, list), "t")).toMatchObject({ scope: "sender" });
  });

  it("never offers a shared mail domain, and does not count Later", async () => {
    const gmail = "anna@gmail.com";
    const shared = [
      said("t", gmail, "closed"),
      said("u", "bob@gmail.com", "closed"),
      said("v", "cara@gmail.com", "closed"),
    ];
    expect(await readRuleOffer(deps(gmail, shared), "t")).toMatchObject({ scope: "sender" });
    const later = [
      said("t", SENDER, "closed"),
      said("u", "bob@northwind.example", "later"),
      said("v", "cara@northwind.example", "later"),
    ];
    expect(await readRuleOffer(deps(SENDER, later), "t")).toMatchObject({ scope: "sender" });
  });
});
