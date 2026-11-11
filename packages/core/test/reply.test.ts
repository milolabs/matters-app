import { describe, expect, it } from "vitest";
import type { Message } from "../src/index.ts";
import {
  attribution,
  buildReply,
  formatMessageDate,
  messageKey,
  messageToAnswer,
  normalizeReplyTo,
  quoteLines,
  replyDestination,
  replyPromptTarget,
  replyQuoteText,
  replyRedirect,
  replySubject,
} from "../src/index.ts";

const account = { id: "acc1", address: "me@example.com", displayName: "Miłosz" };

function msg(over: Partial<Message> & { id: string }): Message {
  const dateMs = over.dateMs ?? Date.UTC(2026, 10, 3, 12, 5);
  return {
    key: messageKey(dateMs, 0),
    accountId: "acc1",
    providerId: over.id,
    threadId: "t1",
    messageIdHeader: `<${over.id}@x>`,
    dateMs,
    from: { name: "Anna Kowalska", address: "anna@northwind.example" },
    to: [{ address: "me@example.com" }],
    cc: [],
    subject: "Wycena",
    snippet: "",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown",
    ...over,
  };
}

describe("replySubject", () => {
  it.each([
    ["Wycena", "Re: Wycena"],
    ["Re: Wycena", "Re: Wycena"],
    ["RE: Re: Wycena", "Re: Wycena"],
    ["Odp: Re: Wycena", "Re: Wycena"],
    ["  re:wycena ", "Re: wycena"],
  ])("%s -> %s", (input, out) => expect(replySubject(input)).toBe(out));
});

describe("replyQuoteText", () => {
  it("drops the link addresses of an HTML message's text and squashes empty lines", () => {
    const text =
      "Jeśli nieczytelna, kliknij [https://x.pl/view?a=1]\n\n\n\nLogo [https://x.pl/c]\n[www.x.pl]\nNapisz: [mailto:a@x.pl]  \n\n";
    expect(replyQuoteText(text)).toBe("Jeśli nieczytelna, kliknij\n\nLogo\n\nNapisz:");
  });

  it("keeps brackets that are not links", () => {
    expect(replyQuoteText("Cena [do ustalenia]")).toBe("Cena [do ustalenia]");
  });
});

describe("quoteLines", () => {
  it("prefixes every line and keeps blank ones as a bare marker", () => {
    expect(quoteLines("a\r\n\r\nb\n")).toBe("> a\n>\n> b");
  });
});

describe("buildReply", () => {
  const first = msg({ id: "m1" });
  const second = msg({
    id: "m2",
    dateMs: first.dateMs + 60_000,
    from: { name: "Jan", address: "jan@northwind.example" },
    to: [{ address: "me@example.com" }, { address: "anna@northwind.example" }],
    cc: [{ address: "Boss@Northwind.example" }, { address: "ME@example.com" }],
  });

  it("answers the sender and sets the threading headers", () => {
    const c = buildReply({
      mode: "reply",
      account,
      ownAddresses: [],
      message: second,
      bodyText: "Prosimy o wycenę",
      earlier: [first],
    });
    expect(c.to).toEqual([{ name: "Jan", address: "jan@northwind.example" }]);
    expect(c.cc).toEqual([]);
    expect(c.subject).toBe("Re: Wycena");
    expect(c.inReplyTo).toBe("<m2@x>");
    expect(c.references).toEqual(["<m1@x>", "<m2@x>"]);
    expect(c.threadId).toBe("t1");
    expect(c.bodyMarkdown).toContain("wrote:\n> Prosimy o wycenę");
    expect(c.from).toEqual({ name: "Miłosz", address: "me@example.com" });
  });

  it("reply-all keeps everyone but the user, once", () => {
    const c = buildReply({
      mode: "replyAll",
      account,
      ownAddresses: [],
      message: second,
      bodyText: "x",
      earlier: [first],
    });
    expect(c.to.map((p) => p.address)).toEqual(["jan@northwind.example"]);
    expect(c.cc.map((p) => p.address)).toEqual([
      "anna@northwind.example",
      "Boss@Northwind.example",
    ]);
  });

  it("answering the user's own message goes to its recipients", () => {
    const mine = msg({
      id: "m3",
      from: { address: "me@example.com" },
      to: [{ address: "anna@northwind.example" }],
    });
    const c = buildReply({
      mode: "reply",
      account,
      ownAddresses: [],
      message: mine,
      bodyText: "",
      earlier: [],
    });
    expect(c.to.map((p) => p.address)).toEqual(["anna@northwind.example"]);
    expect(c.bodyMarkdown).toBe("");
  });

  it("excludes the other addresses of the user too", () => {
    const c = buildReply({
      mode: "replyAll",
      account,
      ownAddresses: ["alias@example.com"],
      message: msg({ id: "m4", to: [{ address: "alias@example.com" }, { address: "x@y.pl" }] }),
      bodyText: "",
      earlier: [],
    });
    expect(c.cc.map((p) => p.address)).toEqual(["x@y.pl"]);
  });

  it("keeps the first and the last references of a long thread", () => {
    const earlier = Array.from({ length: 14 }, (_, i) => msg({ id: `e${i}` }));
    const c = buildReply({
      mode: "reply",
      account,
      ownAddresses: [],
      message: second,
      bodyText: "",
      earlier,
    });
    expect(c.references).toHaveLength(10);
    expect(c.references[0]).toBe("<e0@x>");
    expect(c.references.at(-1)).toBe("<m2@x>");
  });
});

