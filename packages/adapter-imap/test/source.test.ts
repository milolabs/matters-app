// The source of a message over IMAP (ADR 0145, rule 2), against the in-process server. The same
// contract runs against the Dovecot container in the integration tests.
import { describeMessageSourceContract } from "@matters/testkit";
import { Admin } from "./support/admin.ts";
import { Mailbox } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";

describeMessageSourceContract("IMAP on hoodiecrow", async () => {
  const started = await startHoodiecrow([]);
  const admin = await Admin.connect(started.credentials);
  const box = new Mailbox(started.credentials);
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
      await box.close();
      await admin.close();
      await started.stop();
    },
  };
});
