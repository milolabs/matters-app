import { describe, expect, it } from "vitest";
import {
  chooseThread,
  isLocalThread,
  isReplySubject,
  localThreadRoot,
  localThreadRootOf,
  normalizeSubject,
  type SubjectJoinCandidate,
  type SubjectJoinMessage,
  subjectToJoinBy,
  threadBySubject,
  threadParents,
} from "../src/index.ts";

describe("threadParents (ADR 0091, rule 1)", () => {
  it("lists References then In-Reply-To, each once, without blanks or the message itself", () => {
    expect(
      threadParents({
        messageId: "<me>",
        inReplyTo: "<b>",
        references: ["<a>", " <b> ", "", "<me>", "<a>"],
      }),
    ).toEqual(["<a>", "<b>"]);
  });
  it("is empty for a message that answers nothing", () => {
    expect(threadParents({ messageId: "<me>", inReplyTo: "", references: [] })).toEqual([]);
  });
});

describe("local thread ids", () => {
  it("name their root after the account, and only local ones do", () => {
    const id = `lt:acc1:${localThreadRoot({ messageId: "<c>", inReplyTo: "<b>", references: [] })}`;
    expect(localThreadRootOf(id, "acc1")).toBe("<b>");
    expect(localThreadRootOf("pt:acc1:123", "acc1")).toBe("");
    expect(localThreadRootOf(id, "acc2")).toBe("");
    expect(isLocalThread(id)).toBe(true);
    expect(isLocalThread("pt:acc1:123")).toBe(false);
  });
});

describe("chooseThread (ADR 0091, rule 3)", () => {
  it("keeps the thread whose first message is the oldest", () => {
    expect(
      chooseThread([
        { threadId: "lt:a:<b>", firstDateMs: 200 },
        { threadId: "lt:a:<a>", firstDateMs: 100 },
        { threadId: "lt:a:<new>", firstDateMs: null },
      ]),
    ).toBe("lt:a:<a>");
  });
  it("puts a thread with no stored message last, and breaks a tie by id", () => {
    expect(
      chooseThread([
        { threadId: "lt:a:<z>", firstDateMs: null },
        { threadId: "lt:a:<y>", firstDateMs: 5 },
      ]),
    ).toBe("lt:a:<y>");
    expect(
      chooseThread([
        { threadId: "lt:a:<y>", firstDateMs: 5 },
        { threadId: "lt:a:<x>", firstDateMs: 5 },
      ]),
    ).toBe("lt:a:<x>");
  });
});

