// The stand-in for a mailbox with immutable ids (ADR 0136, rule 6) reads its log as a delta
// round would: the cursor a round ends with is the end of what it read.
import type { FolderSyncContext, Label, SyncBatch } from "@matters/core";
import { describe, expect, it } from "vitest";
import { FakeItemSync } from "../src/index.ts";

const account = { id: "acc1", address: "me@example.com", displayName: "Me", capabilities: [] };
const inbox: Label = {
  id: "Inbox",
  accountId: "acc1",
  name: "Inbox",
  role: "inbox",
  exclusive: true,
};

function context(): FolderSyncContext {
  const numbers = new Map<string, number>();
  return {
    knownProviderIds: async () => new Set(),
    storedUids: async () => [],
    unknownReplyToUids: async () => [],
    unknownAutomatedUids: async () => [],
    unknownAttachmentUids: async () => [],
    itemUids: async (ids) => {
      for (const id of ids) if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
      return new Map(ids.map((id) => [id, numbers.get(id) as number]));
    },
    knownItemUids: async () => new Map(),
    itemIdsOf: async () => new Map(),
  } as FolderSyncContext;
}

describe("FakeItemSync", () => {
  it("leaves an item added while a round runs to the next round", async () => {
    const server = new FakeItemSync(["Inbox"]);
    server.add("Inbox", "a");
    const ctx = context();
    const batches: SyncBatch[] = [];
    for await (const batch of server.syncFolder(account, inbox, null, ctx)) {
      batches.push(batch);
      if (batches.length === 1) server.add("Inbox", "b");
    }
    const cursor = batches.at(-1)?.cursor ?? null;
    expect(cursor).toEqual({ read: 1 });

    const next: string[] = [];
    for await (const batch of server.syncFolder(account, inbox, cursor, ctx)) {
      for (const d of batch.documents) next.push(d.document.message.providerId);
    }
    expect(next).toEqual(["b"]);
  });
});
