import { UNREADABLE_NOTICE } from "@matters/adapter-mime";
import { describe, expect, it } from "vitest";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { runUnreadableScenario } from "./support/unreadable.ts";

describe("a message the parser cannot read (ADR 0047)", () => {
  it("is stored with the server's sender and subject, once, and the account goes on syncing", async () => {
    const server = await startHoodiecrow([]);
    try {
      const run = await runUnreadableScenario(server.credentials);
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
    } finally {
      await server.stop();
    }
  });
});
