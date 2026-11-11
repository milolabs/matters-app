import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Admin } from "./support/admin.ts";
import { ACCOUNT, Mailbox, Teardown } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

// Gmail's folder layout, with X-GM-EXT-1 (X-GM-MSGID, X-GM-THRID, X-GM-LABELS) and no OBJECTID.
const GMAIL_STORAGE = {
  INBOX: {},
  "": {
    separator: "/",
    folders: {
      "[Gmail]": {
        flags: ["\\Noselect"],
        folders: {
          "All Mail": { "special-use": "\\All" },
          Drafts: { "special-use": "\\Drafts" },
          "Sent Mail": { "special-use": "\\Sent" },
          Spam: { "special-use": "\\Junk" },
          Trash: { "special-use": "\\Trash" },
        },
      },
    },
  },
};

const ALL = "[Gmail]/All Mail";
const TRASH = "[Gmail]/Trash";

describe("Gmail branch (X-GM-EXT-1)", () => {
  const teardown = new Teardown();
  let admin: Admin;
  let box: Mailbox;

  beforeEach(async () => {
    const started = await startHoodiecrow(["X-GM-EXT-1", "QRESYNC"], GMAIL_STORAGE);
    teardown.add(() => started.stop());
    const connected = await Admin.connect(started.credentials);
    admin = connected;
    teardown.add(() => connected.close());
    const opened = new Mailbox(started.credentials);
    box = opened;
    teardown.add(() => opened.close());
  });
  afterEach(() => teardown.run());

  it("advertises threads and labels and lists only All Mail, Trash and Spam", async () => {
    const imap = await box.connect();
    try {
      expect([...imap.capabilities].sort()).toEqual(
        expect.arrayContaining(["condstore", "labels", "qresync", "threads"]),
      );
      expect(imap.capabilities.has("objectId")).toBe(false);
      const folders = await imap.listFolders(ACCOUNT);
      expect(folders.map((f) => [f.id, f.role, f.exclusive]).sort()).toEqual([
        ["[Gmail]/All Mail", "archive", false],
        ["[Gmail]/Spam", "spam", false],
        ["[Gmail]/Trash", "trash", false],
      ]);
    } finally {
      await imap.close();
    }
  });

  it("uses gm: ids, provider thread ids and provider labels", async () => {
    const uid = await admin.append(ALL, mail({ id: "g1", subject: "Gmailowa wiadomość: żółw" }));
    await admin.flagAdd(ALL, uid, ["\\Inbox", "Faktury"], true);

    await box.sync();

    const [m] = await box.messages();
    expect(m?.providerId).toMatch(/^gm:\d+$/);
    expect(m?.threadId).toMatch(/^pt:acc1:/);
    expect(m?.labelIds).toEqual(expect.arrayContaining(["inbox", "Faktury"]));
    // hoodiecrow also reports the special-use label of the folder (\\All); Gmail itself does not.
    expect(await box.store.getLocations(m?.key as number)).toHaveLength(1);
  });

  it("applies label changes from the provider without downloading", async () => {
    const uid = await admin.append(ALL, mail({ id: "g2", subject: "Etykiety" }));
    await admin.flagAdd(ALL, uid, ["\\Inbox"], true);
    await box.sync();
    const before = await box.bySubject("Etykiety");

    await admin.flagAdd(ALL, uid, ["Praca"], true);
    await admin.flagAdd(ALL, uid, ["\\Seen"]);
    const result = await box.sync();

    expect(box.stats.sourcesDownloaded).toBe(1);
    expect(result.folders.find((f) => f.folderId === ALL)?.flagsUpdated).toBe(1);
    const after = await box.bySubject("Etykiety");
    expect(after.key).toBe(before.key);
    expect(after.flags.seen).toBe(true);
    expect([...after.labelIds].sort()).toEqual(expect.arrayContaining(["Praca", "inbox"]));
    expect(after.labelIds).not.toContain("Faktury");
  });

  it("keeps the key when a message moves from All Mail to Trash", async () => {
    const uid = await admin.append(ALL, mail({ id: "g3", subject: "Do kosza" }));
    await box.sync();
    const before = await box.bySubject("Do kosza");

    await admin.move(ALL, uid, TRASH);
    await box.sync();

    expect(box.stats.sourcesDownloaded).toBe(1);
    const after = await box.bySubjectAnywhere("Do kosza");
    expect(after.key).toBe(before.key);
    expect(await box.store.getLocations(after.key)).toEqual([
      expect.objectContaining({ folderId: TRASH }),
    ]);
    // Deleted mail is left out of All mail (ADR 0044, rule 3).
    expect((await box.messages()).map((m) => m.subject)).not.toContain("Do kosza");
  });
});
