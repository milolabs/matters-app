import { describe, expect, it } from "vitest";
import { PostalMimeParser } from "../src/index.ts";

const parser = new PostalMimeParser();

async function automatedWith(...extra: string[]) {
  const lines = [
    "From: Shop <orders@mailer.example>",
    "To: me@example.com",
    "Subject: Order",
    "Date: Tue, 03 Nov 2026 09:30:00 +0100",
    "Message-ID: <a@mailer.example>",
    ...extra,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Thanks.",
  ];
  return (await parser.parse(new TextEncoder().encode(`${lines.join("\r\n")}\r\n`))).automated;
}

describe("automated mail (ADR 0052, rule 4)", () => {
  it("is false for a message from a person", async () => {
    expect(await automatedWith()).toBe(false);
  });

  it("is true with List-Unsubscribe or List-Id", async () => {
    expect(await automatedWith("List-Unsubscribe: <mailto:u@mailer.example>")).toBe(true);
    expect(await automatedWith("List-Id: <news.mailer.example>")).toBe(true);
  });

  it("is true for Auto-Submitted unless it says no", async () => {
    expect(await automatedWith("Auto-Submitted: auto-generated")).toBe(true);
    expect(await automatedWith("Auto-Submitted: auto-replied")).toBe(true);
    expect(await automatedWith("Auto-Submitted: no")).toBe(false);
    expect(await automatedWith("Auto-Submitted: NO")).toBe(false);
  });

  it("is true for Precedence bulk, list and junk, in any case, and false otherwise", async () => {
    expect(await automatedWith("Precedence: bulk")).toBe(true);
    expect(await automatedWith("Precedence: List")).toBe(true);
    expect(await automatedWith("Precedence: JUNK")).toBe(true);
    expect(await automatedWith("Precedence: first-class")).toBe(false);
  });

  it("is true for bulk mail whose headers do not say so but whose footer does (ADR 0111)", async () => {
    const parse = async (subject: string, contentType: string, body: string) =>
      (
        await parser.parse(
          new TextEncoder().encode(
            [
              "From: Shop <deals@mail.shop.example>",
              "To: me@example.com",
              `Subject: ${subject}`,
              "Date: Tue, 03 Nov 2026 09:30:00 +0100",
              "Message-ID: <d@mail.shop.example>",
              `Content-Type: ${contentType}; charset=utf-8`,
              "",
              body,
              "",
            ].join("\r\n"),
          ),
        )
      ).automated;
    const html =
      '<table><tr><td>Deals of the week</td></tr><tr><td><p>This email was sent to me@example.com.</p><a href="https://shop.example/u">Unsubscribe</a></td></tr></table>';
    expect(await parse("Deals of the week", "text/html", html)).toBe(true);
    expect(await parse("Deals", "text/plain", "Deals.\r\n\r\nManage your email preferences")).toBe(
      true,
    );
    // A person who passes it on quotes the footer; that is still the person writing.
    expect(await parse("Fwd: Deals of the week", "text/html", html)).toBe(false);
  });

  it("is left unknown for a message the parser could not read", async () => {
    const parsed = await parser.parse(new Uint8Array(0));
    expect(parsed.automated === undefined || parsed.automated === false).toBe(true);
  });
});
