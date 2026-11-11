import { describe, expect, it } from "vitest";
import { generateCase } from "../../testkit/src/corpusGenerators.ts";
import { PostalMimeParser, UNREADABLE_NOTICE } from "../src/index.ts";

const parser = new PostalMimeParser();

describe("a message the parser cannot read", () => {
  it("comes back as a notice, not as an error", async () => {
    const parsed = await parser.parse(new Uint8Array(generateCase("many-headers", "bad")));
    expect(parsed).toEqual({
      subject: "",
      to: [],
      cc: [],
      replyTo: [],
      messageId: "",
      inReplyTo: "",
      references: [],
      text: UNREADABLE_NOTICE,
      attachments: [],
      senderAuth: "unknown",
    });
    expect(parsed.text).toContain("still on your server");
  });

  it("leaves a normal message as it was", async () => {
    const parsed = await parser.parse(
      new TextEncoder().encode(
        [
          "From: Ewa <ewa@example.pl>",
          "To: milosz@example.com",
          "Subject: Hello",
          "Message-ID: <ok@example.pl>",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Hello there.",
          "",
        ].join("\r\n"),
      ),
    );
    expect(parsed.from).toEqual({ name: "Ewa", address: "ewa@example.pl" });
    expect(parsed.subject).toBe("Hello");
    expect(parsed.messageId).toBe("<ok@example.pl>");
    expect(parsed.text).toBe("Hello there.");
  });

  it("does not throw for any other hostile message of the generators", async () => {
    for (const name of ["huge-header", "compressible-body", "many-parts", "huge-html"]) {
      const parsed = await parser.parse(new Uint8Array(generateCase(name, name)));
      expect(parsed.senderAuth, name).toBeDefined();
      expect(typeof parsed.text, name).toBe("string");
    }
  });

  it("does not throw for bytes that are not a message", async () => {
    for (const raw of [new Uint8Array(), new Uint8Array([0, 255, 13, 10, 58, 0])]) {
      const parsed = await parser.parse(raw);
      expect(parsed.attachments).toEqual([]);
    }
  });
});
