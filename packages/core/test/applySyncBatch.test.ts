import { describe, expect, it } from "vitest";
import type { ApplySyncBatchDeps, MessageLocation, SyncBatch } from "../src/index.ts";
import { applySyncBatch, UnknownProviderIdError } from "../src/index.ts";

/** Records the order of port calls. The store "has" provider ids p1 and p2 as keys 1 and 2. */
function recorder(
  options: {
    lastLocationGone?: readonly number[];
    pending?: readonly { key: number; seen: boolean }[];
    /** A cache of downloaded copies; absent by default, as in a store that has none. */
    received?: "works" | "fails";
  } = {},
) {
  const calls: string[] = [];
  const known = new Map([
    ["p1", 1],
    ["p2", 2],
  ]);
  const deps = {
    uow: {
      async run(work: () => Promise<unknown>) {
        calls.push("uow:start");
        const r = await work();
        calls.push("uow:end");
        return r;
      },
    },
    store: {
      async findByProviderIds(_a: string, ids: readonly string[]) {
        calls.push(`find:${ids.join(",")}`);
        return new Map(ids.flatMap((id) => (known.has(id) ? [[id, known.get(id)] as const] : [])));
      },
      async allocateKeys(dates: readonly number[]) {
        calls.push(`allocate:${dates.length}`);
        return dates.map((_, i) => 500 + i);
      },
      async upsertMessages(batch: readonly { key: number }[]) {
        calls.push(`upsert:${batch.map((m) => m.key).join(",")}`);
        return { changeSeq: 1, keys: batch.map((m) => m.key) };
      },
      async addLocations(entries: readonly { key: number }[]) {
        calls.push(`addLocations:${entries.map((e) => e.key).join(",")}`);
      },
      async setReplyTo(answers: readonly unknown[]) {
        calls.push(`replyTo:${answers.length}`);
        return [];
      },
      async setAttachments(answers: readonly unknown[]) {
        calls.push(`attachments:${answers.length}`);
        return [];
      },
      async updateFlags(updates: readonly unknown[]) {
        calls.push(`flags:${updates.length}`);
        return updates.map((_, i) => i);
      },
      async removeFolderLocations(_a: string, _f: string, keep?: string) {
        calls.push(`resetFolder:${keep}`);
        return { deletedKeys: [], survivingKeys: [] };
      },
      async removeLocations(locations: readonly MessageLocation[]) {
        calls.push(`removeLocations:${locations.map((l) => l.uid).join(",")}`);
        return { deletedKeys: options.lastLocationGone ?? [], survivingKeys: [] };
      },
      async deriveLabelsFromLocations(keys: readonly number[]) {
        calls.push(`derive:${keys.join(",")}`);
      },
      async setSeen(keys: readonly number[], seen: boolean) {
        calls.push(`setSeen:${seen}:${keys.join(",")}`);
        return { changeSeq: 2, changedKeys: keys };
      },
    },
    index: {
      async indexMessages() {
        calls.push("index");
      },
      async removeMessages(keys: readonly number[]) {
        calls.push(`unindex:${keys.join(",")}`);
      },
    },
    bodies: {
      async putBodies() {
        calls.push("bodies");
      },
      async removeBodies(keys: readonly number[]) {
        calls.push(`unbody:${keys.join(",")}`);
      },
    },
    cursors: {
      async set(accountId: string, folderId: string, cursor: unknown) {
        calls.push(`cursor:${accountId}:${folderId}:${JSON.stringify(cursor)}`);
      },
    },
    flagOps: {
      async listPending() {
        return options.pending ?? [];
      },
    },
    moveOps: {
      async listPending() {
        return [];
      },
    },
    ...(options.received
      ? {
          received: {
            async removeMessages(keys: readonly number[]) {
              calls.push(`unreceive:${keys.join(",")}`);
              if (options.received === "fails") throw new Error("disk gone");
            },
          },
        }
      : {}),
  } as unknown as ApplySyncBatchDeps;
  return { deps, calls };
}

const loc = (uid: number, folderId = "INBOX"): MessageLocation => ({
  accountId: "a",
  folderId,
  uidValidity: "9",
  uid,
});

const flags = { seen: true, flagged: false, answered: false, draft: false };

const doc = {
  message: {
    key: 5,
    accountId: "a",
    providerId: "p9",
    threadId: "t",
    messageIdHeader: "<x>",
    dateMs: 5,
    from: { address: "a@x" },
    to: [],
    cc: [],
    subject: "s",
    snippet: "",
    flags,
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown" as const,
  },
  bodyText: "b",
};

const empty: SyncBatch = {
  documents: [],
  knownLocations: [],
  flagUpdates: [],
  removedLocations: [],
  cursor: { uid: 1 },
};

