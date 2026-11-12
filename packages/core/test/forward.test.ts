import { describe, expect, it } from "vitest";
import { escapeAddress } from "../src/domain/markdownEscape.ts";
import type { Message } from "../src/index.ts";
import {
  buildForward,
  canonicalDraft,
  escapeMarkdown,
  FORWARD_AS_TEXT,
  FORWARD_MARK,
  FORWARD_UNKNOWN_FILES,
  fingerprintOf,
  forwardHeader,
  forwardNotices,
  forwardSubject,
  messageKey,
  messageToForward,
  ownWords,
  prepareForwardDraft,
} from "../src/index.ts";
import { content, QUICK_MS, sha256, timed } from "./support.ts";

const account = { id: "acc1", address: "me@example.com", displayName: "Miłosz Sobczak" };

/** 3 Nov 2026, 10:29 in whatever zone the test runs in: the date is formatted as the user sees it. */
const NOV_3 = new Date(2026, 10, 3, 10, 29).getTime();

function msg(over: Partial<Message> & { id: string }): Message {
  const dateMs = over.dateMs ?? NOV_3;
  return {
    key: messageKey(dateMs, 0),
    accountId: "acc1",
    providerId: over.id,
    threadId: "t1",
    messageIdHeader: `<${over.id}@x>`,
    dateMs,
    from: { name: "Anna Nowak", address: "anna@example.com" },
    to: [{ name: "Miłosz Sobczak", address: "milosz@example.com" }],
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

describe("forwardSubject (rule 3)", () => {
  it.each([
    ["Budget", "Fwd: Budget"],
    ["Fwd: Budget", "Fwd: Budget"],
    ["FW: Budget", "Fwd: Budget"],
    ["Fw: Budget", "Fwd: Budget"],
    ["fwd: budget", "Fwd: budget"],
    ["FWD: Budget", "Fwd: Budget"],
    ["PD: Budget", "Fwd: Budget"],
    ["pd: Budget", "Fwd: Budget"],
    ["WG: Budget", "Fwd: Budget"],
    ["wg: Budget", "Fwd: Budget"],
    // chains, in any mix
    ["Fwd: Fwd: Budget", "Fwd: Budget"],
    ["FW: PD: WG: Fwd: Budget", "Fwd: Budget"],
    ["Fwd:Fwd:Budget", "Fwd: Budget"],
    ["  Fwd :  Budget  ", "Fwd: Budget"],
    ["Fwd[2]: Budget", "Fwd: Budget"],
    // Re: stays, since "Fwd: Re: Budget" says what it is
    ["Re: Budget", "Fwd: Re: Budget"],
    ["Fwd: Re: Budget", "Fwd: Re: Budget"],
    ["Fwd:Re: Budget", "Fwd: Re: Budget"],
    ["FW: RE: Budget", "Fwd: RE: Budget"],
    ["Re: Fwd: Budget", "Fwd: Re: Fwd: Budget"],
    // only a prefix that ends in a colon is one
    ["Forward the budget", "Fwd: Forward the budget"],
    ["Fwdx: Budget", "Fwd: Fwdx: Budget"],
    ["PDF: Budget", "Fwd: PDF: Budget"],
    // nothing to carry
    ["", "Fwd:"],
    ["   ", "Fwd:"],
    ["Fwd:", "Fwd:"],
    ["FW: FW:", "Fwd:"],
    ["PD [2] :\t WG\t: Budget", "Fwd: Budget"],
  ])("%j -> %j", (input, out) => expect(forwardSubject(input)).toBe(out));

  it("takes linear time on a long run of white space that ends in no colon", () => {
    const subject = `pd${"\t".repeat(50_000)}x`;
    const { result, ms } = timed(() => forwardSubject(subject));
    expect(result).toBe(`Fwd: ${subject}`);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});

describe("escapeMarkdown (rule 5)", () => {
  it("leaves an ordinary name and address as they are", () => {
    expect(escapeMarkdown("Anna Nowak-Kowalska (Biuro)")).toBe("Anna Nowak-Kowalska (Biuro)");
    expect(escapeMarkdown("first_last")).toBe("first_last");
    expect(escapeMarkdown("AT&T")).toBe("AT&T");
  });

  it.each([
    ["[Click here](https://evil.example)", "\\[Click here\\](https\\://evil.example)"],
    ["*x*", "\\*x\\*"],
    ["_x_", "\\_x\\_"],
    ["`code`", "\\`code\\`"],
    ["<b>bold</b>", "\\<b\\>bold\\</b\\>"],
    ["<https://evil.example>", "\\<https\\://evil.example\\>"],
    ["evil@phish.example", "evil\\@phish.example"],
    ["www.evil.example", "www.evil.example"],
    ["~~gone~~", "\\~\\~gone\\~\\~"],
    ["back\\slash", "back\\\\slash"],
    ["&amp; &#35; &copy;", "\\&amp; \\&#35; \\&copy;"],
    ["# heading", "# heading"],
    ["> quote", "\\> quote"],
    ["a\nb\r\nc\td", "a b c d"],
  ])("%j -> %j", (input, out) => expect(escapeMarkdown(input)).toBe(out));

  it("keeps an underscore inside a word and escapes one that could open emphasis", () => {
    expect(escapeMarkdown("snake_case_name")).toBe("snake_case_name");
    expect(escapeMarkdown("_lead")).toBe("\\_lead");
    expect(escapeMarkdown("trail_")).toBe("trail\\_");
    expect(escapeMarkdown("a _b_ c")).toBe("a \\_b\\_ c");
  });

  it("escapes a backslash too, so one in the text cannot cancel an added escape", () => {
    // `\@` must become `\\\@` (a backslash, then an escaped `@`), never `\\@`.
    expect(escapeMarkdown(String.raw`a\@b.example`)).toBe(String.raw`a\\\@b.example`);
    expect(escapeMarkdown(String.raw`\[x](https://evil.example)`)).toBe(
      String.raw`\\\[x\](https\://evil.example)`,
    );
    expect(escapeAddress(String.raw`a\b@c.example`)).toBe(String.raw`a\\b@c.example`);
  });
});

describe("forwardHeader (rule 4)", () => {
  it("is a line each, in the order From, Date, Subject, To", () => {
    expect(forwardHeader(msg({ id: "m" }))).toEqual([
      "Forwarded message",
      "From: Anna Nowak (anna@example.com)",
      "Date: 3 Nov 2026, 10:29",
      "Subject: Budget",
      "To: Miłosz Sobczak (milosz@example.com)",
    ]);
  });

  it("has a Cc line, after To, only when someone is in it", () => {
    const withCc = forwardHeader(
      msg({
        id: "m",
        cc: [{ name: "Jan", address: "jan@example.com" }, { address: "ola@example.com" }],
      }),
    );
    expect(withCc.at(-1)).toBe("Cc: Jan (jan@example.com), ola@example.com");
    expect(withCc.filter((l) => l.startsWith("To:"))).toHaveLength(1);
    expect(forwardHeader(msg({ id: "m" })).some((l) => l.startsWith("Cc:"))).toBe(false);
  });

  it("never mentions Bcc", () => {
    expect(forwardHeader(msg({ id: "m", cc: [{ address: "a@b.c" }] })).join("\n")).not.toMatch(
      /bcc/i,
    );
  });

  it("shows a bare address for a sender with no name, or whose name is the address", () => {
    expect(forwardHeader(msg({ id: "m", from: { address: "a@b.example" } }))[1]).toBe(
      "From: a@b.example",
    );
    expect(
      forwardHeader(msg({ id: "m", from: { name: "a@b.example", address: "a@b.example" } }))[1],
    ).toBe("From: a@b.example");
  });

  it("escapes every name, the subject and the addresses", () => {
    const lines = forwardHeader(
      msg({
        id: "m",
        from: { name: "[Click here](https://evil.example)", address: "x@y.example" },
        to: [{ name: "*boss*", address: "boss@y.example" }],
        subject: "_Urgent_ `now`",
      }),
    );
    expect(lines[1]).toBe("From: \\[Click here\\](https\\://evil.example) (x@y.example)");
    expect(lines[3]).toBe("Subject: \\_Urgent\\_ \\`now\\`");
    expect(lines[4]).toBe("To: \\*boss\\* (boss@y.example)");
  });

  it("keeps an address as it is, apart from what could close a bracket early", () => {
    const [, from] = forwardHeader(
      msg({ id: "m", from: { address: "anna.nowak+faktury@example.com" } }),
    );
    expect(from).toBe("From: anna.nowak+faktury@example.com");
    const [, odd] = forwardHeader(msg({ id: "m", from: { name: "A", address: "a>b@c.example" } }));
    expect(odd).toBe("From: A (a\\>b@c.example)");
  });

  it("says (no subject) for a message without one", () => {
    expect(forwardHeader(msg({ id: "m", subject: "  " }))[3]).toBe("Subject: (no subject)");
  });

  it("a header cannot start a new line with anything a reader would act on", () => {
    const lines = forwardHeader(msg({ id: "m", subject: "line one\n# heading\n> quote\n- item" }));
    expect(lines[3]).toBe("Subject: line one # heading \\> quote - item");
    expect(lines).toHaveLength(5);
  });
});

describe("buildForward (rules 1, 2, 4, 5)", () => {
  const original = msg({ id: "m1" });

  it("has no recipients, no threading headers and no thread", () => {
    const draft = buildForward({ account, message: original, bodyText: "Hello" });
    expect(draft.to).toEqual([]);
    expect(draft.cc).toEqual([]);
    expect(draft.bcc).toEqual([]);
    expect(draft.inReplyTo).toBe("");
    expect(draft.references).toEqual([]);
    expect(draft.threadId).toBeUndefined();
    expect("threadId" in draft).toBe(false);
    expect(draft.forwarded).toBe(true);
    expect(draft.accountId).toBe("acc1");
    expect(draft.from).toEqual({ name: "Miłosz Sobczak", address: "me@example.com" });
  });

  it("starts with the person's own words empty, then quotes the message", () => {
    const draft = buildForward({
      account,
      message: original,
      bodyText: "The text of the message.",
    });
    expect(draft.bodyMarkdown).toBe(
      [
        "",
        "",
        "> Forwarded message",
        "> From: Anna Nowak (anna@example.com)",
        "> Date: 3 Nov 2026, 10:29",
        "> Subject: Budget",
        "> To: Miłosz Sobczak (milosz@example.com)",
        ">",
        "> The text of the message.",
        "",
      ].join("\n"),
    );
    expect(ownWords(draft.bodyMarkdown)).toBe("");
  });

  it("keeps the quoting replies have for a body of several paragraphs", () => {
    const draft = buildForward({
      account,
      message: original,
      bodyText: "one\r\n\r\ntwo\nthree\n\n",
    });
    expect(draft.bodyMarkdown.endsWith("\n>\n> one\n>\n> two\n> three\n")).toBe(true);
  });

  it("with an empty body, quotes the header only", () => {
    for (const bodyText of ["", "  \n\n"]) {
      const draft = buildForward({ account, message: original, bodyText });
      expect(draft.bodyMarkdown.endsWith("> To: Miłosz Sobczak (milosz@example.com)\n")).toBe(true);
      expect(draft.bodyMarkdown).not.toMatch(/\n>\n/);
    }
  });

  it("puts one Fwd: on the subject whatever it was", () => {
    expect(
      buildForward({ account, message: msg({ id: "m", subject: "FW: Re: X" }), bodyText: "" })
        .subject,
    ).toBe("Fwd: Re: X");
  });

  it("is not the same draft as a reply to the same message, in its fingerprint", () => {
    const forward = buildForward({ account, message: original, bodyText: "x" });
    expect(forward.inReplyTo).toBe("");
    expect(fingerprintOf(forward, sha256)).not.toBe(fingerprintOf(content(), sha256));
  });
});

describe("the forwarded flag stays out of the fingerprint", () => {
  it("is not in the canonical form, set or not", () => {
    expect(canonicalDraft(content({ forwarded: true }))).toBe(canonicalDraft(content()));
    expect(fingerprintOf(content({ forwarded: true }), sha256)).toBe(
      fingerprintOf(content(), sha256),
    );
  });
});

describe("messageToForward (rule 1)", () => {
  const first = msg({ id: "m1", dateMs: NOV_3 });
  const second = msg({ id: "m2", dateMs: NOV_3 + 60_000 });
  const trashed = msg({ id: "m3", dateMs: NOV_3 + 120_000, mailboxes: 8 });
  const spam = msg({ id: "m4", dateMs: NOV_3 + 180_000, mailboxes: 16 });
  const thread = [first, second, trashed, spam];

  it("is the newest of a long thread", () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `n${i}`, dateMs: NOV_3 + i * 1000 }),
    );
    expect(messageToForward(long, false)?.providerId).toBe("n39");
  });

  it("skips Trash and Spam", () => {
    expect(messageToForward(thread, false)?.providerId).toBe("m2");
  });

  it("takes them when the thread is looked at from there", () => {
    expect(messageToForward(thread, true)?.providerId).toBe("m4");
  });

  it("is the user's own message when that is the newest", () => {
    const mine = msg({ id: "mine", dateMs: NOV_3 + 5000, from: { address: "me@example.com" } });
    expect(messageToForward([first, mine], false)?.providerId).toBe("mine");
  });

  it("is nothing when everything is deleted, and nothing for an empty thread", () => {
    expect(messageToForward([trashed, spam], false)).toBeUndefined();
    expect(messageToForward([], false)).toBeUndefined();
  });

  it("does not reorder the list it was given", () => {
    const copy = [...thread];
    messageToForward(thread, false);
    expect(thread).toEqual(copy);
  });
});

