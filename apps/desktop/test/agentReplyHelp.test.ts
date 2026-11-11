import { visibleText } from "@matters/adapter-mime";
import type { AgentRunRequest, AgentRuntimePort } from "@matters/core";
import { attribution, quoteLines } from "@matters/core";
import {
  createInMemoryStorage,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
} from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError, InvalidAgentSettingError } from "../src/backend/agentApi.ts";
import { AgentService } from "../src/backend/agentService.ts";
import { DemoAgentRuntime } from "../src/backend/demoAgent.ts";

const NOW = Date.UTC(2026, 10, 9, 12);
const SENT = Date.UTC(2026, 10, 6, 12);
const ASKED = [
  "Dzień dobry,",
  "",
  "Załączam wszystkie potrzebne dokumenty, proszę o potwierdzenie otrzymania. Czy możemy przesunąć spotkanie na jutro, na godzinę dziesiątą?",
  "",
  "Pozdrawiam serdecznie,",
  "",
  "-- ",
  "Agnieszka Wiśniewska",
  "tel. +48 601 234 567",
].join("\n");
const FROM = { name: "Agnieszka Wiśniewska", address: "agnieszka@example.pl" };
const QUOTE = `${attribution({ from: FROM, dateMs: SENT })}\n${quoteLines(ASKED)}\n`;
const reply = (own: string) => `${own}\n\n${QUOTE}`;

/** Which answers the runtime spoils for the helpers: none, a broken shape, or a lost gap. */
type Spoil = "none" | "junk" | "dropGap";

async function build(spoil: Spoil = "none", automated = false) {
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const insights = new InMemoryAgentInsightStore();
  const demo = new DemoAgentRuntime(() => clock.now(), 0);
  const calls: AgentRunRequest[] = [];
  const helper = (r: AgentRunRequest) => {
    const props = Object.keys((r.schema as { properties: object }).properties);
    return ["rewritten", "withAnswers", "asks", "fills"].some((k) => props.includes(k));
  };
  const runtime: AgentRuntimePort = {
    id: demo.id,
    name: demo.name,
    inspect: () => demo.inspect(),
    run: async (request, options) => {
      calls.push(request);
      if (spoil === "junk" && helper(request)) return { value: { nonsense: true } };
      const out = await demo.run(request, options);
      if (spoil === "dropGap" && "rewritten" in (out.value as object)) {
        return { value: { rewritten: "No gaps here." } };
      }
      return out;
    },
  };
  await storage.accounts.add({
    id: "acc1",
    address: "me@example.com",
    displayName: "Me",
    imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
    createdAtMs: 1,
  });
  const message = makeMessage({
    accountId: "acc1",
    threadId: "t1",
    providerId: "t1-1",
    dateMs: SENT,
    from: FROM,
    to: [{ address: "me@example.com" }],
    subject: "Dokumenty i spotkanie",
    ...(automated ? { automated: true } : {}),
  });
  const { keys } = await storage.store.upsertMessages([message]);
  await storage.bodies.putBodies(keys.map((key) => ({ key, threadId: "t1", text: ASKED })));
  const service = new AgentService({
    runtime,
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    accounts: storage.accounts,
    insights,
    settings: new InMemoryAgentSettings(),
    drafts: storage.drafts,
    saveDraft: async () => {
      throw new Error("a helper never saves a draft");
    },
    clock,
    visibleText,
    onChanged: () => {},
  });
  const enable = async () => {
    await service.setEnabled({ accountIds: ["acc1"], runtimeId: demo.id, windowDays: 30 });
    await service.pauseReading();
    await service.testRuntime();
  };
  return { service, insights, calls, enable, storage };
}

