import { describe, expect, it } from "vitest";
import type { Message, StoredAccount } from "../src/index.ts";
import {
  buildRewriteRequest,
  buildWriteRequest,
  draftSections,
  FORWARD_MARK,
  followSignature,
  InvalidSignatureError,
  joinDraft,
  joinSections,
  messageKey,
  normalizeSignature,
  ownWords,
  placeSignature,
  prepareForwardDraft,
  prepareNewMessage,
  prepareReplyDraft,
  SIGNATURE_DELIMITER,
  SIGNATURE_MAX_CHARS,
  saveSignature,
  signatureBlock,
  signatureProblem,
  splitDraft,
  withoutSignature,
} from "../src/index.ts";

const NOV_3 = new Date(2026, 10, 3, 10, 29).getTime();
const SIGNATURE = "Miłosz Sobczak\n**Matters** · [matters.example](https://matters.example)";
const BLOCK = `-- \n${SIGNATURE}`;

function account(over: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "acc1",
    address: "me@example.com",
    displayName: "Miłosz Sobczak",
    imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
    createdAtMs: 0,
    ...over,
  } as StoredAccount;
}

function message(over: Partial<Message> = {}): Message {
  return {
    key: messageKey(NOV_3, 0),
    accountId: "acc1",
    providerId: "m1",
    threadId: "t1",
    messageIdHeader: "<m1@northwind.example>",
    dateMs: NOV_3,
    from: { name: "Anna Nowak", address: "anna@example.com" },
    to: [{ name: "Miłosz Sobczak", address: "me@example.com" }],
    cc: [],
    subject: "Budget",
    snippet: "",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown",
    ...over,
  };
}

function deps(accounts: StoredAccount[], body = "Can you send the numbers?") {
  return {
    accounts: { list: async () => accounts },
    store: {
      getThread: async (threadId: string) => ({
        thread: { id: threadId, accountId: "acc1" } as never,
        messages: [message()],
        attachments: new Map(),
      }),
    },
    bodies: {
      getBodies: async (keys: readonly number[]) => new Map(keys.map((k) => [k, body])),
    },
    drafts: { findByThread: async () => null },
  };
}

