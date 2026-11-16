// Runs against the Dovecot container (`bun run test:imap`); skipped without it. The source of a
// message (ADR 0145, rule 2): Dovecot's own bytes, and \Seen left alone.
import { describeMessageSourceContract } from "@matters/testkit";
import { describe } from "vitest";
import { Admin } from "../support/admin.ts";
import { Mailbox } from "../support/harness.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

describe.skipIf(!enabled)("on Dovecot", () => {
  describeMessageSourceContract("IMAP on Dovecot", async () => {
    const admin = await Admin.connect(credentials);
    await admin.reset();
    const box = new Mailbox(credentials, 20);
    const connections: { close(): Promise<void> }[] = [];
    return {
      async put(raw) {
        const uid = await admin.append("INBOX", Buffer.from(raw));
        return {
          accountId: "a1",
          folderId: "INBOX",
          uidValidity: await admin.uidValidity("INBOX"),
          uid,
        };
      },
      async port() {
        const imap = await box.connect();
        connections.push(imap);
        return imap.attachments;
      },
      async seen(location) {
        const found = (await admin.messages(location.folderId)).find((m) => m.uid === location.uid);
        return found?.flags.includes("\\Seen") ?? false;
      },
      missing: (location) => ({ ...location, uid: location.uid + 1000 }),
      async close() {
        for (const c of connections) await c.close().catch(() => {});
        box.close();
        await admin.close();
      },
    };
  });
});
