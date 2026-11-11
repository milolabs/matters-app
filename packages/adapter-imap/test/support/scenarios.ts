import { applySyncBatch, parseQuery } from "@matters/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Admin, type Credentials } from "./admin.ts";
import { ACCOUNT, Mailbox, Teardown } from "./harness.ts";
import { mail } from "./mail.ts";

export interface ServerUnderTest {
  readonly credentials: Credentials;
  /** Prefix of provider ids this server's capabilities lead to (ADR 0016). */
  readonly idPrefix: "fp:" | "eid:";
  /** The server reports removals through QRESYNC VANISHED. */
  readonly qresync: boolean;
}

const BASE = Date.UTC(2026, 10, 1, 8, 0);
const minutes = (n: number) => new Date(BASE + n * 60_000);

/** 45 single messages (every fifth with a Polish subject), a three-message thread, two more. */
export function initialMailbox() {
  const singles = Array.from({ length: 45 }, (_, i) =>
    mail({
      id: `m${i}`,
      subject: i % 5 === 0 ? `Zażółć gęślą jaźń ${i}` : `Temat numer ${i}`,
      date: minutes(i),
    }),
  );
  const thread = [
    mail({ id: "t1", subject: "Plan wyjazdu: Łódź → Gdańsk", date: minutes(100) }),
    mail({
      id: "t2",
      subject: "Re: Plan wyjazdu: Łódź → Gdańsk",
      date: minutes(101),
      inReplyTo: "t1",
      references: ["t1"],
    }),
    mail({
      id: "t3",
      subject: "Re: Plan wyjazdu: Łódź → Gdańsk",
      date: minutes(102),
      inReplyTo: "t2",
      references: ["t1", "t2"],
    }),
  ];
  const extra = [
    mail({ id: "x1", subject: "Zażółć gęślą jaźń ISO", date: minutes(103) }),
    mail({ id: "x2", subject: "Faktura nr 12/2026", date: minutes(104) }),
  ];
  return [...singles, ...thread, ...extra];
}

/**
 * The behaviour every server with stable message ids or fingerprints must show. Called inside a
 * `describe`; `acquire` returns the server for one test.
 */