describe("a reply without ids joins by its subject (ADR 0104)", () => {
  const DAY = 86_400_000;
  const T = Date.UTC(2026, 10, 1);
  const reply: SubjectJoinMessage = {
    messageId: "<c3@example.com>",
    parentIds: [],
    subject: "Re: Re: Floor quote",
    sender: "builder@example.com",
    dateMs: T,
    byPerson: false,
  };
  const thread = "lt:acc1:<c1@example.com>";
  /** A thread where the person wrote to the builder a day before, under the same subject. */
  const answered = (
    threadId = thread,
    daysBefore = 1,
    over: Partial<SubjectJoinCandidate> = {},
  ): SubjectJoinCandidate[] => [
    {
      threadId,
      dateMs: T - (daysBefore + 1) * DAY,
      subject: "Floor quote",
      byPerson: false,
      recipients: ["me@example.com"],
    },
    {
      threadId,
      dateMs: T - daysBefore * DAY,
      subject: "Re: Floor quote",
      byPerson: true,
      recipients: ["builder@example.com"],
      ...over,
    },
  ];
  const own = ["lt:acc1:<c3@example.com>"];

  it("joins the thread where the person wrote to the sender", () => {
    expect(threadBySubject(reply, own, answered())).toBe(thread);
  });

  it("needs headers read and pointing to nothing (rule 1)", () => {
    const { parentIds: _, ...unread } = reply;
    expect(threadBySubject(unread, own, answered())).toBeUndefined();
    expect(threadBySubject({ ...reply, parentIds: ["<x>"] }, own, answered())).toBeUndefined();
    expect(threadBySubject({ ...reply, messageId: "" }, own, answered())).toBeUndefined();
    expect(threadBySubject({ ...reply, messageId: " <> " }, own, answered())).toBeUndefined();
  });

  it("leaves the person's own message alone (rule 2)", () => {
    expect(threadBySubject({ ...reply, byPerson: true }, own, answered())).toBeUndefined();
  });

  it("needs the prefix of a reply, not of a forward, and a subject of 3 characters (rule 3)", () => {
    expect(threadBySubject({ ...reply, subject: "Floor quote" }, own, answered())).toBeUndefined();
    for (const subject of [
      "Fwd: Floor quote",
      "FW: Floor quote",
      "PD: Floor quote",
      "WG: Floor quote",
    ]) {
      expect(threadBySubject({ ...reply, subject }, own, answered())).toBeUndefined();
    }
    for (const subject of [
      "Odp: Floor quote",
      "RE: Floor quote",
      "Re[2]: Floor quote",
      "aw: Floor quote",
    ]) {
      expect(threadBySubject({ ...reply, subject }, own, answered())).toBe(thread);
    }
    const short = answered().map((c) => ({ ...c, subject: "Re: ok" }));
    expect(threadBySubject({ ...reply, subject: "Re: ok" }, own, short)).toBeUndefined();
    const three = answered().map((c) => ({ ...c, subject: "Re: abc" }));
    expect(threadBySubject({ ...reply, subject: "Re: abc" }, own, three)).toBe(thread);
  });

  it("needs the same subject in another local thread, before it and at most 30 days older (rule 4)", () => {
    const other = answered().map((c) => ({ ...c, subject: "Re: Another matter" }));
    expect(threadBySubject(reply, own, other)).toBeUndefined();
    expect(threadBySubject(reply, [thread], answered())).toBeUndefined();
    expect(threadBySubject(reply, own, answered("pt:acc1:42"))).toBeUndefined();
    const later = answered().map((c) => ({ ...c, dateMs: T + DAY }));
    expect(threadBySubject(reply, own, later)).toBeUndefined();
    // Only the subject's date counts: the person's message is that old in both.
    const at = (days: number) => [
      {
        threadId: thread,
        dateMs: T - days * DAY,
        subject: "Re: Floor quote",
        byPerson: true,
        recipients: ["builder@example.com"],
      },
    ];
    expect(threadBySubject(reply, own, at(30))).toBe(thread);
    expect(threadBySubject(reply, own, at(31))).toBeUndefined();
  });

  it("needs the person to have written to the sender in that thread before (rule 5)", () => {
    expect(
      threadBySubject(reply, own, answered(thread, 1, { recipients: ["someone@example.com"] })),
    ).toBeUndefined();
    expect(threadBySubject(reply, own, answered(thread, 1, { byPerson: false }))).toBeUndefined();
    const after = answered(thread, 1, { dateMs: T + DAY, subject: "Re: Other" });
    expect(threadBySubject(reply, own, after)).toBeUndefined();
    expect(
      threadBySubject(
        reply,
        own,
        answered(thread, 1, { recipients: ["x@example.com"] }).concat({
          threadId: thread,
          dateMs: T - 50 * DAY,
          subject: "Something else",
          byPerson: true,
          recipients: ["x@example.com"],
        }),
      ),
    ).toBeUndefined();
  });

  it("compares addresses in any case", () => {
    const loud = answered(thread, 1, { recipients: [" Builder@Example.COM "] });
    expect(threadBySubject({ ...reply, sender: "BUILDER@example.com" }, own, loud)).toBe(thread);
  });

  it("takes the thread whose subject is the newest, a tie to the smaller id", () => {
    const older = "lt:acc1:<a@example.com>";
    const newer = "lt:acc1:<z@example.com>";
    expect(threadBySubject(reply, own, [...answered(older, 5), ...answered(newer, 2)])).toBe(newer);
    expect(threadBySubject(reply, own, [...answered(newer, 2), ...answered(older, 2)])).toBe(older);
  });
});

describe("subjectToJoinBy and isReplySubject", () => {
  it("give the normalised subject of a reply only", () => {
    expect(
      subjectToJoinBy({
        messageId: "<m>",
        parentIds: [],
        subject: "Re: Re[2]: ODP: Floor",
        sender: "a@example.com",
        dateMs: 0,
        byPerson: false,
      }),
    ).toBe(normalizeSubject("Floor"));
    expect(isReplySubject("Fwd: Re: Floor")).toBe(false);
    expect(isReplySubject("SV: Floor")).toBe(true);
    expect(isReplySubject("Review: Floor")).toBe(false);
  });
});
