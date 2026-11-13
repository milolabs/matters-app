import { describe, expect, it } from "vitest";
import {
  ASKED_CLOSE,
  ASKED_OPEN,
  acceptAnswers,
  acceptCheck,
  acceptFills,
  acceptRewrite,
  acceptWrite,
  buildAnswerQuestionsRequest,
  buildCheckReplyRequest,
  buildFillGapsRequest,
  buildRewriteRequest,
  buildWriteRequest,
  COMMON_RULES,
  DRAFT_CLOSE,
  DRAFT_OPEN,
  draftFor,
  draftGaps,
  GAPS_OPEN,
  joinDraft,
  keepsGaps,
  LAST_OPEN,
  lastFromThem,
  MAX_ASKS,
  MAX_WRITE_WORDS_CHARS,
  type PromptThread,
  REWRITE_HOW_TEXT,
  SUBJECT_OPEN,
  sourceLabel,
  splitDraft,
  WRITE_SCHEMA,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 9, 12);
const DAY = 86_400_000;

const QUOTE =
  "On 6 Nov 2026, 10:29, Anna wrote:\n> Who pays for the pump?\n>\n> Delivery is on 12.11.2026.";
const REPLY = `Hi Anna,\n\nThe pump is [who pays]. See you [date].\n\n${QUOTE}\n`;

const thread: PromptThread = {
  subject: "The pump",
  messages: [
    {
      key: 1,
      dateMs: NOW - 4 * DAY,
      from: { address: "me@example.com" },
      fromOwn: true,
      text: "Hello Anna, can you send the offer?",
    },
    {
      key: 2,
      dateMs: Date.UTC(2026, 10, 6, 12),
      from: { name: "Anna Northwind", address: "anna@northwind.example" },
      fromOwn: false,
      text: "Who pays for the pump?\n\nDelivery is on 12.11.2026, the price is 1 200 PLN.\n\n> Hello Anna, can you send the offer?",
    },
  ],
};

describe("the draft and its quote (ADR 0098)", () => {
  it("splits at the first quoted line, with the line that introduces it", () => {
    const parts = splitDraft(REPLY);
    expect(parts.own).toBe("Hi Anna,\n\nThe pump is [who pays]. See you [date].\n");
    expect(parts.quote).toBe(`${QUOTE}\n`);
    expect(joinDraft(parts.own, parts.quote)).toBe(REPLY);
  });

  it("keeps a reply with no quote whole, and a quote with no words above it", () => {
    expect(splitDraft("Just this.")).toEqual({ own: "Just this.", quote: "" });
    const empty = splitDraft(`\n\n${QUOTE}`);
    expect(empty.own.trim()).toBe("");
    expect(joinDraft("", empty.quote)).toBe(`\n\n${QUOTE}`);
    expect(joinDraft("New words  \n\n", "")).toBe("New words");
  });

  it("leaves the person's words between quoted lines with the quote, untouched", () => {
    const parts = splitDraft("Top.\n\n> one\nMy inline answer\n> two");
    expect(parts.own).toBe("Top.\n");
    expect(parts.quote).toBe("> one\nMy inline answer\n> two");
  });

  it("finds the gaps of the person's lines once each, and checks they are kept", () => {
    expect(draftGaps("[a] and [b] and [a], a [link](x) and [x]")).toEqual(["[a]", "[b]"]);
    expect(keepsGaps("[a] [a] [b]", "[b] [a] [a]")).toBe(true);
    expect(keepsGaps("[a] [a] [b]", "[b] [a]")).toBe(false);
    expect(keepsGaps("[a]", "[a] [c]")).toBe(true);
    expect(keepsGaps("[a]", "[a] [c]", true)).toBe(false);
  });
});

describe("the last message from the other side", () => {
  it("is the newest one not from the person, without what it quotes", () => {
    const last = lastFromThem(thread);
    expect(last?.number).toBe(2);
    expect(last?.text).toContain("Who pays for the pump?");
    expect(last?.text).not.toContain("send the offer");
  });

  it("is null when only the person wrote", () => {
    expect(lastFromThem({ ...thread, messages: [thread.messages[0] as never] })).toBeNull();
  });

  it("names where a value came from, made by the code", () => {
    const [mine, hers] = thread.messages as [never, never];
    expect(sourceLabel(hers)).toBe("Anna's message, 6 Nov");
    expect(sourceLabel(mine)).toMatch(/^your message, \d+ Nov$/);
  });
});