describe("ownWords (rule 13)", () => {
  const quote = `${FORWARD_MARK}\n> From: A <a@b.c>\n> text`;
  it.each([
    ["", ""],
    ["\n\n", ""],
    [`\n\n${quote}\n`, ""],
    [`   \n${quote}`, ""],
    [`Hi Jan,\n\nSee below.\n\n${quote}\n`, "Hi Jan,\n\nSee below."],
    ["only my words", "only my words"],
    // the quote edited or cut down does not make it the person's words
    [`\n\n${FORWARD_MARK}\n> text only\n`, ""],
    [`\n\n> Forwarded message\n`, ""],
  ])("%j -> %j", (body, words) => expect(ownWords(body)).toBe(words));

  it("counts everything as written once the mark itself is gone", () => {
    expect(ownWords("> From: A <a@b.c>\n> text")).toBe("> From: A <a@b.c>\n> text");
  });
});

describe("forwardNotices (rules 11 and 12)", () => {
  it("says nothing for a plain message with its files known", () => {
    expect(forwardNotices({ attachmentsKnown: true, hasInline: false })).toEqual([]);
    expect(
      forwardNotices({ attachmentsKnown: true, htmlKind: "simple", hasInline: false }),
    ).toEqual([]);
  });

  it("says the files are not known yet, in one line", () => {
    expect(forwardNotices({ attachmentsKnown: false, hasInline: false })).toEqual([
      "The attachments of this message aren't known yet, so they weren't added.",
    ]);
    expect(FORWARD_UNKNOWN_FILES).toBe(
      "The attachments of this message aren't known yet, so they weren't added.",
    );
  });

  it("says a designed layout stays behind", () => {
    expect(
      forwardNotices({ attachmentsKnown: true, htmlKind: "designed", hasInline: false }),
    ).toEqual(["Forwarded as text. Its layout and inline images stay behind."]);
    expect(FORWARD_AS_TEXT).toBe("Forwarded as text. Its layout and inline images stay behind.");
  });

  it("says it for inline parts too, even in a simple message", () => {
    expect(forwardNotices({ attachmentsKnown: true, htmlKind: "simple", hasInline: true })).toEqual(
      [FORWARD_AS_TEXT],
    );
    expect(forwardNotices({ attachmentsKnown: true, hasInline: true })).toEqual([FORWARD_AS_TEXT]);
  });

  it("says each thing once, whatever combination", () => {
    expect(
      forwardNotices({ attachmentsKnown: false, htmlKind: "designed", hasInline: true }),
    ).toEqual([FORWARD_UNKNOWN_FILES, FORWARD_AS_TEXT]);
  });
});