describe("normalizeReplyTo (ADR 0042, rule 1)", () => {
  const from = { name: "Anna", address: "anna@northwind.example" };

  it("keeps a list that names someone else, in order", () => {
    const list = [{ address: "help@shop.example" }, { address: "billing@shop.example" }];
    expect(normalizeReplyTo(list, from)).toEqual(list);
  });

  it("turns a list that only names From into none, whatever the case or spaces", () => {
    expect(normalizeReplyTo([{ name: "A", address: " Anna@Northwind.Example " }], from)).toEqual(
      [],
    );
    expect(normalizeReplyTo([from, { address: "ANNA@northwind.example" }], from)).toEqual([]);
  });

  it("keeps a list that names From and someone else", () => {
    const list = [from, { address: "help@shop.example" }];
    expect(normalizeReplyTo(list, from)).toEqual(list);
  });

  it("is none for none, and drops entries without an address", () => {
    expect(normalizeReplyTo([], from)).toEqual([]);
    expect(normalizeReplyTo([{ address: "" }], from)).toEqual([]);
  });

  it("cannot compare with a sender that is not known, and keeps the list", () => {
    expect(normalizeReplyTo([{ address: "a@b.pl" }], undefined)).toEqual([{ address: "a@b.pl" }]);
  });
});

describe("replyDestination and buildReply with Reply-To (ADR 0042, rules 2 to 4)", () => {
  const help = { name: "Shop help", address: "help@shop.example" };
  const sent = (over: Partial<Message> = {}) =>
    msg({
      id: "r1",
      from: { name: "Shop", address: "orders@mailer.example" },
      to: [{ address: "me@example.com" }],
      replyTo: [help],
      ...over,
    });
  const build = (message: Message, mode: "reply" | "replyAll", ownAddresses: string[] = []) =>
    buildReply({ mode, account, ownAddresses, message, bodyText: "", earlier: [] });
  const addresses = (list: readonly { address: string }[]) => list.map((p) => p.address);

  it("reply goes to Reply-To instead of From", () => {
    expect(build(sent(), "reply").to).toEqual([help]);
    expect(replyDestination(sent(), [account.address])).toEqual({ to: [help], redirected: true });
  });

  it("goes to From when Reply-To is absent, empty, or the same as From", () => {
    const from = { name: "Shop", address: "orders@mailer.example" };
    for (const replyTo of [undefined, [], [from], [{ address: "ORDERS@mailer.example" }]]) {
      const message = sent(replyTo === undefined ? { replyTo: undefined } : { replyTo });
      expect(build(message, "reply").to).toEqual([from]);
      expect(replyDestination(message, [account.address]).redirected).toBe(false);
    }
  });

  it("falls back to From when Reply-To is only the user's own address", () => {
    const message = sent({ replyTo: [{ address: "Me@Example.com" }] });
    expect(addresses(build(message, "reply").to)).toEqual(["orders@mailer.example"]);
    expect(replyDestination(message, [account.address]).redirected).toBe(false);
  });

  it("falls back to From when Reply-To is only another address of the user", () => {
    const message = sent({ replyTo: [{ address: "alias@example.com" }] });
    expect(addresses(build(message, "reply", ["alias@example.com"]).to)).toEqual([
      "orders@mailer.example",
    ]);
  });

  it("removes the user's address from Reply-To and keeps the others", () => {
    const message = sent({ replyTo: [{ address: "me@example.com" }, help] });
    expect(build(message, "reply").to).toEqual([help]);
  });

  it("lists a Reply-To address once", () => {
    const message = sent({ replyTo: [help, { address: "HELP@shop.example" }] });
    expect(build(message, "reply").to).toEqual([help]);
  });

  it("reply-all: To as for reply, Cc the message's To and Cc, From not added", () => {
    const message = sent({
      to: [{ address: "me@example.com" }, { address: "team@example.com" }],
      cc: [{ address: "boss@example.com" }],
    });
    const c = build(message, "replyAll");
    expect(c.to).toEqual([help]);
    expect(addresses(c.cc)).toEqual(["team@example.com", "boss@example.com"]);
    expect([...addresses(c.to), ...addresses(c.cc)]).not.toContain("orders@mailer.example");
  });

  it("reply-all: a Reply-To person who is also in To is not duplicated", () => {
    const message = sent({ to: [{ address: "me@example.com" }, help], cc: [help] });
    const c = build(message, "replyAll");
    expect(c.to).toEqual([help]);
    expect(c.cc).toEqual([]);
  });

  it("reply-all keeps From out of Cc when Reply-To replaced it, and in To when it did not", () => {
    const plain = sent({ replyTo: [], to: [{ address: "me@example.com" }, { address: "x@y.pl" }] });
    const c = build(plain, "replyAll");
    expect(addresses(c.to)).toEqual(["orders@mailer.example"]);
    expect(addresses(c.cc)).toEqual(["x@y.pl"]);
  });

  it("reply-all falls back to From, as reply does, when Reply-To is only the user", () => {
    const message = sent({ replyTo: [{ address: "me@example.com" }] });
    expect(addresses(build(message, "replyAll").to)).toEqual(["orders@mailer.example"]);
  });

  it("a reply to the user's own message goes to its To and never reads Reply-To", () => {
    const mine = sent({
      from: { address: "me@example.com" },
      to: [{ address: "anna@northwind.example" }],
      replyTo: [{ address: "elsewhere@example.com" }],
    });
    expect(addresses(build(mine, "reply").to)).toEqual(["anna@northwind.example"]);
    expect(addresses(build(mine, "replyAll").to)).toEqual(["anna@northwind.example"]);
    expect(replyDestination(mine, [account.address]).redirected).toBe(false);
    expect(replyRedirect(mine, [account.address])).toBeNull();
  });

  it("absent and empty Reply-To behave the same way", () => {
    const absent = build(sent({ replyTo: undefined }), "replyAll");
    const empty = build(sent({ replyTo: [] }), "replyAll");
    expect(empty).toEqual(absent);
  });
});

