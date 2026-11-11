// Runs against the Dovecot container (`npm run test:imap`); skipped without it.
import { UNREADABLE_NOTICE } from "@matters/adapter-mime";
import { describe, expect, it } from "vitest";
import { runUnreadableScenario } from "../support/unreadable.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

describe.skipIf(!enabled)("a message the parser cannot read, on Dovecot (ADR 0047)", () => {
  it("is stored with the server's sender and subject, once, and the account goes on syncing", async () => {
    const run = await runUnreadableScenario(credentials, true);
    expect(run.afterFirst.map((m) => m.subject).sort()).toEqual([
      "Corpus message",
      "first",
      "second",
    ]);
    expect(run.bad?.from).toEqual({ name: "Sender", address: "sender@example.org" });
    expect(run.bad?.to).toEqual([{ name: "Reader", address: "reader@example.com" }]);
    expect(run.bad?.senderAuth).toBe("unknown");
    expect(run.badBody).toBe(UNREADABLE_NOTICE);
    expect(run.afterSecond.map((m) => m.subject).sort()).toEqual([
      "Corpus message",
      "first",
      "later",
      "second",
    ]);
    expect(run.downloadedByFirst).toBe(3);
    expect(run.downloadedBySecond).toBe(1);
  });
});