describe("the signature as kept (ADR 0142, rule 1)", () => {
  it("is empty by default and adds nothing of the app's own", async () => {
    const prepared = await prepareNewMessage(deps([account()]));
    expect(prepared.signature).toBe("");
    expect(prepared.content.bodyMarkdown).toBe("");
    expect(placeSignature("", "")).toBe("");
  });

  it("is normalized: line ends, controls, trailing spaces, empty edges and a typed delimiter", () => {
    expect(normalizeSignature("\r\n\r\n--\r\n\r\nAnna  \r\nKowalska\u0007\t\r\n\r\n")).toBe(
      "Anna\nKowalska",
    );
    expect(normalizeSignature("-- \nAnna")).toBe("Anna");
    // Empty lines inside stay: they are paragraphs.
    expect(normalizeSignature("Anna\n\nMatters")).toBe("Anna\n\nMatters");
    expect(normalizeSignature("   \n\n")).toBe("");
  });

  it("has a length limit, and refuses a line that reads as quoted mail", () => {
    expect(signatureProblem("x".repeat(SIGNATURE_MAX_CHARS))).toBeNull();
    expect(signatureProblem("x".repeat(SIGNATURE_MAX_CHARS + 1))).toBe(
      "A signature can be up to 2,000 characters; this one has 2,001.",
    );
    expect(signatureProblem("Anna\n> quoted")).toMatch(/can't start with >/);
    expect(signatureProblem("Anna -> Matters")).toBeNull();
  });

  it("is saved normalized, refused with words for the field, and told when the account is gone", async () => {
    const kept: [string, string][] = [];
    const store = {
      setSignature: async (id: string, s: string) => {
        kept.push([id, s]);
        return id === "acc1";
      },
    };
    expect(await saveSignature({ accounts: store }, "acc1", "\n Anna  \n\n")).toBe(" Anna");
    expect(await saveSignature({ accounts: store }, "gone", "Anna")).toBeNull();
    await expect(
      saveSignature({ accounts: store }, "acc1", "y".repeat(SIGNATURE_MAX_CHARS + 1)),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    // Nothing is written when the signature is refused.
    expect(kept).toEqual([
      ["acc1", " Anna"],
      ["gone", "Anna"],
    ]);
  });
});

describe("where the signature lands (rules 2 and 3)", () => {
  it("a new message: an empty line to write on, then the delimiter and the signature", async () => {
    const prepared = await prepareNewMessage(deps([account({ signature: SIGNATURE })]));
    expect(prepared.signature).toBe(SIGNATURE);
    expect(prepared.content.bodyMarkdown).toBe(`\n\n${BLOCK}`);
    // The caret starts at 0, on the empty line above the signature.
    expect(prepared.content.bodyMarkdown.split("\n")[0]).toBe("");
  });

  it("a new message from the account asked for, with that account's signature", async () => {
    const accounts = [
      account({ signature: "First" }),
      account({ id: "acc2", address: "two@example.com", signature: "Second", createdAtMs: 1 }),
    ];
    const prepared = await prepareNewMessage(deps(accounts), "acc2");
    expect(prepared.content.bodyMarkdown).toBe("\n\n-- \nSecond");
  });

  it("a reply: above the quote, the caret above the signature", async () => {
    const prepared = await prepareReplyDraft(
      deps([account({ signature: SIGNATURE })]),
      "t1",
      "reply",
    );
    const body = prepared?.content.bodyMarkdown ?? "";
    expect(prepared?.signature).toBe(SIGNATURE);
    expect(body.startsWith(`\n\n${BLOCK}\n\nOn `)).toBe(true);
    expect(body).toContain("wrote:\n> Can you send the numbers?\n");
    expect(body.indexOf(SIGNATURE_DELIMITER)).toBeLessThan(body.indexOf(">"));
    const parts = draftSections(body);
    expect(parts.own.trim()).toBe("");
    expect(parts.signature).toBe(BLOCK);
    expect(parts.quote).toMatch(/^On .* wrote:\n> Can you send the numbers\?\n$/);
  });

  it("a reply to a message with no text: the signature alone", async () => {
    const prepared = await prepareReplyDraft(
      deps([account({ signature: SIGNATURE })], ""),
      "t1",
      "reply",
    );
    expect(prepared?.content.bodyMarkdown).toBe(`\n\n${BLOCK}`);
  });

  it("a reply without a signature is as it always was", async () => {
    const prepared = await prepareReplyDraft(deps([account()]), "t1", "reply");
    expect(prepared?.signature).toBe("");
    expect(prepared?.content.bodyMarkdown.startsWith("\n\nOn ")).toBe(true);
    expect(prepared?.content.bodyMarkdown).not.toContain(SIGNATURE_DELIMITER);
  });

  it("a draft that already answers the thread keeps its own text", async () => {
    const existing = { id: "d1", bodyMarkdown: "Old words\n\n-- \nOld signature" } as never;
    const prepared = await prepareReplyDraft(
      {
        ...deps([account({ signature: SIGNATURE })]),
        drafts: { findByThread: async () => existing },
      },
      "t1",
      "reply",
    );
    // The composer opens `existing`, which the new signature never touches.
    expect(prepared?.existing).toBe(existing);
  });

  it("a forward: above the forwarded part", async () => {
    const prepared = await prepareForwardDraft(
      deps([account({ signature: SIGNATURE })]),
      "t1",
      false,
    );
    const body = prepared?.content.bodyMarkdown ?? "";
    expect(body.startsWith(`\n\n${BLOCK}\n\n${FORWARD_MARK}\n`)).toBe(true);
    // The signature put in is not words the person wrote: closing it still leaves nothing.
    expect(ownWords(body, SIGNATURE)).toBe("");
    // Changed, it is theirs.
    expect(ownWords(body.replace("Sobczak", "S."), SIGNATURE)).not.toBe("");
  });

  it("is never put in twice", () => {
    const once = placeSignature("", SIGNATURE);
    expect(placeSignature(once, SIGNATURE)).toBe(once);
    expect(placeSignature(once, "Other")).toBe(once);
  });

  it("keeps the person's words above it and the quote below, one empty line between", () => {
    expect(placeSignature("Thanks!", SIGNATURE)).toBe(`Thanks!\n\n${BLOCK}`);
    expect(placeSignature("Thanks!\n\n> quoted\n", SIGNATURE)).toBe(
      `Thanks!\n\n${BLOCK}\n\n> quoted\n`,
    );
    const parts = draftSections(`Thanks!\n\n${BLOCK}\n\n\n> quoted\n`);
    expect(parts).toEqual({ own: "Thanks!\n", signature: BLOCK, quote: "> quoted\n" });
    expect(joinSections(parts.own, parts.signature, parts.quote)).toBe(
      `Thanks!\n\n${BLOCK}\n\n> quoted\n`,
    );
  });

  it("only a delimiter above the quote counts; one inside the quote is the other side's", () => {
    const parts = draftSections("Hi\n\nOn 3 Nov, Anna wrote:\n> Bye\n> -- \n> Anna");
    expect(parts.signature).toBe("");
    expect(parts.quote).toBe("On 3 Nov, Anna wrote:\n> Bye\n> -- \n> Anna");
  });
});

describe("changing the sender (rule 5)", () => {
  const start = placeSignature("", "Work signature");

  it("takes the new account's signature while the one put in is untouched", () => {
    expect(followSignature(start, "Work signature", "Home signature")).toBe(
      "\n\n-- \nHome signature",
    );
    // With words above it, they stay as written.
    expect(followSignature(`Hello Anna${start}`, "Work signature", "Home")).toBe(
      "Hello Anna\n\n-- \nHome",
    );
  });

  it("takes it away for an account with none, and puts one in when there was none", () => {
    expect(followSignature(`Hello${start}`, "Work signature", "")).toBe("Hello");
    expect(followSignature("Hello", "", "Home")).toBe("Hello\n\n-- \nHome");
    // Above a forward's part.
    expect(followSignature(`\n\n${FORWARD_MARK}\n`, "", "Home")).toBe(
      `\n\n-- \nHome\n\n${FORWARD_MARK}\n`,
    );
  });

  it("leaves a signature the person changed or deleted alone", () => {
    expect(followSignature(start.replace("Work", "My work"), "Work signature", "Home")).toBeNull();
    expect(followSignature("Hello, no signature", "Work signature", "Home")).toBeNull();
    // The same signature on both: nothing to do.
    expect(followSignature(start, "Work signature", "Work signature")).toBeNull();
  });
});

describe("the agent and the signature (rule 6)", () => {
  it("the signature is set apart from the person's lines and never goes to the model", () => {
    const text = `Thanks, [date] works.\n\n${BLOCK}\n\nOn 3 Nov, Anna wrote:\n> When?`;
    const parts = splitDraft(text);
    expect(parts.own).toBe("Thanks, [date] works.\n");
    expect(parts.signature).toBe(BLOCK);
    const rewrite = buildRewriteRequest(parts.own, "shorter");
    expect(rewrite.untrusted).not.toContain("Sobczak");
    expect(rewrite.instructions).toContain("the app adds the person's own");
    const write = buildWriteRequest({ words: "say yes", subject: "Budget", own: parts.own });
    expect(write.untrusted).not.toContain("Sobczak");
    expect(write.instructions).toContain("the app adds the person's own");
  });

  it("the model's text goes back above the signature, which is there once", () => {
    const parts = splitDraft(`Old words\n\n${BLOCK}\n\nOn 3 Nov, Anna wrote:\n> When?`);
    const joined = joinDraft("New words", parts.quote, parts.signature);
    expect(joined).toBe(`New words\n\n${BLOCK}\n\nOn 3 Nov, Anna wrote:\n> When?`);
    // A model that signed anyway: its block is cut, the person's own stays, once.
    const signed = joinDraft("New words\n\n-- \nAI Assistant", parts.quote, parts.signature);
    expect(signed).toBe(joined);
    expect(signed.split(SIGNATURE_DELIMITER)).toHaveLength(2);
    // `--` without its space, on a line of its own, is a delimiter too.
    expect(withoutSignature("Words\n\n--\nBot")).toBe("Words");
    expect(withoutSignature("--\nBot")).toBe("");
    // Right under a line of text it underlines a Markdown heading: nothing goes.
    expect(withoutSignature("Summary\n--\nTotal: [amount].")).toBe("Summary\n--\nTotal: [amount].");
    expect(joinDraft("Summary\n--\nTotal: [amount].", "")).toBe("Summary\n--\nTotal: [amount].");
    expect(withoutSignature("No block here")).toBe("No block here");
  });

  it("a new message the agent filled in gets the signature from the code", () => {
    expect(placeSignature("Hello Anna,\n\nsee you on [date].", SIGNATURE)).toBe(
      `Hello Anna,\n\nsee you on [date].\n\n${BLOCK}`,
    );
  });

  it("the block's shape: the delimiter, its space, then the lines", () => {
    expect(signatureBlock("")).toBe("");
    expect(signatureBlock("A\nB")).toBe("-- \nA\nB");
  });
});
