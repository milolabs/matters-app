// Runs against the Dovecot container from tools/imap-test-server. Use `npm run test:imap`, which
// starts the container and sets the variables below; without them the suite is skipped.
import { describe, expect, it } from "vitest";
import { Mailbox } from "../support/harness.ts";
import { describeImapScenarios } from "../support/scenarios.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";

const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

describe.skipIf(!enabled)("Dovecot 2.4 (Debian stable)", () => {
  it("advertises what the adapter relies on", async () => {
    const box = new Mailbox(credentials);
    try {
      const imap = await box.connect();
      const capabilities = [...imap.capabilities].sort();
      console.log(`Dovecot capabilities seen by the adapter: ${capabilities.join(", ")}`);
      await imap.close();
      // Dovecot community 2.4 has no OBJECTID, so ids are fingerprints here.
      expect(capabilities).toEqual(["compress", "condstore", "qresync"]);
    } finally {
      box.close();
    }
  });

  it("abort lets go of what waits on the connection, and close still works after it", async () => {
    const box = new Mailbox(credentials);
    try {
      const imap = await box.connect();
      const account = { id: "a" } as never;
      const waiting = imap.listFolders(account).then(
        () => "finished",
        () => "failed",
      );
      imap.abort();
      const late = new Promise<string>((r) => setTimeout(() => r("still waiting"), 3000));
      expect(await Promise.race([waiting, late])).not.toBe("still waiting");
      await expect(imap.listFolders(account)).rejects.toThrow();
      await imap.close();
    } finally {
      box.close();
    }
  });

  describeImapScenarios(async () => ({
    server: { credentials, idPrefix: "fp:", qresync: true },
    release: async () => {},
  }));
});
