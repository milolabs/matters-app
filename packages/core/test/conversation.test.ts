import { describe, expect, it } from "vitest";
import type { ConversationPart } from "../src/index.ts";
import { consolidateConversations, normalizeSubject } from "../src/index.ts";

// ADR 0081. Invented names and addresses (the .test domain is reserved).

const part = (
  threadId: string,
  subject: string,
  participants: string[],
  messages: number,
  accountId = "acc1",
): ConversationPart => ({ threadId, accountId, subject, participants, messages });

describe("normalizeSubject", () => {
  it("strips reply and forward prefixes in several languages, however often repeated", () => {
    expect(normalizeSubject("Re: RE: Fwd: Podpisanie umowy")).toBe("podpisanie umowy");
    expect(normalizeSubject("Odp: PD: AW: WG: Fw: Plan")).toBe("plan");
    expect(normalizeSubject("  re[2]:   Zażółć   gęślą ")).toBe("zazolc gesla");
  });

  it("keeps a colon that is part of the subject", () => {
    expect(normalizeSubject("Offer: next steps")).toBe("offer: next steps");
    expect(normalizeSubject("Review of Reports")).toBe("review of reports");
  });

  it("is empty for a subject that is only prefixes", () => {
    expect(normalizeSubject("Re: Fwd:")).toBe("");
  });
});

describe("consolidating a conversation split into many threads (ADR 0081)", () => {
  it("makes nine fragments and the long thread one candidate, represented by the longest", () => {
    const fragments = Array.from({ length: 9 }, (_, i) =>
      part(
        `frag-${i}`,
        i % 2 === 0 ? "Signing the contract" : "Re: Signing the contract",
        ["kim@partner.example.test", "me@example.test"],
        2 + (i % 2),
      ),
    );
    const whole = part(
      "whole",
      "RE: RE: Signing the contract",
      ["kim@partner.example.test", "lee@partner.example.test", "me@example.test"],
      18,
    );
    const rep = consolidateConversations([...fragments, whole]);
    for (const p of [...fragments, whole]) expect(rep.get(p.threadId)).toBe("whole");
  });

  it("leaves a thread alone when nothing else has its subject", () => {
    const rep = consolidateConversations([part("a", "One", ["x@a.example.test"], 3)]);
    expect(rep.get("a")).toBe("a");
  });

  it("does not join threads of different accounts, with no shared person, or with an empty subject", () => {
    const rep = consolidateConversations([
      part("a1", "Hello", ["x@a.example.test"], 2, "acc1"),
      part("a2", "Hello", ["x@a.example.test"], 5, "acc2"),
      part("b1", "Meeting", ["p@a.example.test"], 2),
      part("b2", "Meeting", ["q@b.example.test"], 5),
      part("c1", "Re:", ["x@a.example.test"], 2),
      part("c2", "Fwd:", ["x@a.example.test"], 5),
    ]);
    for (const id of ["a1", "a2", "b1", "b2", "c1", "c2"]) expect(rep.get(id)).toBe(id);
  });

  it("joins through a third thread, and ignores an address that says nothing (the person's own)", () => {
    const own = new Set(["me@example.test"]);
    const rep = consolidateConversations(
      [
        part("t1", "Plan", ["a@x.example.test", "me@example.test"], 2),
        part("t2", "Plan", ["a@x.example.test", "b@y.example.test", "me@example.test"], 3),
        part("t3", "Plan", ["b@y.example.test", "me@example.test"], 4),
        // Shares only the person's own address: another conversation with the same title.
        part("t4", "Plan", ["z@z.example.test", "me@example.test"], 9),
      ],
      own,
    );
    expect(rep.get("t1")).toBe("t3");
    expect(rep.get("t2")).toBe("t3");
    expect(rep.get("t3")).toBe("t3");
    expect(rep.get("t4")).toBe("t4");
  });

  it("prefers the smaller id when the lengths are equal", () => {
    const rep = consolidateConversations([
      part("b", "Plan", ["a@x.example.test"], 2),
      part("a", "Plan", ["a@x.example.test"], 2),
    ]);
    expect(rep.get("b")).toBe("a");
  });
});
