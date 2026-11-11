// Runs against the Dovecot container (`npm run test:imap`); skipped without it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Admin } from "../support/admin.ts";
import { ACCOUNT, Mailbox, Teardown } from "../support/harness.ts";
import { mail } from "../support/mail.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

const raw = (id: string) =>
  Buffer.from(
    mail({
      id,
      subject: "Re: Wycena zażółć",
      body: "Cena: 36 000 PLN",
      date: new Date(Date.UTC(2026, 10, 3, 12, 5, 7)),
    }),
  );

describe.skipIf(!enabled)("Sent folder on Dovecot", () => {
  const teardown = new Teardown();
  let admin: Admin;
  let box: Mailbox;
  beforeEach(async () => {
    const connected = await Admin.connect(credentials);
    admin = connected;
    teardown.add(() => connected.close());
    await connected.reset();
    // reset() removes every folder but INBOX; a mailbox without Sent has nowhere to append to.
    await connected.createFolder("Sent");
    const opened = new Mailbox(credentials);
    box = opened;
    teardown.add(() => opened.close());
  });
  afterEach(() => teardown.run());

  it("appends to the SPECIAL-USE Sent folder as read and reports where", async () => {
    const imap = await box.connect();
    try {
      const copy = await imap.sent.append(ACCOUNT, raw("s1"));
      expect(copy.location).toMatchObject({ accountId: "acc1", folderId: "Sent", uid: 1 });
      expect(copy.location.uidValidity).toMatch(/^\d+$/);
      const [stored] = await admin.messages("Sent");
      expect(stored?.flags).toContain("\\Seen");
      expect(stored?.source.equals(raw("s1"))).toBe(true);
    } finally {
      await imap.close();
    }
  });

  it("gives the id the sync gives the same message, so the sync finds it known", async () => {
    const imap = await box.connect();
    let copy: Awaited<ReturnType<typeof imap.sent.append>>;
    try {
      copy = await imap.sent.append(ACCOUNT, raw("s2"));
    } finally {
      await imap.close();
    }
    await box.sync();
    const synced = await box.bySubject("Re: Wycena zażółć");
    expect(synced.providerId).toBe(copy.providerId);
    expect(synced.providerId).toMatch(/^fp:/);
    expect(await box.store.getLocations(synced.key)).toEqual([copy.location]);
  });

  it("finds a message by Message-ID in Sent, and says null for one that is not there", async () => {
    const imap = await box.connect();
    try {
      const copy = await imap.sent.append(ACCOUNT, raw("s3"));
      expect(await imap.sent.findByMessageId(ACCOUNT, "<s3@example.pl>")).toEqual({
        providerId: copy.providerId,
      });
      expect(await imap.sent.findByMessageId(ACCOUNT, "<nobody@example.pl>")).toBeNull();
    } finally {
      await imap.close();
    }
  });

  it("does not look in other folders, and leaves INBOX alone", async () => {
    await admin.append("INBOX", raw("in1").toString());
    const imap = await box.connect();
    try {
      expect(await imap.sent.findByMessageId(ACCOUNT, "<in1@example.pl>")).toBeNull();
      await imap.sent.append(ACCOUNT, raw("s4"));
      expect(await admin.messages("INBOX")).toHaveLength(1);
      expect(await admin.messages("Sent")).toHaveLength(1);
    } finally {
      await imap.close();
    }
  });

  it("is not a capability Dovecot has: no savesSent, so the app appends", async () => {
    const imap = await box.connect();
    try {
      expect(imap.capabilities.has("savesSent")).toBe(false);
    } finally {
      await imap.close();
    }
  });
});