export function describeImapScenarios(
  acquire: () => Promise<{ server: ServerUnderTest; release: () => Promise<void> }>,
) {
  let held: Awaited<ReturnType<typeof acquire>>;
  let admin: Admin;
  let box: Mailbox;
  const teardown = new Teardown();
  const server = () => held.server;

  beforeEach(async () => {
    const acquired = await acquire();
    held = acquired;
    teardown.add(() => acquired.release());
    const connected = await Admin.connect(acquired.server.credentials);
    admin = connected;
    teardown.add(() => connected.close());
    await connected.reset();
    const opened = new Mailbox(acquired.server.credentials, 20);
    box = opened;
    teardown.add(() => opened.close());
  });
  afterEach(() => teardown.run());

  /** The cursor claims exactly the UIDs the store holds: no gap, nothing pending. */
  const expectRegion = async (count: number) => {
    const cursor = await box.storage.cursors.get(ACCOUNT.id, "INBOX");
    const stored = await box.store.listLocationUids(
      ACCOUNT.id,
      "INBOX",
      String(cursor?.uidValidity),
    );
    expect(stored).toHaveLength(count);
    expect(cursor).toMatchObject({
      complete: "1",
      lowUid: String(stored[0]),
      lastUid: String(stored[stored.length - 1]),
    });
  };

  const folder = (r: Awaited<ReturnType<Mailbox["sync"]>>, id: string) => {
    const f = r.folders.find((x) => x.folderId === id);
    if (!f) throw new Error(`no folder ${id} in ${r.folders.map((x) => x.folderId).join(",")}`);
    return f;
  };

  it("syncs a mailbox: Polish subjects, thread, search, bodies, nothing marked as read", async () => {
    await admin.appendMany("INBOX", initialMailbox());

    const started = performance.now();
    const result = await box.sync();
    const ms = Math.round(performance.now() - started);
    console.log(`initial sync of 50 messages: ${ms} ms (${server().idPrefix})`);

    expect(folder(result, "INBOX")).toMatchObject({ documents: 50, batches: 4, reset: false });
    const messages = await box.messages();
    expect(messages).toHaveLength(50);
    expect(messages.every((m) => m.providerId.startsWith(server().idPrefix))).toBe(true);
    expect(messages.every((m) => !m.flags.seen)).toBe(true);
    expect(box.stats.sourcesDownloaded).toBe(50);

    const polish = await box.bySubject("Zażółć gęślą jaźń 10");
    expect(polish.from).toEqual({ name: "Łukasz Żółkiewski", address: "lukasz@example.pl" });
    expect(polish.labelIds).toEqual(["INBOX"]);
    expect(polish.snippet).toBe("Treść wiadomości m10");
    const body = (await box.storage.read.bodies.getBodies([polish.key])).get(polish.key);
    expect(body).toBe("Treść wiadomości m10");

    const t1 = await box.bySubject("Plan wyjazdu: Łódź → Gdańsk");
    const replies = messages.filter((m) => m.subject.startsWith("Re: Plan wyjazdu"));
    expect(replies).toHaveLength(2);
    expect(new Set([t1, ...replies].map((m) => m.threadId)).size).toBe(1);
    const thread = await box.store.getThread(t1.threadId);
    expect(thread?.messages.map((m) => m.messageIdHeader)).toEqual([
      "<t1@example.pl>",
      "<t2@example.pl>",
      "<t3@example.pl>",
    ]);
    expect(messages.filter((m) => m.threadId === t1.threadId)).toHaveLength(3);

    const find = (q: string) => box.storage.read.index.search(parseQuery(q), { limit: 100 });
    expect(await find("zazolc")).toHaveLength(10);
    expect(await find("lodz gdansk")).toHaveLength(3);
    expect(await find("tresc")).toHaveLength(50);

    await expectRegion(50);
  });

  it("is idempotent: syncing again downloads and changes nothing", async () => {
    await admin.appendMany("INBOX", initialMailbox());
    await box.sync();
    const before = await box.storage.read.store.changesSince(0);
    const downloaded = box.stats.sourcesDownloaded;

    const again = await box.sync();

    expect(folder(again, "INBOX")).toMatchObject({
      documents: 0,
      knownLocations: 0,
      flagsUpdated: 0,
    });
    expect(box.stats.sourcesDownloaded).toBe(downloaded);
    expect((await box.storage.read.store.changesSince(0)).changeSeq).toBe(before.changeSeq);
  });

  it("picks up new mail incrementally and downloads only that", async () => {
    await admin.appendMany("INBOX", initialMailbox());
    await box.sync();
    await admin.appendMany("INBOX", [
      mail({ id: "n1", subject: "Nowa wiadomość: źdźbło", date: minutes(200) }),
      mail({ id: "n2", subject: "Druga nowa", date: minutes(201) }),
    ]);

    const result = await box.sync();

    expect(folder(result, "INBOX").documents).toBe(2);
    expect(box.stats.sourcesDownloaded).toBe(52);
    expect(await box.messages()).toHaveLength(52);
    await box.bySubject("Nowa wiadomość: źdźbło");
  });

  it("applies flag changes without downloading anything", async () => {
    const uids: number[] = [];
    for (const raw of initialMailbox().slice(0, 5)) uids.push(await admin.append("INBOX", raw));
    await box.sync();
    const downloaded = box.stats.sourcesDownloaded;
    const target = await box.bySubject("Zażółć gęślą jaźń 0");
    expect(target.flags.seen).toBe(false);

    await admin.flagAdd("INBOX", uids[0] as number, ["\\Seen", "\\Flagged"]);
    const result = await box.sync();

    expect(folder(result, "INBOX").flagsUpdated).toBe(1);
    expect(box.stats.sourcesDownloaded).toBe(downloaded);
    const after = await box.bySubject("Zażółć gęślą jaźń 0");
    expect(after.key).toBe(target.key);
    expect(after.flags).toMatchObject({ seen: true, flagged: true });
    const changes = await box.storage.read.store.changesSince(0);
    expect(changes.changedKeys).toContain(target.key);
  });

  it("removes expunged messages from store, index and bodies", async () => {
    const uids: number[] = [];
    for (const raw of initialMailbox().slice(0, 10)) uids.push(await admin.append("INBOX", raw));
    await box.sync();
    const doomed = await box.bySubject("Zażółć gęślą jaźń 5");
    const searches = box.stats.fullUidSearches;

    await admin.expunge("INBOX", uids[5] as number, uids[6] as number);
    const result = await box.sync();

    expect(folder(result, "INBOX")).toMatchObject({ locationsRemoved: 2, messagesDeleted: 2 });
    expect(await box.messages()).toHaveLength(8);
    expect(await box.store.getByKeys([doomed.key])).toEqual([]);
    expect(await box.storage.read.index.search(parseQuery("m5"), { limit: 10 })).toEqual([]);
    expect((await box.storage.read.bodies.getBodies([doomed.key])).size).toBe(0);
    if (server().qresync) expect(box.stats.fullUidSearches).toBe(searches);
  });

  it("keeps the key of a moved message and downloads nothing for it", async () => {
    const uid = await admin.append(
      "INBOX",
      mail({ id: "mv", subject: "Przeprowadzka: żółć", date: minutes(1) }),
    );
    await admin.createFolder("Archive");
    await box.sync();
    const before = await box.bySubject("Przeprowadzka: żółć");
    const downloaded = box.stats.sourcesDownloaded;
    expect(downloaded).toBe(1);

    await admin.move("INBOX", uid, "Archive");
    const result = await box.sync();

    expect(box.stats.sourcesDownloaded).toBe(downloaded);
    expect(folder(result, "Archive").knownLocations).toBe(1);
    expect(folder(result, "INBOX").locationsRemoved).toBe(1);
    const after = await box.bySubject("Przeprowadzka: żółć");
    expect(after.key).toBe(before.key);
    expect(after.threadId).toBe(before.threadId);
    expect(after.labelIds).toEqual(["Archive"]);
    expect(await box.messages()).toHaveLength(1);
    const body = (await box.storage.read.bodies.getBodies([after.key])).get(after.key);
    expect(body).toBe("Treść wiadomości mv");
  });

  it("adds a location for a copy, then drops it with the original folder's expunge", async () => {
    const uid = await admin.append("INBOX", mail({ id: "cp", subject: "Kopia", date: minutes(1) }));
    await admin.createFolder("Work");
    await box.sync();
    const before = await box.bySubject("Kopia");

    await admin.copy("INBOX", uid, "Work");
    await box.sync();
    expect(box.stats.sourcesDownloaded).toBe(1);
    const copied = await box.bySubject("Kopia");
    expect(copied.key).toBe(before.key);
    expect(copied.labelIds).toEqual(["INBOX", "Work"]);
    expect(await box.store.getLocations(copied.key)).toHaveLength(2);

    await admin.expunge("INBOX", uid);
    await box.sync();
    const left = await box.bySubject("Kopia");
    expect(left.labelIds).toEqual(["Work"]);
  });

  it("starts a folder over when UIDVALIDITY changes", async () => {
    await admin.createFolder("Work");
    await admin.appendMany("Work", [
      mail({ id: "w1", subject: "Stara praca", date: minutes(1) }),
      mail({ id: "w2", subject: "Stara praca dwa", date: minutes(2) }),
    ]);
    await box.sync();
    const first = await admin.uidValidity("Work");
    expect(await box.messages()).toHaveLength(2);

    // A recreated folder gets a new UIDVALIDITY; servers count in seconds, so wait for it.
    let second = first;
    for (let attempt = 0; second === first && attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1100));
      await admin.deleteFolder("Work");
      await admin.createFolder("Work");
      second = await admin.uidValidity("Work");
    }
    expect(second).not.toBe(first);
    await admin.append("Work", mail({ id: "w3", subject: "Nowa praca", date: minutes(3) }));

    const result = await box.sync();

    expect(folder(result, "Work")).toMatchObject({ reset: true, documents: 1, messagesDeleted: 2 });
    expect((await box.messages()).map((m) => m.subject)).toEqual(["Nowa praca"]);
    const cursor = await box.storage.cursors.get(ACCOUNT.id, "Work");
    expect(cursor?.uidValidity).toBe(second);
  });

  it("resumes an interrupted initial sync with the newest mail first and without re-downloads", async () => {
    await admin.appendMany("INBOX", initialMailbox());
    const imap = await box.connect();
    try {
      const inbox = (await imap.listFolders(ACCOUNT)).find((f) => f.id === "INBOX");
      if (!inbox) throw new Error("no INBOX");
      const context = {
        knownProviderIds: async (ids: readonly string[]) =>
          new Set((await box.store.findByProviderIds(ACCOUNT.id, ids)).keys()),
        storedUids: (uv: string) => box.store.listLocationUids(ACCOUNT.id, "INBOX", uv),
        unknownReplyToUids: (uv: string, limit: number) =>
          box.store.listUnknownReplyToUids(ACCOUNT.id, "INBOX", uv, limit),
        unknownAutomatedUids: (uv: string, limit: number) =>
          box.store.listUnknownAutomatedUids(ACCOUNT.id, "INBOX", uv, limit),
        unknownAttachmentUids: (uv: string, limit: number) =>
          box.store.listUnknownAttachmentUids(ACCOUNT.id, "INBOX", uv, limit),
      };
      const seen: number[][] = [];
      for await (const batch of imap.syncFolder(ACCOUNT, inbox, null, context)) {
        seen.push(batch.documents.map((d) => d.location.uid));
        await applySyncBatch(box.storage, { accountId: ACCOUNT.id, folderId: "INBOX", batch });
        if (seen.length === 2) break;
      }
      // Newest first: every UID of the first batch is above every UID of the second.
      expect(Math.min(...(seen[0] ?? []))).toBeGreaterThan(Math.max(...(seen[1] ?? [])));
      expect(await box.messages()).toHaveLength(40);
      expect(await box.storage.cursors.get(ACCOUNT.id, "INBOX")).toMatchObject({ complete: "0" });
      box.stats.sourcesDownloaded += imap.stats.sourcesDownloaded;
    } finally {
      await imap.close();
    }

    // Mail arrives while the older part is still pending.
    await admin.append("INBOX", mail({ id: "late", subject: "Spóźniona", date: minutes(300) }));
    const result = await box.sync();

    expect(folder(result, "INBOX").documents).toBe(11);
    expect(box.stats.sourcesDownloaded).toBe(51);
    expect(await box.messages()).toHaveLength(51);
    await expectRegion(51);
  });
}