describe("applySyncBatch", () => {
  it("adds documents and locations first, removals last, then the cursor, all in one unit", async () => {
    const { deps, calls } = recorder({ lastLocationGone: [1, 2] });
    const batch: SyncBatch = {
      ...empty,
      documents: [{ document: doc, location: loc(9) }],
      knownLocations: [{ providerId: "p1", location: loc(10), flags }],
      flagUpdates: [{ location: loc(3), flags }],
      removedLocations: [loc(1), loc(2)],
      cursor: { uid: 7 },
    };
    const result = await applySyncBatch(deps, { accountId: "a", folderId: "INBOX", batch });
    expect(calls).toEqual([
      "uow:start",
      "find:p9",
      "find:sent:<x>",
      "allocate:1",
      "upsert:500",
      "index",
      "bodies",
      "find:p1",
      "addLocations:500,1",
      "flags:2",
      "removeLocations:1,2",
      "unindex:1,2",
      "unbody:1,2",
      "derive:500",
      'cursor:a:INBOX:{"uid":7}',
      "uow:end",
    ]);
    expect(result.removedKeys).toEqual([1, 2]);
    expect(result.upserted.keys).toEqual([500]);
    expect(result.locationsAdded).toBe(1);
  });

  it("puts the unpushed read state back after everything that wrote flags, before the cursor", async () => {
    const { deps, calls } = recorder({
      pending: [
        { key: 1, seen: true },
        { key: 2, seen: false },
        { key: 3, seen: true },
      ],
    });
    const result = await applySyncBatch(deps, {
      accountId: "a",
      folderId: "INBOX",
      batch: { ...empty, flagUpdates: [{ location: loc(3), flags }], cursor: { uid: 8 } },
    });
    expect(calls.slice(-5)).toEqual([
      "flags:1",
      "setSeen:true:1,3",
      "setSeen:false:2",
      'cursor:a:INBOX:{"uid":8}',
      "uow:end",
    ]);
    expect(result.seenRestored).toBe(3);
  });

  it("reads the pending set once per batch and writes nothing when it is empty", async () => {
    const { deps, calls } = recorder();
    const result = await applySyncBatch(deps, { accountId: "a", folderId: "INBOX", batch: empty });
    expect(calls.filter((c) => c.startsWith("setSeen"))).toEqual([]);
    expect(result.seenRestored).toBe(0);
  });

  it("gives an already stored identity no new key", async () => {
    const { deps, calls } = recorder();
    const known = { ...doc, message: { ...doc.message, providerId: "p1" } };
    await applySyncBatch(deps, {
      accountId: "a",
      folderId: "INBOX",
      batch: { ...empty, documents: [{ document: known, location: loc(1) }] },
    });
    expect(calls).toContain("allocate:0");
    expect(calls).toContain("upsert:5");
  });

  it("skips removal work when nothing was removed and skips derivation for provider labels", async () => {
    const { deps, calls } = recorder();
    await applySyncBatch(deps, {
      accountId: "a",
      folderId: "f",
      batch: {
        ...empty,
        documents: [{ document: doc, location: loc(1, "f") }],
        removedLocations: [loc(2, "f")],
      },
      labelSource: "provider",
    });
    expect(calls.filter((c) => c.startsWith("unindex") || c.startsWith("unbody"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("derive"))).toEqual([]);
  });

  it("keeps the UIDVALIDITY the batch announces when it resets a folder", async () => {
    const { deps, calls } = recorder();
    await applySyncBatch(deps, {
      accountId: "a",
      folderId: "INBOX",
      batch: { ...empty, documents: [{ document: doc, location: loc(1) }], resetFolder: true },
    });
    expect(calls).toContain("resetFolder:9");
  });

  it("rejects a known location whose provider id the store does not have", async () => {
    const { deps } = recorder();
    await expect(
      applySyncBatch(deps, {
        accountId: "a",
        folderId: "INBOX",
        batch: { ...empty, knownLocations: [{ providerId: "gone", location: loc(1), flags }] },
      }),
    ).rejects.toBeInstanceOf(UnknownProviderIdError);
  });

  describe("Reply-To answers (ADR 0042, rule 7)", () => {
    it("stores them inside the unit, after the locations and before the cursor", async () => {
      const { deps, calls } = recorder();
      await applySyncBatch(deps, {
        accountId: "a",
        folderId: "INBOX",
        batch: {
          ...empty,
          flagUpdates: [{ location: loc(3), flags }],
          replyTos: [
            { location: loc(3), replyTo: [{ address: "help@shop.example" }] },
            { location: loc(4), replyTo: [] },
          ],
          cursor: { uid: 8 },
        },
      });
      const order = calls.filter(
        (c) =>
          c.startsWith("replyTo") ||
          c.startsWith("flags") ||
          c.startsWith("addLocations") ||
          c.startsWith("cursor") ||
          c.startsWith("uow"),
      );
      expect(order).toEqual([
        "uow:start",
        "addLocations:",
        "replyTo:2",
        "flags:1",
        'cursor:a:INBOX:{"uid":8}',
        "uow:end",
      ]);
    });

    it("does not touch the store when there are none", async () => {
      const { deps, calls } = recorder();
      await applySyncBatch(deps, { accountId: "a", folderId: "INBOX", batch: empty });
      await applySyncBatch(deps, {
        accountId: "a",
        folderId: "INBOX",
        batch: { ...empty, replyTos: [] },
      });
      expect(calls.some((c) => c.startsWith("replyTo"))).toBe(false);
    });

    it("lets a failing step undo them: the answers are only ever written inside the unit", async () => {
      const { deps, calls } = recorder();
      const failing = {
        ...deps,
        cursors: {
          set: async () => {
            throw new Error("disk full");
          },
        },
      } as unknown as ApplySyncBatchDeps;
      await expect(
        applySyncBatch(failing, {
          accountId: "a",
          folderId: "INBOX",
          batch: { ...empty, replyTos: [{ location: loc(3), replyTo: [] }] },
        }),
      ).rejects.toThrow("disk full");
      // The unit never reached its end, so a real store rolled the answers back with the rest.
      expect(calls).toContain("replyTo:1");
      expect(calls).not.toContain("uow:end");
    });
  });

  describe("attachment answers (ADR 0043, rule 2)", () => {
    const answer = {
      location: loc(3),
      attachments: [
        { partId: "2", name: "a.pdf", mimeType: "application/pdf", size: 5, inline: false },
      ],
    };

    it("stores them inside the unit, after the locations and before the cursor", async () => {
      const { deps, calls } = recorder();
      await applySyncBatch(deps, {
        accountId: "a",
        folderId: "INBOX",
        batch: {
          ...empty,
          documents: [{ document: doc, location: loc(3) }],
          attachmentAnswers: [answer],
          cursor: { uid: 8 },
        },
      });
      const order = calls.filter(
        (c) =>
          c.startsWith("attachments") ||
          c.startsWith("addLocations") ||
          c.startsWith("cursor") ||
          c.startsWith("uow"),
      );
      expect(order).toEqual([
        "uow:start",
        "addLocations:500",
        "attachments:1",
        'cursor:a:INBOX:{"uid":8}',
        "uow:end",
      ]);
    });

    it("does not touch the store when there are none", async () => {
      const { deps, calls } = recorder();
      await applySyncBatch(deps, { accountId: "a", folderId: "INBOX", batch: empty });
      await applySyncBatch(deps, {
        accountId: "a",
        folderId: "INBOX",
        batch: { ...empty, attachmentAnswers: [] },
      });
      expect(calls.some((c) => c.startsWith("attachments"))).toBe(false);
    });

    it("is undone with the rest when a later step fails", async () => {
      const { deps, calls } = recorder();
      const failing = {
        ...deps,
        cursors: {
          set: async () => {
            throw new Error("disk full");
          },
        },
      } as unknown as ApplySyncBatchDeps;
      await expect(
        applySyncBatch(failing, {
          accountId: "a",
          folderId: "INBOX",
          batch: { ...empty, attachmentAnswers: [answer] },
        }),
      ).rejects.toThrow("disk full");
      expect(calls).toContain("attachments:1");
      expect(calls).not.toContain("uow:end");
    });
  });

  describe("downloaded copies go with their message (ADR 0043, rule 8)", () => {
    it("removes them after the unit has committed, never inside it", async () => {
      const { deps, calls } = recorder({ lastLocationGone: [1, 2], received: "works" });
      await applySyncBatch(deps, {
        accountId: "a",
        folderId: "INBOX",
        batch: { ...empty, removedLocations: [loc(1), loc(2)] },
      });
      const end = calls.indexOf("uow:end");
      const gone = calls.indexOf("unreceive:1,2");
      expect(end).toBeGreaterThan(-1);
      expect(gone).toBeGreaterThan(end);
    });

    it("asks for nothing when no message was deleted", async () => {
      const { deps, calls } = recorder({ received: "works" });
      await applySyncBatch(deps, { accountId: "a", folderId: "INBOX", batch: empty });
      expect(calls.some((c) => c.startsWith("unreceive"))).toBe(false);
    });

    it("does not fail the batch when the files cannot be removed: the sweep takes them later", async () => {
      const { deps } = recorder({ lastLocationGone: [1], received: "fails" });
      await expect(
        applySyncBatch(deps, {
          accountId: "a",
          folderId: "INBOX",
          batch: { ...empty, removedLocations: [loc(1)] },
        }),
      ).resolves.toMatchObject({ removedKeys: [1] });
    });

    it("works without a cache at all", async () => {
      const { deps } = recorder({ lastLocationGone: [1] });
      await expect(
        applySyncBatch(deps, {
          accountId: "a",
          folderId: "INBOX",
          batch: { ...empty, removedLocations: [loc(1)] },
        }),
      ).resolves.toMatchObject({ removedKeys: [1] });
    });
  });
});
