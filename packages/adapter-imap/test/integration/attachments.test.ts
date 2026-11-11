// Runs against the Dovecot container (`npm run test:imap`); skipped without it.

import { createHash } from "node:crypto";
import { PostalMimeParser } from "@matters/adapter-mime";
import type {
  Account,
  FolderSyncContext,
  Label,
  MailSyncPort,
  MimeParserPort,
  ParsedMessage,
  SyncBatch,
  SyncCursor,
} from "@matters/core";
import { syncAccount } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapMailSync } from "../../src/index.ts";
import { Admin } from "../support/admin.ts";
import { ACCOUNT, Mailbox, Teardown } from "../support/harness.ts";
import { binary, multipart, part, rawMessage, sha256 } from "../support/multipart.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n));
const POLISH = "Zażółć gęślą jaźń — faktura.pdf";
/** RFC 2231: the name as percent-encoded UTF-8. */
const rfc2231 = (name: string) => `UTF-8''${encodeURIComponent(name)}`;
/** RFC 2047: the name as an encoded word. */
const encodedWord = (name: string) => `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;

const text = (body = "Treść listu") =>
  part({ headers: ["Content-Type: text/plain; charset=utf-8"], content: body });
const html = () =>
  part({ headers: ["Content-Type: text/html; charset=utf-8"], content: "<p>Treść listu</p>" });
const alternative = (id: string) => multipart("alternative", `alt-${id}`, [text(), html()]);

/** The message of an integration test: text, a Polish-named PDF, a named image, a big binary. */
function mixed(id: string, subject: string, big: Buffer, date = at(1)) {
  return rawMessage({
    id,
    subject,
    date,
    entity: multipart("mixed", `mix-${id}`, [
      alternative(id),
      part({
        headers: [
          "Content-Type: application/pdf",
          `Content-Disposition: attachment; filename*=${rfc2231(POLISH)}`,
        ],
        content: "%PDF-1.4 a small invoice",
        encoding: "base64",
      }),
      part({
        headers: [
          `Content-Type: image/png; name="${encodedWord("Zdjęcie z wakacji.png")}"`,
          `Content-Disposition: attachment; filename="${encodedWord("Zdjęcie z wakacji.png")}"`,
        ],
        content: binary(2000, 3),
        encoding: "base64",
      }),
      part({
        headers: [
          'Content-Type: application/octet-stream; name="dane.bin"',
          'Content-Disposition: attachment; filename="dane.bin"',
        ],
        content: big,
        encoding: "base64",
      }),
    ]),
  });
}

const related = (id: string) =>
  rawMessage({
    id,
    subject: "Z logo",
    date: at(2),
    entity: multipart("mixed", `mix-${id}`, [
      multipart("related", `rel-${id}`, [
        alternative(id),
        part({
          headers: [
            "Content-Type: image/png",
            "Content-ID: <logo@example.pl>",
            'Content-Disposition: inline; filename="logo.png"',
          ],
          content: binary(500, 9),
          encoding: "base64",
        }),
      ]),
      part({
        headers: [
          "Content-Type: application/zip",
          'Content-Disposition: attachment; filename="Umowa.zip"',
        ],
        content: binary(900, 5),
        encoding: "base64",
      }),
    ]),
  });

const forwarded = (id: string) =>
  rawMessage({
    id,
    subject: "Przekazana",
    date: at(3),
    entity: multipart("mixed", `mix-${id}`, [
      text(),
      part({
        headers: ["Content-Type: message/rfc822", "Content-Disposition: attachment"],
        content: "From: a@example.pl\r\nSubject: wewnątrz\r\n\r\nTreść wewnętrzna\r\n",
      }),
      part({
        headers: ["Content-Type: text/calendar; method=REQUEST; charset=utf-8"],
        content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      }),
    ]),
  });

const plain = (id: string) => rawMessage({ id, subject: "Zwykły", date: at(4), entity: text() });

/** What a build from before ADR 0043 stored: the message, and no word of its structure. */
class SyncOfThePast implements MailSyncPort {
  readonly capabilities;
  private readonly inner: ImapMailSync;
  constructor(inner: ImapMailSync) {
    this.inner = inner;
    this.capabilities = inner.capabilities;
  }
  listFolders(account: Account) {
    return this.inner.listFolders(account);
  }
  async *syncFolder(
    account: Account,
    folder: Label,
    cursor: SyncCursor | null,
    context: FolderSyncContext,
  ): AsyncIterable<SyncBatch> {
    // That build never asked for BODYSTRUCTURE, so the store says nothing was waiting.
    const quiet: FolderSyncContext = { ...context, unknownAttachmentUids: async () => [] };
    for await (const batch of this.inner.syncFolder(account, folder, cursor, quiet)) {
      const { attachmentAnswers: _forgotten, ...rest } = batch;
      yield rest;
    }
  }
}

/** A parser that claims a file for every message, so the flag can be seen being corrected. */
class ParserWhoSeesFilesEverywhere implements MimeParserPort {
  private readonly inner = new PostalMimeParser();
  async parse(raw: Uint8Array): Promise<ParsedMessage> {
    const parsed = await this.inner.parse(raw);
    return {
      ...parsed,
      attachments: [{ mimeType: "application/pdf", size: 1, inline: false }],
    };
  }
}

describe.skipIf(!enabled)("received attachments on Dovecot (ADR 0043)", () => {
  const teardown = new Teardown();
  let admin: Admin;
  let box: Mailbox;
  const BIG = binary(6 * 1024 * 1024 + 321, 7);
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

  const filesOf = async (subject: string) => {
    const message = await box.bySubject(subject);
    const view = await box.storage.store.getThread(message.threadId);
    return { message, files: view?.attachments.get(message.key) };
  };
  const unknown = async () => {
    const cursor = await box.storage.cursors.get(ACCOUNT.id, "INBOX");
    return box.store.listUnknownAttachmentUids(
      ACCOUNT.id,
      "INBOX",
      String(cursor?.uidValidity),
      1000,
    );
  };

  /** A sync as the previous version did it: sources parsed, no structure asked for. */
  async function syncAsBefore(parser: MimeParserPort = new PostalMimeParser()) {
    const imap = await ImapMailSync.connect({
      host: credentials.host,
      port: credentials.port,
      security: "none",
      allowInsecure: true,
      auth: { user: credentials.user, pass: credentials.pass },
      parser,
      batchSize: 20,
    });
    try {
      await syncAccount({ ...box.storage, sync: new SyncOfThePast(imap) }, ACCOUNT);
      box.stats.sourcesDownloaded += imap.stats.sourcesDownloaded;
    } finally {
      await imap.close();
    }
  }

  it("lists the files of a new message from the sync itself, with names decoded and parts numbered", async () => {
    await admin.append("INBOX", mixed("m1", "Faktury", BIG));
    await box.sync();

    const { message, files } = await filesOf("Faktury");
    expect(message.hasAttachments).toBe(true);
    expect(files?.known).toBe(true);
    expect(files?.items.map((f) => [f.partId, f.name, f.mimeType])).toEqual([
      ["2", POLISH, "application/pdf"],
      ["3", "Zdjęcie z wakacji.png", "image/png"],
      ["4", "dane.bin", "application/octet-stream"],
    ]);
    // The size is the decoded one, estimated: close to the truth, never the encoded size.
    const big = files?.items[2];
    expect(big?.size).toBeGreaterThan(BIG.length * 0.97);
    expect(big?.size).toBeLessThanOrEqual(BIG.length);
    expect(box.stats.attachmentFetches).toBe(0);
    expect(await unknown()).toEqual([]);
  });

  it("does not list an inline image of multipart/related, a forwarded message's inside, or a plain text", async () => {
    await admin.appendMany("INBOX", [related("m2"), forwarded("m3"), plain("m4")]);
    await box.sync();

    expect((await filesOf("Z logo")).files?.items.map((f) => f.name)).toEqual(["Umowa.zip"]);
    expect((await filesOf("Przekazana")).files?.items.map((f) => [f.name, f.mimeType])).toEqual([
      ["message.eml", "message/rfc822"],
      ["invite.ics", "text/calendar"],
    ]);
    const none = await filesOf("Zwykły");
    expect(none.files).toEqual({ known: true, items: [], hasInline: false });
    expect(none.message.hasAttachments).toBe(false);
  });

  it("learns the files of mail stored earlier from BODYSTRUCTURE alone, with no source download", async () => {
    await admin.appendMany("INBOX", [mixed("m1", "Faktury", BIG), plain("m4")]);
    await syncAsBefore();
    expect(box.stats.sourcesDownloaded).toBe(2);
    expect((await filesOf("Faktury")).files).toEqual({ known: false, items: [], hasInline: false });
    expect((await filesOf("Zwykły")).files?.known).toBe(true);
    expect(await unknown()).toHaveLength(1);
    const seq = (await box.storage.read.store.changesSince(0)).changeSeq;

    await box.sync();

    // The sources are not downloaded again: only the structure is asked for, once.
    expect(box.stats.sourcesDownloaded).toBe(2);
    expect(box.stats.attachmentFetches).toBe(1);
    const { files } = await filesOf("Faktury");
    expect(files?.known).toBe(true);
    expect(files?.items.map((f) => f.name)).toEqual([POLISH, "Zdjęcie z wakacji.png", "dane.bin"]);
    expect(await unknown()).toEqual([]);
    // The thread open on screen is told there is something new in it.
    const changed = await box.storage.read.store.changesSince(seq);
    expect(changed.changedKeys).toEqual([(await box.bySubject("Faktury")).key]);
  });

  it("sends no further request once nothing is unknown", async () => {
    await admin.append("INBOX", mixed("m1", "Faktury", BIG));
    await syncAsBefore();
    await box.sync();
    expect(box.stats.attachmentFetches).toBe(1);
    await box.sync();
    await box.sync();
    expect(box.stats.attachmentFetches).toBe(1);
  });

  it("learns one batch of a folder per sync, newest first", async () => {
    const small = binary(300, 2);
    await admin.appendMany(
      "INBOX",
      Array.from({ length: 25 }, (_, i) => mixed(`n${i}`, `Lista ${i}`, small, at(i))),
    );
    await syncAsBefore();
    expect(await unknown()).toHaveLength(25);

    await box.sync();
    // Batch size 20: the 20 newest are known, the 5 oldest wait for the next sync.
    expect(await unknown()).toHaveLength(5);
    expect(box.stats.attachmentFetches).toBe(1);
    await box.sync();
    expect(await unknown()).toEqual([]);
    expect(box.stats.attachmentFetches).toBe(2);
    expect(box.stats.sourcesDownloaded).toBe(25);
  });

  it("corrects has_attachments from the structure, and announces the correction", async () => {
    await admin.append("INBOX", plain("m4"));
    await syncAsBefore(new ParserWhoSeesFilesEverywhere());
    const claimed = await box.bySubject("Zwykły");
    expect(claimed.hasAttachments).toBe(true);
    const seq = (await box.storage.read.store.changesSince(0)).changeSeq;

    await box.sync();

    expect((await box.bySubject("Zwykły")).hasAttachments).toBe(false);
    expect((await filesOf("Zwykły")).files).toEqual({ known: true, items: [], hasInline: false });
    const changed = await box.storage.read.store.changesSince(seq);
    expect(changed.changedKeys).toEqual([claimed.key]);
    expect(changed.changeSeq).toBeGreaterThan(seq);
  });

  describe("downloading a part", () => {
    async function connect() {
      const imap = await ImapMailSync.connect({
        host: credentials.host,
        port: credentials.port,
        security: "none",
        allowInsecure: true,
        auth: { user: credentials.user, pass: credentials.pass },
        parser: new PostalMimeParser(),
      });
      teardown.add(() => imap.close());
      return imap;
    }
    async function locationOf(subject: string) {
      const { message } = await filesOf(subject);
      const [location] = await box.store.getLocations(message.key);
      return location as NonNullable<typeof location>;
    }
    async function digest(content: AsyncIterable<Uint8Array>) {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of content) {
        hash.update(chunk);
        size += chunk.byteLength;
      }
      return { sha256: hash.digest("hex"), size };
    }

    it("gives a binary file of several megabytes back byte for byte", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();

      const part = await imap.attachments.download(await locationOf("Faktury"), "4");

      if (part.kind !== "found") throw new Error("expected the part");
      const got = await digest(part.content);
      expect(got.size).toBe(BIG.length);
      expect(got.sha256).toBe(sha256(BIG));
    });

    it("decodes a small file too, and the Polish-named one is the PDF it was", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();
      const part = await imap.attachments.download(await locationOf("Faktury"), "2");
      if (part.kind !== "found") throw new Error("expected the part");
      const chunks: Uint8Array[] = [];
      for await (const c of part.content) chunks.push(c);
      expect(Buffer.concat(chunks).toString("utf8")).toBe("%PDF-1.4 a small invoice");
    });

    it("leaves the message unread: it is fetched with PEEK", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();
      const part = await imap.attachments.download(await locationOf("Faktury"), "3");
      if (part.kind !== "found") throw new Error("expected the part");
      await digest(part.content);

      const [stored] = await admin.messages("INBOX");
      expect(stored?.flags).not.toContain("\\Seen");
    });

    it("says gone for a UID the folder does not have, and for a folder that is gone", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();
      const location = await locationOf("Faktury");

      expect(await imap.attachments.download({ ...location, uid: 9999 }, "2")).toEqual({
        kind: "gone",
      });
      expect(await imap.attachments.download({ ...location, folderId: "Nope" }, "2")).toEqual({
        kind: "gone",
      });
    });

    it("says gone, definitely, when the folder was rebuilt: the UID now means another message", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();
      const location = await locationOf("Faktury");

      const stale = await imap.attachments.download(
        { ...location, uidValidity: String(Number(location.uidValidity) + 1) },
        "2",
      );
      expect(stale).toEqual({ kind: "gone" });
    });

    it("keeps working on the same connection after a download was abandoned half way", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();
      const location = await locationOf("Faktury");

      const first = await imap.attachments.download(location, "4");
      if (first.kind !== "found") throw new Error("expected the part");
      let read = 0;
      for await (const chunk of first.content) {
        read += chunk.byteLength;
        if (read > 100_000) break;
      }

      const again = await imap.attachments.download(location, "4");
      if (again.kind !== "found") throw new Error("expected the part");
      expect((await digest(again.content)).sha256).toBe(sha256(BIG));
    });

    it("stops when it is asked to", async () => {
      await admin.append("INBOX", mixed("m1", "Faktury", BIG));
      await box.sync();
      const imap = await connect();
      const controller = new AbortController();
      const part = await imap.attachments.download(
        await locationOf("Faktury"),
        "4",
        controller.signal,
      );
      if (part.kind !== "found") throw new Error("expected the part");
      let read = 0;
      await expect(
        (async () => {
          for await (const chunk of part.content) {
            read += chunk.byteLength;
            if (read > 100_000) controller.abort();
          }
        })(),
      ).rejects.toThrow();
      expect(read).toBeLessThan(BIG.length);
    });
  });
});