describe("the requests", () => {
  it("sends only the person's lines for a rewrite, with the way asked in the fixed text", () => {
    const { own } = splitDraft(REPLY);
    for (const how of ["shorter", "formal", "english"] as const) {
      const r = buildRewriteRequest(own, how);
      expect(r.instructions).toContain(REWRITE_HOW_TEXT[how]);
      expect(r.instructions).toContain(COMMON_RULES);
      expect(r.untrusted).toBe(`${DRAFT_OPEN}\n${own.trim()}\n${DRAFT_CLOSE}`);
      expect(r.untrusted).not.toContain("Anna wrote");
    }
  });

  it("carries the person's standing instructions for writing", () => {
    const r = buildRewriteRequest("Hi", "formal", {
      list: [{ id: 1, scope: "write", text: "Sign as Milo", atMs: 1, actor: "person" }],
      threadId: "t1",
    });
    expect(r.instructions).toContain("- Sign as Milo");
  });

  it("checks with the last message and the draft only: no other mail", () => {
    const last = lastFromThem(thread);
    if (last === null) throw new Error("no last message");
    const r = buildCheckReplyRequest(last, "Hi Anna");
    expect(r.untrusted).toContain(LAST_OPEN);
    expect(r.untrusted).toContain("Who pays for the pump?");
    expect(r.untrusted).not.toContain("[Message");
    expect(r.untrusted.length).toBeLessThan(1000);
  });

  it("answers and fills with the thread, the draft and, for gaps, their list", () => {
    const last = lastFromThem(thread);
    if (last === null) throw new Error("no last message");
    const answers = buildAnswerQuestionsRequest(thread, last, "Hi Anna", NOW);
    expect(answers.untrusted).toContain("The last message from the other side is Message 2.");
    expect(answers.untrusted).toContain("[Message 2]");
    expect(answers.untrusted).not.toContain("A check of the draft found");
    const aimed = buildAnswerQuestionsRequest(thread, last, "Hi Anna", NOW, undefined, [
      "the date",
    ]);
    expect(aimed.untrusted).toContain(
      "found these not answered yet; answer each of them:\n- the date",
    );
    const fills = buildFillGapsRequest(thread, "Price: [price]", ["[price]"], NOW);
    expect(fills.untrusted).toContain(`${GAPS_OPEN}\n[price]\n`);
    expect(fills.untrusted).toContain("[Message 2]");
  });
});

describe("writing as the person asks (ADR 0132)", () => {
  it("gives a new message the words, the subject and the lines, and no mail", () => {
    const r = buildWriteRequest({
      words: "  write an invitation to Friday's review,\n keep it short ",
      subject: "Review",
      own: "",
    });
    expect(r.schema).toBe(WRITE_SCHEMA);
    expect(r.instructions).toContain(COMMON_RULES);
    expect(r.instructions).toContain("there is no thread");
    expect(r.instructions).not.toContain("[Message 3]");
    expect(r.untrusted).toContain(
      `${ASKED_OPEN}\nwrite an invitation to Friday's review, keep it short\n${ASKED_CLOSE}`,
    );
    expect(r.untrusted).toContain(`${SUBJECT_OPEN}\nReview\n`);
    expect(r.untrusted).toContain(`${DRAFT_OPEN}\n\n${DRAFT_CLOSE}`);
    expect(r.untrusted).not.toContain("[Message");
  });

  it("gives a reply its thread, keeps the words short, and carries the standing lines", () => {
    const { own } = splitDraft(REPLY);
    const r = buildWriteRequest(
      {
        words: "x".repeat(MAX_WRITE_WORDS_CHARS + 50),
        subject: "Re: Pump",
        own,
        thread: { thread, nowMs: NOW },
      },
      {
        list: [{ id: 1, scope: "write", text: "Sign as Milo", atMs: 1, actor: "person" }],
        threadId: "t1",
      },
    );
    expect(r.untrusted).toContain("[Message 2]");
    expect(r.untrusted).toContain(`${"x".repeat(MAX_WRITE_WORDS_CHARS)}\n${ASKED_CLOSE}`);
    expect(r.untrusted).not.toContain("x".repeat(MAX_WRITE_WORDS_CHARS + 1));
    // The quote never goes as the person's lines.
    expect(r.untrusted).not.toContain("Anna wrote");
    // The person's words go with the data, under their own heading, never in the fixed text.
    expect(r.instructions).not.toContain("xxxx");
    expect(r.instructions).toContain("- Sign as Milo");
  });

  it("takes the thread or the account of a request, and nothing else", () => {
    expect(draftFor({ threadId: "t1", text: "x" } as never)).toEqual({ threadId: "t1" });
    expect(draftFor({ accountId: "a1", words: "x" } as never)).toEqual({ accountId: "a1" });
  });

  it("keeps every gap the person left, and allows new ones for what it was not told", () => {
    const own = "Hi team,\n\nThe review is [room].";
    expect(
      acceptWrite({ written: " Hi team,\n\nThe review is [room], on [date] at [time]. \n" }, own),
    ).toEqual({ ok: true, value: "Hi team,\n\nThe review is [room], on [date] at [time]." });
    expect(acceptWrite({ written: "Hi team,\n\nThe review is on Friday." }, own)).toEqual({
      ok: false,
      reason: "gaps",
    });
  });

  it("refuses a quoted line, an empty text, a subject line and a wrong shape", () => {
    expect(acceptWrite({ written: "Hi\n> Anna wrote this" }, "")).toMatchObject({
      reason: "quote",
    });
    for (const value of [{ written: "  \n " }, { written: "" }, { written: 4 }, {}, null, "Hi"]) {
      expect(acceptWrite(value, ""), JSON.stringify(value)).toMatchObject({ reason: "shape" });
    }
    expect(acceptWrite({ written: "Hi", more: 1 }, "")).toMatchObject({ reason: "shape" });
    expect(acceptWrite({ written: "Subject: Review\n\nHi team" }, "")).toMatchObject({
      reason: "subject",
    });
    expect(
      acceptWrite({ written: "Friday review\n\nHi team" }, "", "Friday  review"),
    ).toMatchObject({ reason: "subject" });
    expect(acceptWrite({ written: "Hi team" }, "", "Friday review")).toEqual({
      ok: true,
      value: "Hi team",
    });
  });
});

