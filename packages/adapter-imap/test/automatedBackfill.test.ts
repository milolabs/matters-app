import { PostalMimeParser } from "@matters/adapter-mime";
import type { MimeParserPort, ParsedMessage } from "@matters/core";
import { syncAccount } from "@matters/core";
import { describe, expect, it } from "vitest";
import { ImapMailSync } from "../src/index.ts";
import { Admin } from "./support/admin.ts";
import { ACCOUNT, Mailbox } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n));

/** What a build from before ADR 0066 stored: the message, and no flag for a list or a program. */
class ParserOfThePast implements MimeParserPort {
  private readonly inner = new PostalMimeParser();
  async parse(raw: Uint8Array): Promise<ParsedMessage> {
    const { automated: _forgotten, ...rest } = await this.inner.parse(raw);
    return rest as ParsedMessage;
  }
}

describe("learning whether stored mail is automated, from four headers (ADR 0066, rule 6)", () => {
  async function setup() {
    const server = await startHoodiecrow([]);
    const admin = await Admin.connect(server.credentials);
    const box = new Mailbox(server.credentials, 20);
    const stop = async () => {
      box.close();
      await admin.close();
      await server.stop();
    };

    /** A sync as the previous version did it: sources parsed without the flag. */
    async function syncAsBefore() {
      const imap = await ImapMailSync.connect({
        host: server.credentials.host,
        port: server.credentials.port,
        security: "none",
        allowInsecure: true,
        auth: { user: server.credentials.user, pass: server.credentials.pass },
        parser: new ParserOfThePast(),
        batchSize: 20,
      });
      try {
        // That build never asked the server, so the store says nothing is waiting to be learned.
        const store = Object.create(box.storage.store, {
          listUnknownAutomatedUids: { value: async () => [] },
        });
        await syncAccount({ ...box.storage, store, sync: imap }, ACCOUNT);
        box.stats.sourcesDownloaded += imap.stats.sourcesDownloaded;
      } finally {
        await imap.close();
      }
    }
    const unknown = async () => {
      const cursor = await box.storage.cursors.get(ACCOUNT.id, "INBOX");
      return box.store.listUnknownAutomatedUids(
        ACCOUNT.id,
        "INBOX",
        String(cursor?.uidValidity),
        1000,
      );
    };
    const flags = async () =>
      Object.fromEntries((await box.messages()).map((m) => [m.subject, m.automated]));
    return { admin, box, stop, syncAsBefore, unknown, flags };
  }

  const appendFour = (admin: Admin) =>
    admin.appendMany("INBOX", [
      mail({ id: "person", subject: "person", date: at(1) }),
      mail({
        id: "list",
        subject: "list",
        date: at(2),
        headers: ["List-Unsubscribe: <mailto:leave@example.pl>"],
      }),
      mail({
        id: "bounce",
        subject: "bounce",
        date: at(3),
        headers: ["Auto-Submitted: auto-generated"],
      }),
      mail({
        id: "answered",
        subject: "answered",
        date: at(4),
        headers: ["Auto-Submitted: no", "Precedence: normal"],
      }),
    ]);

  it("learns it for stored mail from the headers alone, with no source download", async () => {
    const t = await setup();
    try {
      await appendFour(t.admin);
      await t.syncAsBefore();
      expect(t.box.stats.sourcesDownloaded).toBe(4);
      expect(await t.flags()).toEqual({
        person: undefined,
        list: undefined,
        bounce: undefined,
        answered: undefined,
      });
      expect((await t.unknown()).length).toBe(4);

      await t.box.sync();

      expect(t.box.stats.sourcesDownloaded).toBe(4);
      expect(t.box.stats.automatedFetches).toBe(1);
      // The same decision as the parser makes for new mail: a list or a program is true, a person false.
      expect(await t.flags()).toEqual({
        person: false,
        list: true,
        bounce: true,
        answered: false,
      });
      expect(await t.unknown()).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  it("sends no further request once nothing is unknown, however often it syncs", async () => {
    const t = await setup();
    try {
      await appendFour(t.admin);
      await t.syncAsBefore();
      await t.box.sync();
      expect(t.box.stats.automatedFetches).toBe(1);
      await t.box.sync();
      await t.box.sync();
      expect(t.box.stats.automatedFetches).toBe(1);
      expect(t.box.stats.sourcesDownloaded).toBe(4);
    } finally {
      await t.stop();
    }
  });

  it("asks nothing for mail whose source was parsed with the flag", async () => {
    const t = await setup();
    try {
      await appendFour(t.admin);
      await t.box.sync();
      expect(t.box.stats.automatedFetches).toBe(0);
      expect(await t.flags()).toMatchObject({ person: false, list: true });
    } finally {
      await t.stop();
    }
  });

  it("learns one batch of a folder per sync, newest first", async () => {
    const t = await setup();
    try {
      await t.admin.appendMany(
        "INBOX",
        Array.from({ length: 25 }, (_, i) =>
          mail({
            id: `n${i}`,
            subject: `List ${i}`,
            date: at(i),
            headers: ["List-Id: <news.example>"],
          }),
        ),
      );
      await t.syncAsBefore();
      const before = await t.unknown();
      expect(before).toHaveLength(25);

      await t.box.sync();
      // Batch size 20: the 20 newest are known, the 5 oldest wait for the next sync.
      expect(await t.unknown()).toEqual(before.slice(0, 5));
      expect(t.box.stats.automatedFetches).toBe(1);

      await t.box.sync();
      expect(await t.unknown()).toEqual([]);
      expect(t.box.stats.automatedFetches).toBe(2);
      expect(t.box.stats.sourcesDownloaded).toBe(25);
    } finally {
      await t.stop();
    }
  });

  it("leaves a UID the server does not return unknown, and does not loop on it", async () => {
    const t = await setup();
    try {
      await appendFour(t.admin);
      await t.syncAsBefore();
      const cursor = await t.box.storage.cursors.get(ACCOUNT.id, "INBOX");
      const uidValidity = String(cursor?.uidValidity);
      const stored = await t.box.store.listLocationUids(ACCOUNT.id, "INBOX", uidValidity);

      const imap = await t.box.connect();
      try {
        const inbox = (await imap.listFolders(ACCOUNT)).find((f) => f.id === "INBOX");
        if (!inbox) throw new Error("no INBOX");
        const context = {
          knownProviderIds: async () => new Set<string>(),
          storedUids: async () => stored,
          unknownReplyToUids: async () => [],
          // The store believes in a UID that the server never had; it is asked about, not answered.
          unknownAutomatedUids: async () => [...stored, 9999],
          unknownAttachmentUids: async () => [],
        };
        const batches = [];
        for await (const b of imap.syncFolder(ACCOUNT, inbox, cursor, context)) batches.push(b);
        const answered = batches.at(-1)?.automatedAnswers?.map((r) => r.location.uid) ?? [];
        expect(answered.sort((x, y) => x - y)).toEqual(stored);
        // One request for the whole folder's pass: nothing is retried within a run.
        expect(imap.stats.automatedFetches).toBe(1);
      } finally {
        await imap.close();
      }
    } finally {
      await t.stop();
    }
  });
});
