import { MAILBOX_BIT } from "@matters/core";
import { describe, expect, it } from "vitest";
import { displayName, isReallyOwn, letterDate, senderName } from "../src/renderer/format.ts";

describe("displayName (ADR 0048)", () => {
  it("leaves an ordinary name alone, and falls back to the address", () => {
    expect(displayName({ name: "Anna Kowalska", address: "anna@example.com" })).toBe(
      "Anna Kowalska",
    );
    expect(displayName({ name: "Müller, Jörg (Acme Ltd.)", address: "j@example.com" })).toBe(
      "Müller, Jörg (Acme Ltd.)",
    );
    expect(displayName({ address: "anna@example.com" })).toBe("anna@example.com");
    expect(displayName({ name: "", address: "anna@example.com" })).toBe("anna@example.com");
  });

  it("leaves a name that is the participant's own address alone, in any case", () => {
    expect(displayName({ name: "anna@example.com", address: "anna@example.com" })).toBe(
      "anna@example.com",
    );
    expect(displayName({ name: "Anna@Example.com", address: "anna@example.COM" })).toBe(
      "Anna@Example.com",
    );
    expect(displayName({ name: "Anna (anna@example.com)", address: "anna@example.com" })).toBe(
      "Anna (anna@example.com)",
    );
  });

  it("shows the real address when the name holds another one", () => {
    expect(displayName({ name: "admin@example.org", address: "attacker@example.net" })).toBe(
      "admin@example.org <attacker@example.net>",
    );
    expect(
      displayName({ name: "Admin <admin@example.org>", address: "attacker@example.net" }),
    ).toBe("Admin <admin@example.org> <attacker@example.net>");
    expect(
      displayName({ name: "anna@example.com, admin@example.org", address: "anna@example.com" }),
    ).toBe("anna@example.com, admin@example.org <anna@example.com>");
  });

  it("strips bidirectional controls, so a name cannot reorder what is around it", () => {
    const controls = "‎‏‪‫‬‭‮⁦⁧⁨⁩";
    expect(displayName({ name: `${controls}Anna${controls}`, address: "a@example.com" })).toBe(
      "Anna",
    );
    // A reversed address under an override is still an address once the override is gone.
    expect(displayName({ name: "‮moc.elpmaxe@nimda‬", address: "attacker@example.net" })).toBe(
      "moc.elpmaxe@nimda <attacker@example.net>",
    );
    expect(displayName({ name: "‮‬", address: "a@example.com" })).toBe("a@example.com");
  });

  it("keeps the joiners that real names need", () => {
    const persian = "می‌خواهم";
    expect(displayName({ name: persian, address: "a@example.com" })).toBe(persian);
    const arabic = "محمد ‍علي";
    expect(displayName({ name: arabic, address: "a@example.com" })).toBe(arabic);
    expect(displayName({ name: "ক্‍ষ", address: "a@example.com" })).toBe("ক্‍ষ");
  });
});

describe("senderName: who the reader's own mail is (ADR 0048)", () => {
  const own = new Set(["me@example.com"]);
  const me = { name: "Me", address: "Me@Example.com" };
  const other = { name: "Piotr", address: "piotr@example.org" };

  it("reads You for a message the server vouched for", () => {
    expect(senderName({ from: me, senderAuth: "pass" }, own)).toBe("You");
  });

  it("reads You for the reader's own mail in Sent or Drafts, which has no verdict", () => {
    expect(senderName({ from: me, senderAuth: "unknown", mailboxes: MAILBOX_BIT.sent }, own)).toBe(
      "You",
    );
    expect(
      senderName({ from: me, senderAuth: "unknown", mailboxes: MAILBOX_BIT.drafts }, own),
    ).toBe("You");
    // Gmail keeps a copy in All mail and in Sent at once.
    expect(
      senderName(
        { from: me, senderAuth: "unknown", mailboxes: MAILBOX_BIT.sent | MAILBOX_BIT.archive },
        own,
      ),
    ).toBe("You");
  });

  it("does not read You for mail that only claims the reader's address", () => {
    expect(senderName({ from: me, senderAuth: "unknown" }, own)).toBe("Me");
    expect(senderName({ from: me, senderAuth: "fail", mailboxes: MAILBOX_BIT.inbox }, own)).toBe(
      "Me",
    );
    expect(senderName({ from: { address: "me@example.com" }, senderAuth: "unknown" }, own)).toBe(
      "me@example.com",
    );
  });

  it("names anyone else as displayName does", () => {
    expect(senderName({ from: other, senderAuth: "pass" }, own)).toBe("Piotr");
    expect(senderName({ from: other, senderAuth: "unknown" }, own)).toBe("Piotr");
  });

  it("is really own only with a pass or in Sent or Drafts", () => {
    expect(isReallyOwn({ senderAuth: "pass" })).toBe(true);
    expect(isReallyOwn({ senderAuth: "unknown", mailboxes: MAILBOX_BIT.inbox })).toBe(false);
    expect(isReallyOwn({ senderAuth: "unknown", mailboxes: MAILBOX_BIT.trash })).toBe(false);
    expect(isReallyOwn({ senderAuth: "unknown" })).toBe(false);
  });
});

describe("letterDate", () => {
  const now = new Date(2026, 10, 9, 12, 0).getTime();

  it("leaves the year out for this year's mail", () => {
    expect(letterDate(new Date(2026, 9, 31, 16, 24).getTime(), now)).toBe("31 Oct, 16:24");
  });

  it("says the year for mail from another year", () => {
    expect(letterDate(new Date(2017, 9, 3, 12, 20).getTime(), now)).toBe("3 Oct 2017, 12:20");
    expect(letterDate(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe("31 Dec 2025, 23:59");
  });
});
