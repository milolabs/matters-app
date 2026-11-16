// The contract of `MailAttachmentPort.source` (ADR 0145, rule 2), run against every adapter that
// fetches a message whole: the IMAP adapter against an IMAP server, the Graph adapter against its
// stand-in, and the fake. A message saved as a file must be the server's bytes, every one of them,
// and fetching it must not mark it as read.
import type { MailAttachmentPort, MessageLocation } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";

export interface MessageSourceHarness {
  /** Puts a message on the server, unread; where it is. */
  put(raw: Uint8Array): Promise<MessageLocation>;
  /** The port of a connection of its own. */
  port(): Promise<MailAttachmentPort>;
  /** Whether the server now has the message as read. */
  seen(location: MessageLocation): Promise<boolean>;
  /** The same folder's place for a message that is not there. */
  missing(location: MessageLocation): MessageLocation;
  close(): Promise<void>;
}

const encoder = new TextEncoder();

/**
 * A message that a careless fetch would change: CRLF line ends, 8-bit text in a header and a
 * body, a line of spaces at its end, a base64 part, and enough bytes for several pieces.
 */
export function awkwardMessage(id: string): Uint8Array {
  const big = Buffer.alloc(200_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
  const lines = big.toString("base64").match(/.{1,76}/g) ?? [];
  return encoder.encode(
    [
      `Message-ID: <${id}@source.example>`,
      "From: Zażółć <a@example.org>",
      "To: b@example.org",
      "Subject: =?UTF-8?B?UHLDs2JhIMW8w7PFgsSH?=",
      "Date: Mon, 16 Nov 2026 09:00:00 +0100",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Treść listu, gęślą jaźń.   ",
      "",
      "--b",
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="data.bin"',
      "",
      ...lines,
      "--b--",
      "",
    ].join("\r\n"),
  );
}

async function read(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function describeMessageSourceContract(
  name: string,
  setup: () => Promise<MessageSourceHarness>,
): void {
  describe(`${name}: a message's source (ADR 0145, rule 2)`, () => {
    let harness: MessageSourceHarness | null = null;
    afterEach(async () => {
      await harness?.close();
      harness = null;
    });

    it("is the server's bytes, every one of them, and does not mark the message as read", async () => {
      harness = await setup();
      const raw = awkwardMessage("whole");
      const at = await harness.put(raw);
      const port = await harness.port();
      const found = await port.source(at);
      if (found.kind !== "found") throw new Error("the message is there");
      const bytes = await read(found.content);
      expect(bytes.length).toBe(raw.length);
      expect(bytes.equals(Buffer.from(raw))).toBe(true);
      expect(await harness.seen(at)).toBe(false);
    });

    it("is gone for a message the folder does not have", async () => {
      harness = await setup();
      const at = await harness.put(awkwardMessage("there"));
      const port = await harness.port();
      expect(await port.source(harness.missing(at))).toEqual({ kind: "gone" });
    });
  });
}
