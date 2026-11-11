// Runs against the Dovecot container (`npm run test:imap`); skipped without it.
import { PostalMimeParser } from "@matters/adapter-mime";
import type { MimeParserPort, ParsedMessage } from "@matters/core";
import { syncAccount } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapMailSync } from "../../src/index.ts";
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

const SHOP = { name: "Sklep", address: "zamowienia@sklep.example" };
const HELP = "Pomoc <pomoc@sklep.example>";
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n));

/** What a build from before ADR 0042 stored: the message, and no word about `Reply-To`. */
class ParserOfThePast implements MimeParserPort {
  private readonly inner = new PostalMimeParser();
  async parse(raw: Uint8Array): Promise<ParsedMessage> {
    const { replyTo: _forgotten, ...rest } = await this.inner.parse(raw);
    return rest as ParsedMessage;
  }
}

describe.skipIf(!enabled)("Reply-To on Dovecot (ADR 0042)", () => {
  const teardown = new Teardown();
  let admin: Admin;
  let box: Mailbox;
  beforeEach(async () => {
    const connected = await Admin.connect(credentials);
    admin = connected;
    teardown.add(() => connected.close());
    await connected.reset();
    const opened = new Mailbox(credentials, 20);
    box = opened;
    teardown.add(() => opened.close());
  });
  afterEach(() => teardown.run());

  const replyToOf = async (subject: string) => (await box.bySubject(subject)).replyTo;
  const unknown = async () => {
    const cursor = await box.storage.cursors.get(ACCOUNT.id, "INBOX");
    return box.store.listUnknownReplyToUids(ACCOUNT.id, "INBOX", String(cursor?.uidValidity), 1000);
  };

  /** A sync as the previous version did it: sources parsed without the header. */
  async function syncAsBefore() {
    const imap = await ImapMailSync.connect({
      host: credentials.host,
      port: credentials.port,
      security: "none",
      allowInsecure: true,
      auth: { user: credentials.user, pass: credentials.pass },
      parser: new ParserOfThePast(),
      batchSize: 20,
    });
    try {
      // That build never asked the server, so the store says nothing is waiting to be learned.
      const store = Object.create(box.storage.store, {
        listUnknownReplyToUids: { value: async () => [] },
      });
      await syncAccount({ ...box.storage, store, sync: imap }, ACCOUNT);
      box.stats.sourcesDownloaded += imap.stats.sourcesDownloaded;
    } finally {
      await imap.close();
    }
  }

  const appendThree = () =>
    admin.appendMany("INBOX", [
      mail({ id: "a", subject: "Zamowienie", date: at(1), from: SHOP, replyTo: HELP }),
      mail({ id: "b", subject: "Tak samo", date: at(2), from: SHOP, replyTo: SHOP.address }),
      mail({ id: "c", subject: "Bez naglowka", date: at(3), from: SHOP }),
    ]);

  it("takes Reply-To from the source of a message it downloads, and asks the server nothing", async () => {
    await appendThree();
    await box.sync();
    expect(await replyToOf("Zamowienie")).toEqual([
      { name: "Pomoc", address: "pomoc@sklep.example" },
    ]);
    // The same as From, and no header at all, are both "none".
    expect(await replyToOf("Tak samo")).toEqual([]);
    expect(await replyToOf("Bez naglowka")).toEqual([]);
    expect(await unknown()).toEqual([]);
    expect(box.stats.replyToFetches).toBe(0);
  });

  it("learns it for stored mail from ENVELOPE, with no source download, in the final batch", async () => {
    await appendThree();
    await syncAsBefore();
    expect(box.stats.sourcesDownloaded).toBe(3);
    expect(await replyToOf("Zamowienie")).toBeUndefined();
    expect((await unknown()).length).toBe(3);
    const seq = (await box.storage.read.store.changesSince(0)).changeSeq;

    await box.sync();

    expect(box.stats.sourcesDownloaded).toBe(3);
    expect(box.stats.replyToFetches).toBe(1);
    expect(await replyToOf("Zamowienie")).toEqual([
      { name: "Pomoc", address: "pomoc@sklep.example" },
    ]);
    // The server fills the field with From when the header is absent or equal: both mean none.
    expect(await replyToOf("Tak samo")).toEqual([]);
    expect(await replyToOf("Bez naglowka")).toEqual([]);
    expect(await unknown()).toEqual([]);
    // Only the message that now names someone is announced to the UI.
    const changed = await box.storage.read.store.changesSince(seq);
    expect(changed.changedKeys).toEqual([(await box.bySubject("Zamowienie")).key]);
  });

  it("sends no further request once nothing is unknown", async () => {
    await appendThree();
    await syncAsBefore();
    await box.sync();
    expect(box.stats.replyToFetches).toBe(1);

    await box.sync();
    await box.sync();
    expect(box.stats.replyToFetches).toBe(1);
    expect(box.stats.sourcesDownloaded).toBe(3);
  });

  it("learns one batch of a folder per sync, newest first", async () => {
    const raws = Array.from({ length: 25 }, (_, i) =>
      mail({ id: `n${i}`, subject: `List ${i}`, date: at(i), from: SHOP, replyTo: HELP }),
    );
    await admin.appendMany("INBOX", raws);
    await syncAsBefore();
    const before = await unknown();
    expect(before).toHaveLength(25);

    await box.sync();
    // Batch size 20: the 20 newest are known, the 5 oldest wait for the next sync.
    expect(await unknown()).toEqual(before.slice(0, 5));
    expect(box.stats.replyToFetches).toBe(1);

    await box.sync();
    expect(await unknown()).toEqual([]);
    expect(box.stats.replyToFetches).toBe(2);
    expect(box.stats.sourcesDownloaded).toBe(25);
    expect(await replyToOf("List 0")).toEqual([{ name: "Pomoc", address: "pomoc@sklep.example" }]);
  });

  it("leaves a UID the server does not return unknown", async () => {
    await appendThree();
    await syncAsBefore();
    const cursor = await box.storage.cursors.get(ACCOUNT.id, "INBOX");
    const uidValidity = String(cursor?.uidValidity);
    const stored = await box.store.listLocationUids(ACCOUNT.id, "INBOX", uidValidity);

    const imap = await box.connect();
    try {
      const inbox = (await imap.listFolders(ACCOUNT)).find((f) => f.id === "INBOX");
      if (!inbox) throw new Error("no INBOX");
      const context = {
        knownProviderIds: async () => new Set<string>(),
        storedUids: async () => stored,
        // The store believes in a UID that the server never had; it is asked about, not answered.
        unknownReplyToUids: async () => [...stored, 9999],
        unknownAutomatedUids: async () => [],
        unknownAttachmentUids: async () => [],
      };
      const batches = [];
      for await (const b of imap.syncFolder(ACCOUNT, inbox, cursor, context)) batches.push(b);
      const answered = batches.at(-1)?.replyTos?.map((r) => r.location.uid) ?? [];
      expect(answered.sort((x, y) => x - y)).toEqual(stored);
    } finally {
      await imap.close();
    }
  });
});
