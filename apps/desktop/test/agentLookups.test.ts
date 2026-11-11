import { messageKey } from "@matters/core";
import { describe, expect, it, vi } from "vitest";
import { lookups } from "../src/backend/agentReads.ts";

const DAY = 86_400_000;
const NOW = 400 * DAY;
const received = (id: string, day: number, from: string) => ({
  key: messageKey(day * DAY, 0),
  threadId: id,
  from,
});

function store() {
  return {
    listSentMail: vi.fn(async () => [
      { subject: "Newest", recipients: ["anna@northwind.example", "cara@northwind.example"] },
      { subject: "Older", recipients: ["tax@mail.northwind.example"] },
      { subject: "Elsewhere", recipients: ["bob@elsewhere.example"] },
    ]),
    listReceivedMail: vi.fn(async () => [
      received("t3", 399, "a@northwind.example"),
      received("t2", 390, "b@elsewhere.example"),
      received("t1", 380, "news@mail.northwind.example"),
    ]),
  };
}

describe("lookups of a list build (ADR 0070, rule 1)", () => {
  it("walks each kind of mail once, however many companies it is asked about", async () => {
    const s = store();
    const look = lookups(s, NOW);
    await Promise.all([
      look.subjects("anna@northwind.example"),
      look.subjects("bob@elsewhere.example"),
      look.received("a@northwind.example", 0),
      look.received("b@elsewhere.example", 0),
      look.received("a@northwind.example", 385 * DAY),
    ]);
    expect(s.listSentMail).toHaveBeenCalledTimes(1);
    expect(s.listReceivedMail).toHaveBeenCalledTimes(1);
  });

  it("walks nothing it is not asked about", async () => {
    const s = store();
    lookups(s, NOW);
    await lookups(s, NOW).subjects("");
    await lookups(s, NOW).received("", 0);
    expect(s.listSentMail).not.toHaveBeenCalled();
    expect(s.listReceivedMail).not.toHaveBeenCalled();
  });

  it("gives the subjects of mail to the sender's company, each message once", async () => {
    const look = lookups(store(), NOW);
    expect(await look.subjects("x@northwind.example")).toEqual(["Newest", "Older"]);
    expect(await look.subjects("x@nowhere.example")).toEqual([]);
  });

  it("gives what came from the company since a time, and no further back than the lookback", async () => {
    const s = store();
    const look = lookups(s, NOW);
    expect(await look.received("x@northwind.example", 0)).toEqual(["t3", "t1"]);
    expect(await look.received("x@northwind.example", 385 * DAY)).toEqual(["t3"]);
    expect(s.listReceivedMail).toHaveBeenCalledWith(NOW - 365 * DAY);
  });
});
