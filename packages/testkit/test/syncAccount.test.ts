import type { Account } from "@matters/core";
import { syncAccount } from "@matters/core";
import { describe, expect, it } from "vitest";
import { createInMemoryStorage, FakeMailSync } from "../src/index.ts";

const account: Account = {
  id: "acc1",
  address: "me@example.com",
  displayName: "Me",
  capabilities: [],
};

function setup(folders: readonly string[] = ["INBOX", "Archive"]) {
  const storage = createInMemoryStorage();
  const sync = new FakeMailSync(folders);
  const run = () => syncAccount({ ...storage, sync }, account);
  const keyOf = async (providerId: string) =>
    (await storage.store.findByProviderIds("acc1", [providerId])).get(providerId);
  const subjects = async () =>
    (await storage.store.listNewest({ limit: 100 })).map((m) => m.subject).sort();
  return { storage, sync, run, keyOf, subjects };
}

describe("syncAccount", () => {
  it("syncs every folder, derives labels from locations and reports counts per folder", async () => {
    const { storage, sync, run, keyOf } = setup();
    sync.add("INBOX", "a");
    sync.add("INBOX", "b");
    sync.add("Archive", "c");

    const result = await run();

    expect(result.folders.map((f) => [f.folderId, f.documents, f.knownLocations])).toEqual([
      ["INBOX", 2, 0],
      ["Archive", 1, 0],
    ]);
    const messages = await storage.store.listNewest({ limit: 10 });
    expect(messages.map((m) => m.labelIds).sort()).toEqual([["Archive"], ["INBOX"], ["INBOX"]]);
    expect(await storage.store.getLocations((await keyOf("a")) as number)).toHaveLength(1);
    expect(await storage.cursors.get("acc1", "INBOX")).toEqual({ uidValidity: "1", lastUid: "2" });
  });

  it("stores the folders the server lists, with what each is, and hides Trash and Spam (ADR 0044)", async () => {
    const { storage, sync, run, subjects } = setup(["INBOX", "Archive", "Trash", "Junk"]);
    sync.roles.set("Archive", "archive");
    sync.roles.set("Trash", "trash");
    sync.roles.set("Junk", "spam");
    sync.add("INBOX", "in", "Inbox mail");
    sync.add("Trash", "bin", "Deleted mail");
    sync.add("Junk", "ad", "Advert");

    await run();

    expect(
      (await storage.store.listFolders("acc1")).map((f) => `${f.id}:${f.role}:${f.exclusive}`),
    ).toEqual(["Archive:archive:true", "INBOX:inbox:true", "Junk:spam:true", "Trash:trash:true"]);
    // Folders are listed first, so the mail was sorted as it came: nothing wrong is ever shown.
    expect(await subjects()).toEqual(["Inbox mail"]);
    expect(
      (
        await storage.index.search(
          { root: { kind: "in", role: "trash" }, tokens: [], diagnostics: [] },
          { limit: 10 },
        )
      ).length,
    ).toBe(1);

    // A second run lists them again and changes nothing.
    const seq = (await storage.store.changesSince(0)).changeSeq;
    await run();
    expect((await storage.store.changesSince(0)).changeSeq).toBe(seq);
  });

  it("puts a pending move back over the folders it lists, so a role change cannot undo it", async () => {
    const { storage, sync, run, keyOf } = setup(["INBOX", "Archive"]);
    sync.roles.set("Archive", "archive");
    sync.add("INBOX", "a");
    await run();
    const key = (await keyOf("a")) as number;
    const { moveThread } = await import("@matters/core");
    await moveThread(
      { ...storage, now: () => 1, newId: () => "op1" },
      {
        threadId: (await storage.store.getByKeys([key]))[0]?.threadId as string,
        action: "archive",
      },
    );
    expect((await storage.store.getByKeys([key]))[0]?.mailboxes).toBe(32);
    await run();
    expect((await storage.store.getByKeys([key]))[0]).toMatchObject({
      labelIds: ["Archive"],
      mailboxes: 32,
    });
    expect(await storage.moveOps.listPending()).toHaveLength(1);
  });

  it("is idempotent: a second run changes and downloads nothing", async () => {
    const { storage, sync, run } = setup();
    sync.add("INBOX", "a");
    await run();
    const seq = (await storage.store.changesSince(0)).changeSeq;
    const again = await run();
    expect(sync.downloads).toEqual(["a"]);
    expect(again.folders.every((f) => f.documents === 0 && f.knownLocations === 0)).toBe(true);
    expect((await storage.store.changesSince(0)).changeSeq).toBe(seq);
  });

  it("keeps the key of a moved message and downloads it once, whatever the folder order", async () => {
    for (const order of [
      ["INBOX", "Archive"],
      ["Archive", "INBOX"],
    ]) {
      const { storage, sync, run, keyOf } = setup(order);
      const uid = sync.add("INBOX", "mover");
      await run();
      const key = await keyOf("mover");

      sync.move("INBOX", uid, "Archive");
      const result = await run();

      expect(await keyOf("mover")).toBe(key);
      expect(sync.downloads).toEqual(["mover"]);
      const inArchive = result.folders.find((f) => f.folderId === "Archive");
      expect(inArchive?.knownLocations).toBe(1);
      expect((await storage.store.getByKeys([key as number]))[0]?.labelIds).toEqual(["Archive"]);
      expect(await storage.store.listNewest({ limit: 10 })).toHaveLength(1);
    }
  });

  it("adds a location for a copy and deletes the message only when the last copy is expunged", async () => {
    const { storage, sync, run, keyOf, subjects } = setup();
    const uid = sync.add("INBOX", "dup");
    await run();
    const copy = sync.copy("INBOX", uid, "Archive");
    await run();
    const key = (await keyOf("dup")) as number;
    expect((await storage.store.getByKeys([key]))[0]?.labelIds).toEqual(["Archive", "INBOX"]);
    expect(sync.downloads).toEqual(["dup"]);

    sync.expunge("INBOX", uid);
    await run();
    expect(await subjects()).toEqual(["dup"]);

    sync.expunge("Archive", copy);
    const result = await run();
    expect(await subjects()).toEqual([]);
    expect(result.folders.reduce((n, f) => n + f.messagesDeleted, 0)).toBe(1);
    expect((await storage.bodies.getBodies([key])).size).toBe(0);
  });

  it("applies a folder's removals only after every folder had its additions, and keeps the cursor back if a later folder fails", async () => {
    const { storage, sync, run, keyOf } = setup();
    const uid = sync.add("INBOX", "mover");
    await run();
    sync.move("INBOX", uid, "Archive");
    sync.failing.add("Archive");
    await expect(run()).rejects.toThrow("Archive failed");
    // INBOX had a removal: its batch was held back, so neither the removal nor the cursor landed.
    expect(await storage.cursors.get("acc1", "INBOX")).toEqual({ uidValidity: "1", lastUid: "1" });
    expect(await keyOf("mover")).toBeDefined();

    sync.failing.clear();
    await run();
    expect(sync.downloads).toEqual(["mover"]);
    expect(await storage.store.listNewest({ limit: 10 })).toHaveLength(1);
  });

  it("starts a folder over when UIDVALIDITY changes and keeps what other folders still hold", async () => {
    const { storage, sync, run, keyOf, subjects } = setup();
    const gone = sync.add("INBOX", "gone");
    const copied = sync.add("INBOX", "copied");
    sync.copy("INBOX", copied, "Archive");
    await run();
    const keptKey = await keyOf("copied");

    sync.recreate("INBOX");
    sync.add("INBOX", "fresh");
    const result = await run();

    expect(gone).toBe(1);
    expect(result.folders[0]?.reset).toBe(true);
    expect(await subjects()).toEqual(["copied", "fresh"]);
    expect(await keyOf("copied")).toBe(keptKey);
    expect(await storage.store.listLocationUids("acc1", "INBOX", "1")).toEqual([]);
    expect(await storage.store.listLocationUids("acc1", "INBOX", "2")).toEqual([1]);
  });
});
