import type { Participant } from "@matters/core";
import { MAILBOX_BIT } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  counterpart,
  failedBadge,
  type HeadMessage,
  rowPerson,
  verifiedBadge,
} from "../src/renderer/senderHeader.ts";

const me = { name: "Me", address: "me@example.com" };
const anna: Participant = { name: "Anna Nowak", address: "anna@firma.pl" };
const piotr: Participant = { name: "Piotr", address: "piotr@inna.pl" };
const own = new Set(["me@example.com"]);

const msg = (
  from: Participant,
  to: Participant[] = [],
  extra: Partial<HeadMessage> = {},
): HeadMessage => ({ from, to, cc: [], senderAuth: "unknown", ...extra });

describe("counterpart (ADR 0078)", () => {
  it("is the sender of the newest message that is not the person's own", () => {
    const c = counterpart(
      [
        msg(anna, [me], { senderAuth: "pass" }),
        msg(piotr, [me]),
        msg(me, [anna], { senderAuth: "pass" }),
      ],
      own,
    );
    expect(c?.role).toBe("sender");
    expect(c?.person.address).toBe("piotr@inna.pl");
    expect(c?.verified).toBe(false);
  });

  it("is the first person written to when every message is the person's own", () => {
    const c = counterpart(
      [msg(me, [me, anna], { senderAuth: "pass" }), msg(me, [piotr], { senderAuth: "pass" })],
      own,
    );
    expect(c?.role).toBe("recipient");
    expect(c?.person.address).toBe("anna@firma.pl");
    expect(c?.verified).toBe(false);
  });

  it("counts a message that only claims the person's address as someone else's", () => {
    const c = counterpart([msg(me, [anna])], own);
    expect(c?.role).toBe("sender");
    expect(c?.person.address).toBe("me@example.com");
  });

  it("reads a Sent message as the person's own even when the server said nothing", () => {
    const sent = msg(me, [anna], { mailboxes: MAILBOX_BIT.sent });
    expect(counterpart([sent], own)?.person.address).toBe("anna@firma.pl");
  });

  it("falls back to the person when nobody else is in the thread", () => {
    const c = counterpart([msg(me, [], { senderAuth: "pass" })], own);
    expect(c?.role).toBe("self");
    expect(counterpart([], own)).toBeUndefined();
  });
});

describe("verifiedBadge (ADR 0078)", () => {
  const sender = (senderAuth: HeadMessage["senderAuth"]) =>
    counterpart([msg(anna, [me], { senderAuth })], own) as NonNullable<
      ReturnType<typeof counterpart>
    >;

  it("shows only when the authentication result is a pass", () => {
    expect(verifiedBadge(sender("pass"))).toBe("Verified · firma.pl");
    expect(verifiedBadge(sender("fail"))).toBeNull();
    expect(verifiedBadge(sender("unknown"))).toBeNull();
  });

  it("never shows for someone the person wrote to", () => {
    const c = counterpart([msg(me, [anna], { senderAuth: "pass" })], own);
    expect(verifiedBadge(c as NonNullable<typeof c>)).toBeNull();
  });
});

describe("failedBadge (ADR 0079)", () => {
  const sender = (senderAuth: HeadMessage["senderAuth"], from: Participant = anna) =>
    counterpart([msg(from, [me], { senderAuth })], own) as NonNullable<
      ReturnType<typeof counterpart>
    >;

  it("warns only when the authentication result is a fail", () => {
    expect(failedBadge(sender("fail"))).toBe("Not verified · firma.pl");
    expect(failedBadge(sender("pass"))).toBeNull();
    expect(failedBadge(sender("unknown"))).toBeNull();
  });

  it("names the domain the mail claims, so a copied name next to a stranger's domain shows", () => {
    const fake: Participant = { name: "iPKO - biznes", address: "powiadomienia@ipko-biznes.co" };
    expect(failedBadge(sender("fail", fake))).toBe("Not verified · ipko-biznes.co");
  });

  it("never warns about someone the person wrote to", () => {
    const c = counterpart([msg(me, [anna], { mailboxes: MAILBOX_BIT.sent })], own);
    expect(c?.role).toBe("recipient");
    expect(failedBadge(c as NonNullable<typeof c>)).toBeNull();
  });

  it("warns about mail that claims the person's own address and failed", () => {
    // Not the person's own by ADR 0048 (no pass, no Sent folder): a stranger using their address.
    const c = counterpart([msg(me, [anna], { senderAuth: "fail" })], own);
    expect(c?.role).toBe("sender");
    expect(failedBadge(c as NonNullable<typeof c>)).toBe("Not verified · example.com");
  });
});

describe("rowPerson", () => {
  it("shows the sender of incoming mail", () => {
    const r = rowPerson(msg(anna, [me]), own);
    expect(r.name).toBe("Anna Nowak");
    expect(r.mark.initials).toBe("AN");
  });

  it("shows who the person's own mail went to, with an arrow", () => {
    const r = rowPerson(msg(me, [me, piotr], { senderAuth: "pass" }), own);
    expect(r.name).toBe("→ Piotr");
    expect(r.mark.tint).toBe(rowPerson(msg(piotr, [me]), own).mark.tint);
  });

  it("shows the person when nobody else is addressed", () => {
    expect(rowPerson(msg(me, [], { senderAuth: "pass" }), own).name).toBe("Me");
  });
});
