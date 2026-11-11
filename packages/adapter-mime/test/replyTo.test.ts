import { describe, expect, it } from "vitest";
import { PostalMimeParser } from "../src/index.ts";

const parser = new PostalMimeParser();

async function replyToOf(...extra: string[]) {
  const lines = [
    "From: Shop <orders@mailer.example>",
    "To: me@example.com",
    "Subject: Order",
    "Date: Tue, 03 Nov 2026 09:30:00 +0100",
    "Message-ID: <r@mailer.example>",
    ...extra,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Thanks.",
  ];
  return (await parser.parse(new TextEncoder().encode(`${lines.join("\r\n")}\r\n`))).replyTo;
}

describe("Reply-To (ADR 0042)", () => {
  it("is empty when the header is absent", async () => {
    expect(await replyToOf()).toEqual([]);
  });

  it("reads one address, with its name", async () => {
    expect(await replyToOf("Reply-To: Shop help <help@shop.example>")).toEqual([
      { name: "Shop help", address: "help@shop.example" },
    ]);
  });

  it("reads a bare address", async () => {
    expect(await replyToOf("Reply-To: help@shop.example")).toEqual([
      { address: "help@shop.example" },
    ]);
  });

  it("reads several addresses in order", async () => {
    expect(
      await replyToOf('Reply-To: "Help, Shop" <help@shop.example>, billing@shop.example'),
    ).toEqual([
      { name: "Help, Shop", address: "help@shop.example" },
      { address: "billing@shop.example" },
    ]);
  });

  it("reads the members of group syntax", async () => {
    expect(await replyToOf("Reply-To: Support: a@shop.example, Bea <b@shop.example>;")).toEqual([
      { address: "a@shop.example" },
      { name: "Bea", address: "b@shop.example" },
    ]);
  });

  it("reads a name written as an encoded word", async () => {
    expect(
      await replyToOf("Reply-To: =?UTF-8?Q?Pomoc_=C5=81=C4=85ka?= <pomoc@laka.example>"),
    ).toEqual([{ name: "Pomoc Łąka", address: "pomoc@laka.example" }]);
  });

  it("is empty for a header that holds no address", async () => {
    expect(await replyToOf("Reply-To: ")).toEqual([]);
    expect(await replyToOf("Reply-To: not an address")).toEqual([]);
    expect(await replyToOf("Reply-To: <>")).toEqual([]);
  });

  it("keeps the addresses that can be read out of a malformed header", async () => {
    expect(await replyToOf("Reply-To: help@shop.example, ,, <")).toEqual([
      { address: "help@shop.example" },
    ]);
  });

  it("is empty when it only names From, in any case", async () => {
    expect(await replyToOf("Reply-To: orders@mailer.example")).toEqual([]);
    expect(await replyToOf("Reply-To: Orders@Mailer.EXAMPLE")).toEqual([]);
    expect(await replyToOf("Reply-To: Someone Else <ORDERS@mailer.example>")).toEqual([]);
  });

  it("keeps a list that names From and someone else", async () => {
    expect(await replyToOf("Reply-To: orders@mailer.example, help@shop.example")).toEqual([
      { address: "orders@mailer.example" },
      { address: "help@shop.example" },
    ]);
  });

  it("keeps an address that only looks like From", async () => {
    expect(await replyToOf("Reply-To: orders@mailer.example.evil.example")).toEqual([
      { address: "orders@mailer.example.evil.example" },
    ]);
  });
});