describe("replyRedirect (ADR 0042, rule 5)", () => {
  const own = ["me@example.com"];
  const shop = msg({
    id: "s1",
    from: { address: "orders@mailer.example" },
    replyTo: [{ address: "help@shop.example" }],
  });

  it("says where the reply goes and who sent the message", () => {
    expect(replyRedirect(shop, own)).toEqual({
      to: [{ address: "help@shop.example" }],
      from: { address: "orders@mailer.example" },
      unverified: false,
    });
  });

  it("marks an unverified sender only when the server said fail", () => {
    expect(replyRedirect({ ...shop, senderAuth: "fail" }, own)?.unverified).toBe(true);
    expect(replyRedirect({ ...shop, senderAuth: "unknown" }, own)?.unverified).toBe(false);
    expect(replyRedirect({ ...shop, senderAuth: "pass" }, own)?.unverified).toBe(false);
  });

  it("is null when the reply goes to the sender", () => {
    expect(replyRedirect({ ...shop, replyTo: [] }, own)).toBeNull();
    expect(replyRedirect({ ...shop, replyTo: undefined }, own)).toBeNull();
    expect(replyRedirect({ ...shop, replyTo: [{ address: "me@example.com" }] }, own)).toBeNull();
  });

  it("does not warn about a failing sender when the reply goes to the sender anyway", () => {
    expect(replyRedirect({ ...shop, replyTo: [], senderAuth: "fail" }, own)).toBeNull();
  });
});

