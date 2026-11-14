import type { SyncBatch } from "@matters/core";
import { describe, expect, it } from "vitest";
import { ACCOUNT, downloads, harness, mail, target } from "./support.ts";

describe("GraphMailSync over the stand-in (ADR 0136, rules 5 and 6)", () => {
  it("lists folders with the roles of the well-known ones, children under their parent", async () => {
    const h = await harness();
    const projects = h.server.addFolder("Projects");
    h.server.addFolder("2026", projects);
    const connection = await h.connector.connect(target());
    const folders = await connection.sync.listFolders(ACCOUNT);
    const byName = new Map(folders.map((f) => [f.name, f]));
    expect(byName.get("Inbox")?.role).toBe("inbox");
    expect(byName.get("Sent Items")?.role).toBe("sent");
    expect(byName.get("Drafts")?.role).toBe("drafts");
    expect(byName.get("Deleted Items")?.role).toBe("trash");
    expect(byName.get("Junk Email")?.role).toBe("spam");
    expect(byName.get("Archive")?.role).toBe("archive");
    expect(byName.get("Projects")?.role).toBe("other");
    expect(byName.get("Projects/2026")?.id).toBeDefined();
    // Every request carried the token and asked for immutable ids.
    expect(
      h.server.requests.every((r) => r.bearer && r.prefer.includes('IdType="ImmutableId"')),
    ).toBe(true);
  });

  it("first sync: every message is fetched as MIME once and parsed, newest first", async () => {
    const h = await harness();
    const ids = ["one", "two", "three"].map((name, i) =>
      h.server.addMessage("inbox", mail(name), {
        receivedMs: Date.UTC(2026, 10, 1 + i),
        isRead: i === 0,
      }),
    );
    const result = await h.sync();
    expect(result.downloads).toBe(3);
    expect(downloads(h.server)).toBe(3);
    const messages = await h.messages();
    expect(messages.map((m) => m.subject).sort()).toEqual(["one", "three", "two"]);
    const one = messages.find((m) => m.subject === "one");
    expect(one?.providerId).toBe(ids[0]);
    expect(one?.flags.seen).toBe(true);
    expect(one?.labelIds).toEqual([h.server.wellKnown.inbox]);
    const [location] = await h.storage.store.getLocations(one?.key as number);
    expect(location?.itemId).toBe(ids[0]);
    // The delta query asked only what sync needs, newest first, in pages of two.
    const first = h.server.requestsTo("/messages/delta?$select")[0];
    expect(first?.path).toContain("$orderby=receivedDateTime+desc");
    expect(first?.prefer).toContain("odata.maxpagesize=2");
    // A second run with nothing new downloads nothing.
    expect((await h.sync()).downloads).toBe(0);
  });

  it("incremental sync: a new message, a read state, a removal", async () => {
    const h = await harness();
    const a = h.server.addMessage("inbox", mail("a"));
    const b = h.server.addMessage("inbox", mail("b"));
    await h.sync();
    h.server.setRead(a, true);
    h.server.remove(b);
    h.server.addMessage("inbox", mail("c"));
    const result = await h.sync();
    expect(result.downloads).toBe(1);
    const messages = await h.messages();
    expect(messages.map((m) => m.subject).sort()).toEqual(["a", "c"]);
    expect(messages.find((m) => m.subject === "a")?.flags.seen).toBe(true);
    expect(await h.keyOf(b)).toBeUndefined();
    // The second round asked the delta link, not the folder anew.
    expect(h.server.requestsTo("$deltatoken=").length).toBeGreaterThan(0);
  });

  it("a row that leaves out the flag keeps the stored one: the message is asked", async () => {
    const h = await harness();
    const a = h.server.addMessage("inbox", mail("a"), { flagged: true });
    await h.sync();
    const flagsOfA = async () => (await h.messages()).find((m) => m.subject === "a")?.flags;
    expect((await flagsOfA())?.flagged).toBe(true);
    // An updated message's row may carry only what changed (the delta query overview).
    for (const key of ["flag", "isDraft"]) h.server.deltaOmits.add(key);
    h.server.setRead(a, true);
    const result = await h.sync();
    expect(result.downloads).toBe(0);
    expect(await flagsOfA()).toMatchObject({ seen: true, flagged: true, draft: false });
    expect(h.server.requestsTo(`/me/messages/${a}?$select=`).length).toBe(1);
  });

  it("a move is a new location of the known message: same key, no second download", async () => {
    const h = await harness();
    const id = h.server.addMessage("inbox", mail("moved", { subject: "moved over graph" }));
    await h.sync();
    const key = await h.keyOf(id);
    const before = downloads(h.server);
    h.server.move(id, "archive");
    const result = await h.sync();
    expect(result.downloads).toBe(0);
    expect(downloads(h.server)).toBe(before);
    expect(await h.keyOf(id)).toBe(key);
    const [m] = await h.storage.store.getByKeys([key as number]);
    expect(m?.labelIds).toEqual([h.server.wellKnown.archive]);
    const locations = await h.storage.store.getLocations(key as number);
    expect(locations.map((l) => [l.folderId, l.itemId])).toEqual([
      [h.server.wellKnown.archive, id],
    ]);
  });

  it("follows the batch order of the contract: additions first, removals and the delta link last", async () => {
    const h = await harness();
    for (const n of [1, 2, 3, 4, 5]) h.server.addMessage("inbox", mail(`m${n}`));
    const gone = h.server.addMessage("inbox", mail("gone"));
    const connection = await h.connector.connect(target());
    const folders = await connection.sync.listFolders(ACCOUNT);
    const inbox = folders.find((f) => f.role === "inbox");
    const run = async (cursor: SyncBatch["cursor"] | null) => {
      const batches: SyncBatch[] = [];
      const context = contextOver(h);
      for await (const b of connection.sync.syncFolder(
        ACCOUNT,
        inbox as never,
        cursor,
        context(inbox?.id as string),
      )) {
        batches.push(b);
      }
      return batches;
    };
    const first = await run(null);
    expect(first.length).toBeGreaterThan(2);
    for (const b of first.slice(0, -1)) {
      expect(b.removedLocations).toEqual([]);
      expect(b.flagUpdates).toEqual([]);
      expect(b.cursor.stage).toBe("page");
    }
    const last = first.at(-1) as SyncBatch;
    expect(last.documents).toEqual([]);
    expect(last.cursor.stage).toBe("delta");
    expect(String(last.cursor.link)).toContain("$deltatoken=");
    // The full round ends with `resetFolder` and an anchor at its epoch.
    expect(last.resetFolder).toBe(true);
    expect(last.knownLocations.map((k) => k.location.uidValidity)).toEqual([
      last.cursor.uidValidity,
    ]);

    h.server.remove(gone);
    const second = await run(last.cursor);
    expect(second.at(-1)?.removedLocations.map((l) => l.itemId)).toEqual([gone]);
    expect(second.at(-1)?.resetFolder).toBeUndefined();
  });

  it("resumes from the page link a stopped run committed", async () => {
    const h = await harness();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      h.server.addMessage("inbox", mail(`r${n}`), { receivedMs: Date.UTC(2026, 10, n) });
    }
    // Stop after the first batch of the inbox was applied.
    const connection = await h.connector.connect(target());
    const { syncAccount, SyncAbortedError } = await import("@matters/core");
    const signal = { aborted: false };
    await expect(
      syncAccount({ ...h.storage, sync: connection.sync }, ACCOUNT, {
        signal,
        onBatchApplied: (folder) => {
          if (folder.role === "inbox") signal.aborted = true;
        },
      }),
    ).rejects.toBeInstanceOf(SyncAbortedError);
    const cursor = await h.storage.cursors.get(ACCOUNT.id, h.server.wellKnown.inbox as string);
    expect(cursor?.stage).toBe("page");
    expect(String(cursor?.link)).toContain("$skiptoken=");
    expect((await h.messages()).length).toBe(2);

    // The stopped run may have read one page more than it applied; what it applied stays.
    const resumed = await h.sync();
    expect(resumed.downloads).toBe(4);
    expect((await h.messages()).length).toBe(6);
    // The resumed run went on from the page link, not from the start of the folder.
    const firstRounds = h.server.requestsTo(
      `/mailFolders/${h.server.wellKnown.inbox}/messages/delta?$select`,
    );
    expect(firstRounds.length).toBe(1);
  });

  it("an expired delta link lists the folder anew: new epoch, same numbers, no download", async () => {
    const h = await harness();
    const a = h.server.addMessage("inbox", mail("a"));
    const b = h.server.addMessage("inbox", mail("b"));
    await h.sync();
    const keyA = await h.keyOf(a);
    const [before] = await h.storage.store.getLocations(keyA as number);
    h.server.expireDeltaTokens();
    h.server.remove(b);
    const result = await h.sync();
    expect(result.downloads).toBe(0);
    expect(result.folders.find((f) => f.folderId === h.server.wellKnown.inbox)?.reset).toBe(true);
    const [after] = await h.storage.store.getLocations(keyA as number);
    expect(after?.uid).toBe(before?.uid);
    expect(after?.uidValidity).not.toBe(before?.uidValidity);
    expect(Number(after?.uidValidity)).toBeGreaterThan(Number(before?.uidValidity));
    expect(await h.keyOf(b)).toBeUndefined();
    expect(await h.keyOf(a)).toBe(keyA);
    // The next round goes on from the new link.
    h.server.addMessage("inbox", mail("c"));
    expect((await h.sync()).downloads).toBe(1);
  });

  it("keeps the epoch and the highest number in the cursor for the arrivals", async () => {
    const h = await harness();
    h.server.addMessage("inbox", mail("x"));
    h.server.addMessage("inbox", mail("y"));
    await h.sync();
    const marks = await h.storage.read.arrivals.marks();
    const inbox = marks.find((m) => m.folderId === h.server.wellKnown.inbox);
    expect(inbox?.uid).toBe(2);
    const cursor = await h.storage.cursors.get(ACCOUNT.id, h.server.wellKnown.inbox as string);
    expect(inbox?.uidValidity).toBe(cursor?.uidValidity);
  });

  it("does not follow a link that points away from Graph, and commits nothing with it", async () => {
    const h = await harness();
    for (const n of [1, 2, 3]) h.server.addMessage("inbox", mail(`l${n}`));
    h.server.linkBase = "http://graph.example.invalid/v1.0";
    await expect(h.sync()).rejects.toMatchObject({ name: "GraphLinkError" });
    expect(h.server.requests.every((r) => !r.path.includes("invalid"))).toBe(true);
    const cursor = await h.storage.cursors.get(ACCOUNT.id, h.server.wellKnown.inbox as string);
    expect(cursor).toBeNull();
  });
});

/** The use case's context over the harness's store, for driving `syncFolder` by hand. */
function contextOver(h: Awaited<ReturnType<typeof harness>>) {
  const store = h.storage.store;
  return (folderId: string) => ({
    async knownProviderIds(ids: readonly string[]) {
      return new Set((await store.findByProviderIds(ACCOUNT.id, ids)).keys());
    },
    storedUids: (v: string) => store.listLocationUids(ACCOUNT.id, folderId, v),
    unknownReplyToUids: async () => [],
    unknownAutomatedUids: async () => [],
    unknownAttachmentUids: async () => [],
    itemUids: (ids: readonly string[]) => store.numberItems(ACCOUNT.id, folderId, ids),
    knownItemUids: (ids: readonly string[]) => store.itemNumbers(ACCOUNT.id, folderId, ids),
    itemIdsOf: (uids: readonly number[]) => store.itemIdsOf(ACCOUNT.id, folderId, uids),
  });
}
