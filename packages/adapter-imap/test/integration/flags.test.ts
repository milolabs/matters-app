// Runs against the Dovecot container (`npm run test:imap`); skipped without it.
import type { MessageLocation } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Admin } from "../support/admin.ts";
import { Mailbox, Teardown } from "../support/harness.ts";
import { mail } from "../support/mail.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

const at = (uid: number, folderId: string, uidValidity: string): MessageLocation => ({
  accountId: "acc1",
  folderId,
  uidValidity,
  uid,
});

describe.skipIf(!enabled)("Marking read on Dovecot (ADR 0039)", () => {
  const teardown = new Teardown();
  let admin: Admin;
  let box: Mailbox;
  beforeEach(async () => {
    const connected = await Admin.connect(credentials);
    admin = connected;
    teardown.add(() => connected.close());
    await connected.reset();
    const opened = new Mailbox(credentials);
    box = opened;
    teardown.add(() => opened.close());
  });
  afterEach(() => teardown.run());

  const flagsOf = async (folder: string, uid: number) =>
    (await admin.messages(folder)).find((m) => m.uid === uid)?.flags ?? [];

  it("sets \\Seen on every copy and clears it again, leaving other flags and messages alone", async () => {
    const one = await admin.append("INBOX", mail({ id: "r1", subject: "Jeden" }), ["\\Flagged"]);
    const two = await admin.append("INBOX", mail({ id: "r2", subject: "Dwa" }));
    await admin.createFolder("Archive");
    const copy = await admin.append("Archive", mail({ id: "r1", subject: "Jeden" }));
    const inbox = await admin.uidValidity("INBOX");
    const archive = await admin.uidValidity("Archive");

    const imap = await box.connect();
    try {
      const copies = [at(one, "INBOX", inbox), at(copy, "Archive", archive)];
      expect((await imap.flags.setSeen(copies, true)).map((r) => r.outcome)).toEqual([
        "done",
        "done",
      ]);
      expect(await flagsOf("INBOX", one)).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));
      expect(await flagsOf("Archive", copy)).toContain("\\Seen");
      expect(await flagsOf("INBOX", two)).not.toContain("\\Seen");

      await imap.flags.setSeen(copies, false);
      expect(await flagsOf("INBOX", one)).toEqual(["\\Flagged"]);
      expect(await flagsOf("Archive", copy)).not.toContain("\\Seen");
    } finally {
      await imap.close();
    }
  });

  it("is what the next sync reads back, so the local state and the server's agree", async () => {
    const uid = await admin.append("INBOX", mail({ id: "r3", subject: "Trzy" }));
    await box.sync();
    const synced = await box.bySubject("Trzy");
    expect(synced.flags.seen).toBe(false);

    const imap = await box.connect();
    try {
      await imap.flags.setSeen([at(uid, "INBOX", await admin.uidValidity("INBOX"))], true);
    } finally {
      await imap.close();
    }
    await box.sync();
    expect((await box.bySubject("Trzy")).flags.seen).toBe(true);
    expect(await flagsOf("INBOX", uid)).toContain("\\Seen");
  });

  it("skips a copy of a folder that was rebuilt, and one that is gone", async () => {
    const uid = await admin.append("INBOX", mail({ id: "r4", subject: "Cztery" }));
    const imap = await box.connect();
    try {
      const out = await imap.flags.setSeen([at(uid, "INBOX", "1"), at(1, "Zniknął", "1")], true);
      expect(out.map((r) => r.outcome)).toEqual(["stale", "stale"]);
      expect(await flagsOf("INBOX", uid)).not.toContain("\\Seen");
    } finally {
      await imap.close();
    }
  });

  it("does not disturb a sync that opens the same folder read-only on another connection", async () => {
    const uid = await admin.append("INBOX", mail({ id: "r5", subject: "Pięć" }));
    const validity = await admin.uidValidity("INBOX");
    const pushing = await box.connect();
    try {
      await Promise.all([box.sync(), pushing.flags.setSeen([at(uid, "INBOX", validity)], true)]);
    } finally {
      await pushing.close();
    }
    await box.sync();
    expect((await box.bySubject("Pięć")).flags.seen).toBe(true);
  });
});