describe("help with a reply, over the demo assistant (ADR 0098)", () => {
  it("checks what the draft answers and names what it does not", async () => {
    const h = await build();
    await h.enable();
    const check = await h.service.checkReply(
      "t1",
      reply("Dzień dobry,\n\nPotwierdzam otrzymanie.\n\nPozdrawiam"),
    );
    expect(check).toEqual({
      asked: 2,
      answered: 1,
      missing: ["czy spotkanie można przesunąć na jutro na 10:00"],
    });
    // Cheap: the understand model, low effort, and no numbered thread.
    const call = h.calls.at(-1);
    expect(call?.effort).toBe("low");
    expect(call?.untrusted).not.toContain("[Message");
  });

  it("adds an answer for what is open, keeps the quote as it was, and leaves a gap for a decision", async () => {
    const h = await build();
    await h.enable();
    const own = "Dzień dobry,\n\nPotwierdzam otrzymanie.\n\nPozdrawiam";
    const text = (await h.service.answerQuestions("t1", reply(own))).text;
    expect(text.endsWith(`\n\n${QUOTE}`)).toBe(true);
    expect(text).toContain("Co do spotkania jutro o dziesiątej: [tak / nie].");
    expect(text.indexOf("[tak / nie]")).toBeLessThan(text.indexOf("Pozdrawiam\n"));
    // With everything answered, the text comes back exactly as it was sent.
    expect((await h.service.answerQuestions("t1", text)).text).toBe(text);
  });

  it("rewrites only the person's lines, keeps every gap, and joins the quote back", async () => {
    const h = await build();
    await h.enable();
    const own = "Dzień dobry,\n\ndziękuję za wiadomość. Będę [kiedy].\n\nPozdrawiam";
    const text = (await h.service.rewriteDraft("t1", reply(own), "english")).text;
    expect(text).toBe(
      reply("Hello,\n\nthank you for your message. Będę [kiedy].\n\nBest regards,"),
    );
    // The quote never went to the model for a rewrite.
    expect(h.calls.at(-1)?.untrusted).not.toContain("Załączam");
    const formal = (await h.service.rewriteDraft("t1", "Cześć,\n\ndzięki!\n\nPozdrawiam", "formal"))
      .text;
    expect(formal).toBe("Dzień dobry,\n\ndziękuję!\n\nZ wyrazami szacunku,");
    const shorter = (
      await h.service.rewriteDraft("t1", "To jest naprawdę bardzo ważne.", "shorter")
    ).text;
    expect(shorter).toBe("To jest ważne.");
  });

  it("finds values for the gaps in the mail, with where each came from", async () => {
    const h = await build();
    await h.enable();
    const suggestions = await h.service.fillGaps(
      "t1",
      reply("Zadzwonię na [telefon] i będę [godzina]. Kwota: [kwota]."),
    );
    expect(suggestions).toEqual([
      { token: "[telefon]", value: "+48 601 234 567", source: "Agnieszka's message, 6 Nov" },
      { token: "[godzina]", value: "na godzinę dziesiątą", source: "Agnieszka's message, 6 Nov" },
    ]);
    // A draft with no gap runs no turn.
    const turns = h.calls.length;
    expect(await h.service.fillGaps("t1", reply("Bez luk."))).toEqual([]);
    expect(h.calls.length).toBe(turns);
  });

  it("counts every turn in the ledger, and saves no draft", async () => {
    const h = await build();
    await h.enable();
    await h.service.checkReply("t1", reply("Hi"));
    await h.service.rewriteDraft("t1", reply("Hi"), "formal");
    // Newest first: the rewrite sent no mail, the check sent the one thread.
    const ledger = (await h.insights.listLedger(2)).map((e) => [e.purpose, e.threads]);
    expect(ledger).toEqual([
      ["prepare", 0],
      ["prepare", 1],
    ]);
    expect(await h.storage.drafts.list()).toEqual([]);
  });
});

describe("help with a reply to a newsletter or a notice", () => {
  it("asks nothing of the model: mail from a list or a program asks nothing of the person", async () => {
    const h = await build("none", true);
    await h.enable();
    const before = h.calls.length;
    const text = reply("Dziękuję, nie jestem zainteresowany tą ofertą.");
    expect(await h.service.checkReply("t1", text)).toEqual({ asked: 0, answered: 0, missing: [] });
    expect(await h.service.answerQuestions("t1", text, ["stop the emails"])).toEqual({ text });
    expect(h.calls.length).toBe(before);
  });
});

describe("help with a reply: what is refused", () => {
  it("refuses while AI is off, and a rewrite of nothing, before any turn", async () => {
    const h = await build();
    await expect(h.service.checkReply("t1", "Hi")).rejects.toBeInstanceOf(AgentUnavailableError);
    await h.enable();
    const turns = h.calls.length;
    await expect(h.service.rewriteDraft("t1", reply("  "), "formal")).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    await expect(h.service.rewriteDraft("t1", "Hi", "poetic" as "formal")).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    expect(h.calls.length).toBe(turns);
  });

  it("turns an answer out of shape into a sentence, for each helper", async () => {
    const h = await build("junk");
    await h.enable();
    const sentence = "The assistant's answer could not be used. Try again.";
    await expect(h.service.rewriteDraft("t1", "Hi", "formal")).rejects.toThrow(sentence);
    await expect(h.service.answerQuestions("t1", "Hi")).rejects.toThrow(sentence);
    await expect(h.service.checkReply("t1", "Hi")).rejects.toThrow(sentence);
    await expect(h.service.fillGaps("t1", "Hi [telefon]")).rejects.toThrow(sentence);
    await expect(h.service.checkReply("t1", "Hi")).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("does not use a rewrite that lost a gap", async () => {
    const h = await build("dropGap");
    await h.enable();
    await expect(h.service.rewriteDraft("t1", "Będę [kiedy].", "formal")).rejects.toThrow(
      "lost a gap in [brackets]",
    );
  });
});