describe("prepareForwardDraft", () => {
  const first = msg({ id: "m1", dateMs: NOV_3 });
  const second = msg({ id: "m2", dateMs: NOV_3 + 60_000, subject: "Re: Budget" });
  const trashed = msg({ id: "m3", dateMs: NOV_3 + 120_000, mailboxes: 8, subject: "Gone" });
  const asked: { threadId: string; visibleOnly: boolean | undefined }[] = [];

  function deps(messages: Message[], accounts = [account]) {
    return {
      accounts: {
        list: async () => accounts.map((a) => ({ ...a, imap: {} as never, createdAtMs: 0 })),
      },
      store: {
        getThread: async (threadId: string, options?: { visibleOnly?: boolean }) => {
          asked.push({ threadId, visibleOnly: options?.visibleOnly });
          const shown = options?.visibleOnly
            ? messages.filter((m) => ((m.mailboxes ?? 0) & 24) === 0)
            : messages;
          return shown.length === 0
            ? null
            : {
                thread: { id: threadId, accountId: "acc1" } as never,
                messages: shown,
                attachments: new Map(),
              };
        },
      },
      bodies: {
        getBodies: async (keys: readonly number[]) =>
          new Map(keys.map((k) => [k, `body of ${k === second.key ? "second" : "other"}`])),
      },
    };
  }

  it("quotes the newest message that is not deleted, and names its key", async () => {
    const prepared = await prepareForwardDraft(deps([first, second, trashed]), "t1", false);
    expect(prepared?.messageKey).toBe(second.key);
    expect(prepared?.content.subject).toBe("Fwd: Re: Budget");
    expect(prepared?.content.bodyMarkdown).toContain("> body of second");
    expect(prepared?.existing).toBeNull();
    expect(prepared?.redirect).toBeNull();
    expect(asked.at(-1)).toEqual({ threadId: "t1", visibleOnly: true });
  });

  it("takes the deleted one when the thread is viewed from Trash", async () => {
    const prepared = await prepareForwardDraft(deps([first, second, trashed]), "t1", true);
    expect(prepared?.messageKey).toBe(trashed.key);
    expect(prepared?.content.subject).toBe("Fwd: Gone");
    expect(asked.at(-1)).toEqual({ threadId: "t1", visibleOnly: false });
  });

  it("is null when there is nothing to forward", async () => {
    expect(await prepareForwardDraft(deps([trashed]), "t1", false)).toBeNull();
    expect(await prepareForwardDraft(deps([]), "t1", true)).toBeNull();
  });
});