describe("the message a reply answers and the reader's prompt (ADR 0042, rule 6)", () => {
  const own = ["me@example.com"];
  const theirs = msg({
    id: "t1",
    dateMs: Date.UTC(2026, 10, 3, 9),
    from: { name: "Shop", address: "orders@mailer.example" },
    replyTo: [{ name: "Shop help", address: "help@shop.example" }],
  });
  const mine = msg({
    id: "t2",
    dateMs: Date.UTC(2026, 10, 3, 10),
    from: { address: "me@example.com" },
    to: [{ address: "help@shop.example" }],
    replyTo: [],
  });

  it("answers the newest message that is not the user's own, else the newest", () => {
    expect(messageToAnswer([theirs, mine], own)).toBe(theirs);
    expect(messageToAnswer([mine], own)).toBe(mine);
    expect(messageToAnswer([], own)).toBeUndefined();
  });

  it("names who the reply goes to, not who sent the message", () => {
    expect(replyPromptTarget([theirs, mine], own)).toEqual({
      name: "Shop help",
      address: "help@shop.example",
    });
  });

  it("names the sender when Reply-To says nothing new", () => {
    expect(replyPromptTarget([{ ...theirs, replyTo: [] }], own)?.address).toBe(
      "orders@mailer.example",
    );
    expect(replyPromptTarget([{ ...theirs, replyTo: undefined }], own)?.address).toBe(
      "orders@mailer.example",
    );
  });

  it("names the first of several Reply-To addresses", () => {
    const several = { ...theirs, replyTo: [{ address: "a@x.pl" }, { address: "b@x.pl" }] };
    expect(replyPromptTarget([several], own)?.address).toBe("a@x.pl");
  });

  it("is undefined for an empty thread, and the recipient for a thread of one's own mail", () => {
    expect(replyPromptTarget([], own)).toBeUndefined();
    expect(replyPromptTarget([mine], own)?.address).toBe("help@shop.example");
  });
});

describe("attribution (ADR 0045 rule 5, ADR 0048)", () => {
  const DATE_MS = Date.UTC(2026, 10, 3, 10, 29);
  const WHEN = formatMessageDate(DATE_MS);
  const at = (name: string | undefined, address = "orig@example.org") =>
    attribution({
      from: name === undefined ? { address } : { name, address },
      dateMs: DATE_MS,
    });

  it("writes an ordinary name as it is, with no backslash", () => {
    for (const name of [
      "Anna Kowalska",
      "O'Brien, Jan (Acme Ltd.)",
      "Smith & Sons",
      "Dr. Müller-Lüdenscheidt",
      "Zażółć Gęślą",
      "snake_case name",
      "Anna - Acme / Sales",
      "AT&T Billing",
      '"Quoted" Name',
    ]) {
      expect(at(name)).toBe(`On ${WHEN}, ${name} wrote:`);
    }
  });

  it("writes an address with its @, whether it stands in for the name or is the name", () => {
    expect(at(undefined, "anna@example.com")).toBe(`On ${WHEN}, anna@example.com wrote:`);
    expect(at("", "anna@example.com")).toBe(`On ${WHEN}, anna@example.com wrote:`);
    expect(at("anna@example.com", "anna@example.com")).toBe(`On ${WHEN}, anna@example.com wrote:`);
  });

  it("escapes what Markdown or the renderer would turn into a link or a format", () => {
    expect(at("[Click here](https://example.org/x)")).toBe(
      `On ${WHEN}, \\[Click here\\](https\\://example.org/x) wrote:`,
    );
    expect(at("*bold* <b>")).toBe(`On ${WHEN}, \\*bold\\* \\<b\\> wrote:`);
    expect(at("pay@evil.example")).toBe(`On ${WHEN}, pay\\@evil.example wrote:`);
  });

  it("keeps a name on one line", () => {
    expect(at("Anna\nBcc: x")).toBe(`On ${WHEN}, Anna Bcc: x wrote:`);
  });
});
