// Runs against the Dovecot container (`npm run test:imap`); skipped without it.
// Moving mail (ADR 0044) at the adapter, with the core use cases and no runtime in between, so
// that nothing but the test decides when a sync runs. This Dovecot has no OBJECTID: a message is
// known by its fingerprint (ADR 0016).
import type { MessageLocation } from "@matters/core";
import {
  deleteForever,
  finishMoves,
  finishPurge,
  MAILBOX_BIT,
  type MoveOperation,
  moveThread,
  parseQuery,
} from "@matters/core";
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

describe.skipIf(!enabled)("Moving mail on Dovecot (ADR 0044)", () => {
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

  let ids = 0;
  const run = () => ({
    store: box.storage.store,
    moveOps: box.storage.moveOps,
    uow: box.storage.uow,
    now: () => Date.now(),
    newId: () => `op${++ids}`,
  });
  /** The pending rows, then the connection's answer for the copies they name. */
  const pending = () => box.storage.moveOps.listPending();

  it("archives with a real MOVE and the new copy replaces the old one: no download, same key, body and index kept", async () => {
    const uid = await admin.append("INBOX", mail({ id: "a1", subject: "Do archiwum" }));
    await admin.createFolder("Archive");
    await box.sync();
    const before = await box.bySubject("Do archiwum");
    const downloaded = box.stats.sourcesDownloaded;
    expect(downloaded).toBe(1);

    await moveThread(run(), { threadId: before.threadId, action: "archive" });
    const rows = await pending();
    expect(rows).toHaveLength(1);
    const copies = await box.store.getLocations(before.key);
    expect(copies).toEqual([at(uid, "INBOX", await admin.uidValidity("INBOX"))]);

    const imap = await box.connect();
    try {
      const [result] = await imap.moves.move(copies, "archive", { role: "archive" });
      expect(result?.outcome).toMatchObject({
        kind: "moved",
        location: { folderId: "Archive", uidValidity: await admin.uidValidity("Archive") },
      });
      const moved = result?.outcome.kind === "moved" ? result.outcome.location : undefined;
      await finishMoves(box.storage, rows, [
        { key: before.key, from: copies[0] as MessageLocation, to: moved as MessageLocation },
      ]);
    } finally {
      await imap.close();
    }
    expect(await admin.messages("INBOX")).toHaveLength(0);
    expect(await admin.messages("Archive")).toHaveLength(1);

    // The very next sync sees the same message in its new place and downloads nothing.
    await box.sync();
    expect(box.stats.sourcesDownloaded).toBe(downloaded);
    const after = await box.bySubject("Do archiwum");
    expect(after.key).toBe(before.key);
    expect(after.mailboxes).toBe(MAILBOX_BIT.archive);
    expect((await box.store.getLocations(after.key)).map((l) => l.folderId)).toEqual(["Archive"]);
    expect((await box.storage.read.bodies.getBodies([after.key])).get(after.key)).toContain(
      "Treść",
    );
    expect(await box.storage.read.index.search(parseQuery("archiwum"), { limit: 5 })).toEqual([
      after.key,
    ]);
    expect(await box.storage.read.index.search(parseQuery("in:archive"), { limit: 5 })).toEqual([
      after.key,
    ]);
  });

  it("keeps the key when the sync, not the push, finds the message in its new place (no UID map)", async () => {
    const uid = await admin.append(
      "INBOX",
      mail({ id: "a2", subject: "Przeniesiony gdzie indziej" }),
    );
    await admin.createFolder("Archive");
    await box.sync();
    const before = await box.bySubject("Przeniesiony gdzie indziej");
    expect(before.providerId).toMatch(/^fp:/);
    const downloaded = box.stats.sourcesDownloaded;
    const imap = await box.connect();
    try {
      // The server has no OBJECTID, which is what makes the fingerprint the identity.
      expect(imap.capabilities.has("objectId")).toBe(false);
    } finally {
      await imap.close();
    }

    // The push could not say where the copy went, so the old location stays; or another device
    // moved it. Either way sync sees a removal in one folder and an addition in the other.
    await admin.move("INBOX", uid, "Archive");
    await box.sync();
    expect(box.stats.sourcesDownloaded).toBe(downloaded);
    const after = await box.bySubject("Przeniesiony gdzie indziej");
    expect(after.key).toBe(before.key);
    expect((await box.store.getLocations(after.key)).map((l) => l.folderId)).toEqual(["Archive"]);
    expect((await box.storage.read.bodies.getBodies([after.key])).size).toBe(1);
    expect(await box.storage.read.index.search(parseQuery("gdzie"), { limit: 5 })).toEqual([
      after.key,
    ]);
  });

  it("makes the folder of a role when the account has none (rule 14), and uses it afterwards", async () => {
    const one = await admin.append("INBOX", mail({ id: "c1", subject: "Jeden" }));
    const two = await admin.append("INBOX", mail({ id: "c2", subject: "Dwa" }));
    const three = await admin.append("INBOX", mail({ id: "c3", subject: "Trzy" }));
    const validity = await admin.uidValidity("INBOX");
    const imap = await box.connect();
    try {
      const archive = await imap.moves.move([at(one, "INBOX", validity)], "archive", {
        role: "archive",
      });
      const trash = await imap.moves.move([at(two, "INBOX", validity)], "delete", {
        role: "trash",
      });
      const spam = await imap.moves.move([at(three, "INBOX", validity)], "spam", { role: "spam" });
      expect(archive[0]?.outcome).toMatchObject({
        kind: "moved",
        location: { folderId: "Archive" },
      });
      expect(trash[0]?.outcome).toMatchObject({ kind: "moved", location: { folderId: "Trash" } });
      expect(spam[0]?.outcome).toMatchObject({ kind: "moved", location: { folderId: "Junk" } });
    } finally {
      await imap.close();
    }
    expect(await admin.messages("INBOX")).toHaveLength(0);
    expect(await admin.messages("Archive")).toHaveLength(1);
    expect(await admin.messages("Trash")).toHaveLength(1);
    expect(await admin.messages("Junk")).toHaveLength(1);
    // The next sync learns them, with their roles from the server.
    await box.sync();
    expect((await box.store.listFolders("acc1")).map((f) => `${f.id}:${f.role}`).sort()).toEqual([
      "Archive:archive",
      "INBOX:inbox",
      "Junk:spam",
      "Trash:trash",
    ]);
    expect((await box.messages()).map((m) => m.subject)).toEqual(["Jeden"]);
    expect(
      (await box.storage.read.index.search(parseQuery("in:trash OR in:spam"), { limit: 5 })).length,
    ).toBe(2);
  });

  it("moves to a folder and out of Trash again, a message with two copies from both", async () => {
    await admin.createFolder("Clients");
    await admin.createFolder("Trash");
    const a = await admin.append("INBOX", mail({ id: "d1", subject: "Do klienta" }));
    const b = await admin.append("Trash", mail({ id: "d2", subject: "Z kosza" }));
    const validity = await admin.uidValidity("INBOX");
    const trashValidity = await admin.uidValidity("Trash");
    const imap = await box.connect();
    try {
      const out = await imap.moves.move([at(a, "INBOX", validity)], "move", {
        folderId: "Clients",
      });
      expect(out[0]?.outcome).toMatchObject({ kind: "moved", location: { folderId: "Clients" } });
      const back = await imap.moves.move([at(b, "Trash", trashValidity)], "move", {
        role: "inbox",
      });
      expect(back[0]?.outcome).toMatchObject({ kind: "moved", location: { folderId: "INBOX" } });
    } finally {
      await imap.close();
    }
    expect(await admin.messages("Clients")).toHaveLength(1);
    expect(await admin.messages("INBOX")).toHaveLength(1);
    expect(await admin.messages("Trash")).toHaveLength(0);
  });

  it("answers stale for a copy that is gone or a folder that was rebuilt, and rejects what the server refuses", async () => {
    await admin.createFolder("Archive");
    const uid = await admin.append("INBOX", mail({ id: "e1", subject: "Raz" }));
    const validity = await admin.uidValidity("INBOX");
    const imap = await box.connect();
    try {
      const first = await imap.moves.move([at(uid, "INBOX", validity)], "archive", {
        role: "archive",
      });
      expect(first[0]?.outcome.kind).toBe("moved");
      // The same copy again, as after a crash between the server's move and the settling.
      const again = await imap.moves.move([at(uid, "INBOX", validity)], "archive", {
        role: "archive",
      });
      expect(again[0]?.outcome).toEqual({ kind: "stale" });
      // A rebuilt folder and a folder that is not there.
      const odd = await imap.moves.move([at(1, "INBOX", "1"), at(1, "Zniknął", "1")], "archive", {
        role: "archive",
      });
      expect(odd.map((r) => r.outcome.kind)).toEqual(["stale", "stale"]);
      // Moving to the folder it is in: nothing to do, and nothing asked of the server.
      const here = await imap.moves.move(
        [at(1, "Archive", await admin.uidValidity("Archive"))],
        "move",
        { folderId: "Archive" },
      );
      expect(here[0]?.outcome.kind).toBe("stale");
    } finally {
      await imap.close();
    }
    expect(await admin.messages("Archive")).toHaveLength(1);
  });

  it("deletes for good only in the account's Trash, copy by copy, and says what it could not", async () => {
    await admin.createFolder("Trash");
    await admin.createFolder("Clients");
    const inbox = await admin.append("INBOX", mail({ id: "f1", subject: "W skrzynce" }));
    const binA = await admin.append("Trash", mail({ id: "f2", subject: "W koszu" }));
    const binB = await admin.append("Trash", mail({ id: "f3", subject: "Drugi w koszu" }));
    const clients = await admin.append("Clients", mail({ id: "f4", subject: "U klienta" }));
    const v = {
      INBOX: await admin.uidValidity("INBOX"),
      Trash: await admin.uidValidity("Trash"),
      Clients: await admin.uidValidity("Clients"),
    };
    const imap = await box.connect();
    try {
      // Anywhere else, nothing is sent: the answer is a refusal, and the mail is untouched.
      const refused = await imap.moves.expunge([
        at(inbox, "INBOX", v.INBOX),
        at(clients, "Clients", v.Clients),
      ]);
      expect(refused.map((r) => r.outcome)).toEqual(["rejected", "rejected"]);
      expect(await admin.messages("INBOX")).toHaveLength(1);
      expect(await admin.messages("Clients")).toHaveLength(1);

      const done = await imap.moves.expunge([
        at(binA, "Trash", v.Trash),
        at(999, "Trash", v.Trash),
        at(binB, "Trash", "7"),
      ]);
      expect(done.map((r) => r.outcome)).toEqual(["done", "stale", "stale"]);
      expect((await admin.messages("Trash")).map((m) => m.uid)).toEqual([binB]);
    } finally {
      await imap.close();
    }
  });

  it("takes a message out of the store when the server has expunged its last copy, and a sync does not bring it back", async () => {
    await admin.createFolder("Trash");
    await admin.append("Trash", mail({ id: "g1", subject: "Na zawsze" }));
    await box.sync();
    const m = await box.bySubjectAnywhere("Na zawsze");
    expect(m.mailboxes).toBe(MAILBOX_BIT.trash);

    const result = await deleteForever(
      { ...run(), index: box.storage.index, bodies: box.storage.bodies },
      [m.key],
    );
    expect(result.queued).toEqual([m.key]);
    const rows = await pending();
    const copies = await box.store.getLocations(m.key);
    const imap = await box.connect();
    try {
      const out = await imap.moves.expunge(copies);
      expect(out.map((r) => r.outcome)).toEqual(["done"]);
      const left = await finishPurge(
        { ...box.storage },
        rows as readonly MoveOperation[],
        out.map((r) => r.location),
      );
      expect(left).toEqual([m.key]);
    } finally {
      await imap.close();
    }
    expect(await box.store.getByKeys([m.key])).toEqual([]);
    await box.sync();
    expect(await box.everything()).toEqual([]);
    expect(await admin.messages("Trash")).toHaveLength(0);
  });

  it("is refused by the core before the server hears of it when a copy is outside Trash", async () => {
    await admin.createFolder("Trash");
    await admin.append("INBOX", mail({ id: "h1", subject: "W skrzynce i w koszu" }));
    await admin.copy("INBOX", (await admin.messages("INBOX"))[0]?.uid ?? 0, "Trash");
    await box.sync();
    const m = await box.bySubjectAnywhere("W skrzynce i w koszu");
    expect((await box.store.getLocations(m.key)).map((l) => l.folderId).sort()).toEqual([
      "INBOX",
      "Trash",
    ]);
    const result = await deleteForever(
      { ...run(), index: box.storage.index, bodies: box.storage.bodies },
      [m.key],
    );
    expect(result).toMatchObject({ queued: [], removed: [], refused: [m.key] });
    expect(await pending()).toEqual([]);
    expect(await admin.messages("INBOX")).toHaveLength(1);
    expect(await admin.messages("Trash")).toHaveLength(1);
  });

  it("leaves a read-only sync alone: a push to a copy that just moved flags nothing anywhere", async () => {
    await admin.createFolder("Archive");
    const uid = await admin.append("INBOX", mail({ id: "i1", subject: "Przeczytany po ruchu" }));
    const validity = await admin.uidValidity("INBOX");
    await admin.move("INBOX", uid, "Archive");
    const imap = await box.connect();
    try {
      const out = await imap.flags.setSeen([at(uid, "INBOX", validity)], true);
      // The UID is not in the folder any more: the server has nothing to flag, and says so as it
      // does for any UID that is not there. It is neither a failure nor a refusal.
      expect(["done", "stale"]).toContain(out[0]?.outcome);
    } finally {
      await imap.close();
    }
    expect((await admin.messages("Archive"))[0]?.flags).not.toContain("\\Seen");
    await box.sync();
    expect((await box.bySubject("Przeczytany po ruchu")).flags.seen).toBe(false);
  });
});
