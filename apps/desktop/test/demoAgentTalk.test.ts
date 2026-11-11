import type { PromptThread } from "@matters/core";
import {
  acceptTalkAll,
  acceptTalkQuotes,
  buildTalkAllRequest,
  buildTalkFollowRequest,
  buildTalkPlanRequest,
  buildTalkRequest,
  parseTalkAllAnswer,
  parseTalkAnswer,
  parseTalkFollow,
  parseTalkPlan,
  type TalkAnswer,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import { DemoAgentRuntime } from "../src/backend/demoAgent.ts";

const NOW = Date.UTC(2026, 10, 6, 12);
const thread: PromptThread = {
  subject: "Faktura 651/2026",
  messages: [
    {
      key: 1,
      dateMs: NOW - 86_400_000,
      from: { name: "Anna", address: "anna@northwind.example" },
      fromOwn: false,
      text: "Dzień dobry,\n\nTermin płatności upływa w piątek.\n\nAnna",
    },
    { key: 2, dateMs: NOW, from: { address: "me@x.example" }, fromOwn: true, text: "Dziękuję." },
  ],
};

async function ask(words: string, onThread: PromptThread = thread) {
  const demo = new DemoAgentRuntime(() => NOW, 0);
  const request = buildTalkRequest(onThread, NOW, [], words);
  const { value } = await demo.run({ model: "m", ...request });
  return parseTalkAnswer(value);
}

describe("the demo agent in a talk", () => {
  it("answers a question with one exact quote of the newest message", async () => {
    const answer = await ask("What is this about?");
    expect(answer?.kind).toBe("answer");
    const { quotes } = answer as Extract<TalkAnswer, { kind: "answer" }>;
    expect(quotes).toEqual([{ message: 2, quote: "Dziękuję." }]);
    expect(acceptTalkQuotes(quotes, thread.messages)).toHaveLength(1);
  });

  it("finds a passage in an older message when the newest has none to quote", async () => {
    const answer = await ask("What is this about?", {
      ...thread,
      messages: [thread.messages[0] as PromptThread["messages"][number]],
    });
    const { quotes } = answer as Extract<TalkAnswer, { kind: "answer" }>;
    expect(quotes[0]?.message).toBe(1);
    expect(
      acceptTalkQuotes(quotes, [thread.messages[0] as PromptThread["messages"][number]]),
    ).not.toBeNull();
  });

  it("answers without a quote when the thread has nothing to quote", async () => {
    const answer = await ask("Anything?", {
      subject: "Empty",
      messages: [{ ...(thread.messages[1] as PromptThread["messages"][number]), text: "" }],
    });
    expect(answer).toMatchObject({ kind: "answer", quotes: [] });
  });

  it("writes a draft for a digit, write, reply or odpisz", async () => {
    for (const words of ["Pay 400 euro", "please write back", "Reply yes", "odpisz mu"]) {
      expect((await ask(words))?.kind, words).toBe("draft");
    }
  });

  it("closes for done, załatwione or no reply", async () => {
    for (const words of ["It is done", "załatwione", "no reply needed"]) {
      expect((await ask(words))?.kind, words).toBe("closed");
    }
  });

  it("reads the person's words only, never the mail's", async () => {
    // The mail says "write" and has a digit; the person's words do not.
    const mail: PromptThread = {
      subject: "x",
      messages: [
        {
          ...(thread.messages[0] as PromptThread["messages"][number]),
          text: "Please write back, 123 items, it is done",
        },
      ],
    };
    expect((await ask("What is this?", mail))?.kind).toBe("answer");
  });
});

describe("the demo agent across all mail", () => {
  const demo = new DemoAgentRuntime(() => NOW, 0);

  async function plan(words: string) {
    const { value } = await demo.run({ model: "m", ...buildTalkPlanRequest([], words, NOW) });
    return parseTalkPlan(value);
  }
  const queriesOf = (p: ReturnType<typeof parseTalkPlan>) => p?.trails.flatMap((t) => t.queries);

  it("plans a trail for the longest word of the person's words", async () => {
    expect(queriesOf(await plan("Who sent the invoice?"))).toEqual(["invoice"]);
    expect(queriesOf(await plan("faktura od Anny"))).toEqual(["faktura"]);
    expect((await plan("?!"))?.trails).toEqual([]);
  });

  it("follows by keeping the first thread it was shown, and answers", async () => {
    const request = buildTalkFollowRequest({
      words: "w",
      plan: (await plan("invoice")) as NonNullable<Awaited<ReturnType<typeof plan>>>,
      ran: [{ query: "invoice", threads: 2 }],
      candidates: [
        {
          number: 3,
          threadId: "t3",
          subject: "Invoice",
          senderName: "Anna",
          senderAddress: "anna@example.test",
          dateMs: NOW,
          messages: 1,
          files: [],
          fragment: "",
          automated: false,
          earlier: false,
        },
      ],
      hypothesis: "",
      waiting: [],
      roundsLeft: 2,
      nowMs: NOW,
    });
    const { value } = await demo.run({ model: "m", ...request });
    expect(parseTalkFollow(value)).toMatchObject({ decision: "answer", keep: [3] });
  });

  it("answers from the first thread with one quote the code accepts", async () => {
    const other: PromptThread = {
      subject: "Other",
      messages: [thread.messages[1] as PromptThread["messages"][number]],
    };
    const { request } = buildTalkAllRequest([thread, other], NOW, [], "What is open?");
    const { value } = await demo.run({ model: "m", ...request });
    const answer = parseTalkAllAnswer(value);
    expect(answer?.threads).toHaveLength(1);
    expect(answer?.threads[0]?.thread).toBe(1);
    expect(answer && acceptTalkAll(answer, [thread, other])).not.toBeNull();
  });

  it("cites nothing when the first thread has nothing to quote", async () => {
    const empty: PromptThread = {
      subject: "Empty",
      messages: [{ ...(thread.messages[1] as PromptThread["messages"][number]), text: "" }],
    };
    const { request } = buildTalkAllRequest([empty], NOW, [], "What is open?");
    const { value } = await demo.run({ model: "m", ...request });
    expect(parseTalkAllAnswer(value)).toMatchObject({ threads: [] });
  });
});
