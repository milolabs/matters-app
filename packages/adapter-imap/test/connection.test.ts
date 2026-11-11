import { PostalMimeParser } from "@matters/adapter-mime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapAuthError, ImapMailSync } from "../src/index.ts";
import { Admin } from "./support/admin.ts";
import { ACCOUNT, Mailbox } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

describe("connection", () => {
  let started: Awaited<ReturnType<typeof startHoodiecrow>>;
  beforeEach(async () => {
    started = await startHoodiecrow(["QRESYNC"]);
  });
  afterEach(() => started.stop());

  it("reports a wrong password as ImapAuthError without the password anywhere", async () => {
    const password = "hunter2-very-secret";
    const failure = await ImapMailSync.connect({
      host: started.credentials.host,
      port: started.credentials.port,
      security: "none",
      allowInsecure: true,
      auth: { user: "testuser", pass: password },
      parser: new PostalMimeParser(),
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ImapAuthError);
    const error = failure as ImapAuthError;
    expect(error.user).toBe("testuser");
    expect(error.host).toBe("127.0.0.1");
    const everything = [
      error.message,
      error.stack ?? "",
      JSON.stringify(error),
      Object.keys(error).join(","),
    ].join("\n");
    expect(everything).not.toContain(password);
  });

  it("reports an unreachable server as a connection error without the password", async () => {
    const password = "hunter2-very-secret";
    const failure = await ImapMailSync.connect({
      host: "127.0.0.1",
      port: 1,
      security: "none",
      allowInsecure: true,
      auth: { user: "testuser", pass: password },
      parser: new PostalMimeParser(),
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).stack) + String((failure as Error).message)).not.toContain(
      password,
    );
  });

  it("negotiates compression and CONDSTORE/QRESYNC and logs out cleanly", async () => {
    const box = new Mailbox(started.credentials);
    try {
      const imap = await box.connect();
      expect([...imap.capabilities].sort()).toEqual(["compress", "condstore", "qresync"]);
      await imap.close();
    } finally {
      box.close();
    }
  });

  it("gives a mailbox with Polish folder names the right roles", async () => {
    const admin = await Admin.connect(started.credentials);
    const box = new Mailbox(started.credentials);
    try {
      for (const name of [
        "Wysłane",
        "Elementy wysłane",
        "Kosz",
        "Śmieci",
        "Wersje robocze",
        "Spam",
      ]) {
        await admin.createFolder(name);
      }
      const imap = await box.connect();
      const folders = await imap.listFolders(ACCOUNT);
      await imap.close();
      const roles = Object.fromEntries(folders.map((f) => [f.name, f.role]));
      expect(roles).toMatchObject({
        INBOX: "inbox",
        Wysłane: "sent",
        "Elementy wysłane": "sent",
        Kosz: "trash",
        Śmieci: "trash",
        "Wersje robocze": "drafts",
        Spam: "spam",
      });
      expect(folders.every((f) => f.exclusive)).toBe(true);
    } finally {
      box.close();
      await admin.close();
    }
  });

  it("falls back to the location as identity for mail without a Message-ID", async () => {
    const admin = await Admin.connect(started.credentials);
    const box = new Mailbox(started.credentials);
    try {
      const uid = await admin.append(
        "INBOX",
        mail({ id: "nid", subject: "Bez identyfikatora", noMessageId: true }),
      );
      await admin.createFolder("Archive");
      await box.sync();
      const before = await box.bySubject("Bez identyfikatora");
      expect(before.providerId).toMatch(/^loc:INBOX:\d+:\d+$/);
      expect(before.messageIdHeader).toBe("");
      // Threaded under its own location, not an empty id shared with every other such mail.
      expect(before.threadId).toMatch(/^lt:acc1:INBOX:/);

      await admin.move("INBOX", uid, "Archive");
      await box.sync();

      // No stable id: the move is a new message (ADR 0016), the old one is gone.
      const after = await box.bySubject("Bez identyfikatora");
      expect(after.providerId).toMatch(/^loc:Archive:/);
      expect(after.key).not.toBe(before.key);
      expect(await box.messages()).toHaveLength(1);
      expect(box.stats.sourcesDownloaded).toBe(2);
    } finally {
      box.close();
      await admin.close();
    }
  });
});