describe("trusting the answers", () => {
  const own = "Hi Anna,\n\nThe pump is [who pays]. See you [date].";

  it("takes a rewrite that keeps every gap and adds none", () => {
    expect(acceptRewrite({ rewritten: " Anna, pump: [who pays]. [date]. \n" }, own)).toEqual({
      ok: true,
      value: "Anna, pump: [who pays]. [date].",
    });
    expect(acceptRewrite({ rewritten: "Anna, pump: [who pays]." }, own)).toEqual({
      ok: false,
      reason: "gaps",
    });
    expect(acceptRewrite({ rewritten: "[who pays] [date] [new]" }, own)).toMatchObject({
      reason: "gaps",
    });
    expect(acceptRewrite({ rewritten: "[who pays] [date]\n> quoted" }, own)).toMatchObject({
      reason: "quote",
    });
  });

  it("refuses an answer that is not in shape, without throwing", () => {
    for (const value of [
      null,
      "text",
      3,
      [],
      {},
      { rewritten: "" },
      { rewritten: 1 },
      { rewritten: "x", extra: 1 },
    ]) {
      expect(acceptRewrite(value, "x")).toEqual({ ok: false, reason: "shape" });
    }
    for (const value of [
      null,
      { withAnswers: "x" },
      { withAnswers: "x", added: -1 },
      { withAnswers: "x", added: 1.5 },
      { withAnswers: "x", added: MAX_ASKS + 1 },
    ]) {
      expect(acceptAnswers(value, "x")).toEqual({ ok: false, reason: "shape" });
    }
    for (const value of [
      null,
      { asks: "x" },
      { asks: [{ about: "", answered: true }] },
      { asks: [{ about: "x" }] },
      { asks: Array(MAX_ASKS + 1).fill({ about: "x", answered: true }) },
    ]) {
      expect(acceptCheck(value)).toEqual({ ok: false, reason: "shape" });
    }
    for (const value of [
      null,
      { fills: {} },
      { fills: [{ token: "[a]", message: 0, value: "x" }] },
      { fills: [{ token: "[a]", value: "x" }] },
    ]) {
      expect(acceptFills(value, ["[a]"], thread.messages)).toEqual({ ok: false, reason: "shape" });
    }
  });

  it("gives the draft back exactly when nothing was added", () => {
    expect(acceptAnswers({ withAnswers: "rewritten anyway", added: 0 }, own)).toEqual({
      ok: true,
      value: own,
    });
  });

  it("takes added answers that keep the draft, its gaps and no quote", () => {
    const more = `${own}\n\nDelivery on 12.11.2026 works. The price: [price].`;
    expect(acceptAnswers({ withAnswers: more, added: 2 }, own)).toEqual({ ok: true, value: more });
    expect(acceptAnswers({ withAnswers: "Hi. [who pays] [date]", added: 1 }, own)).toMatchObject({
      reason: "dropped",
    });
    expect(
      acceptAnswers({ withAnswers: own.replace("[date]", "Monday"), added: 1 }, own),
    ).toMatchObject({
      reason: "gaps",
    });
  });

  it("counts what the draft answers and names what it does not", () => {
    expect(
      acceptCheck({
        asks: [
          { about: "who pays for the pump", answered: false },
          { about: " the delivery\ndate ", answered: true },
        ],
      }),
    ).toEqual({ ok: true, value: { asked: 2, answered: 1, missing: ["who pays for the pump"] } });
    expect(acceptCheck({ asks: [] })).toEqual({
      ok: true,
      value: { asked: 0, answered: 0, missing: [] },
    });
  });

  it("keeps only values that are in the message they name, for gaps that are in the draft", () => {
    const got = acceptFills(
      {
        fills: [
          { token: "[date]", message: 2, value: "12.11.2026" },
          { token: "[date]", message: 2, value: "1 200 PLN" },
          { token: "[price]", message: 2, value: "1 300 PLN" },
          { token: "[made up]", message: 2, value: "pump" },
          { token: "[who]", message: 9, value: "Anna" },
        ],
      },
      ["[date]", "[price]", "[who]"],
      thread.messages,
    );
    expect(got).toEqual({
      ok: true,
      value: [{ token: "[date]", value: "12.11.2026", source: "Anna's message, 6 Nov" }],
    });
  });
});
