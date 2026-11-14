// ADR 0138, rules 6, 9 and 10: the words of the review and of a removal, the confirmation, and the
// low-disk path of the compaction after a removal.
import { describe, expect, it } from "vitest";
import { compactionBudget, databaseCompaction } from "../src/backend/compaction.ts";
import { createEraseBridge } from "../src/preload/eraseBridge.ts";
import { createStorageBridge } from "../src/preload/storageBridge.ts";
import {
  confirms,
  erasedLine,
  partialHeading,
  reviewRows,
  reviewTotal,
  unreadableReason,
  unsentWarning,
} from "../src/renderer/eraseView.ts";
import { removalNotice } from "../src/renderer/removal.ts";

const groups = {
  signIns: 0,
  mail: 3_000_000,
  files: 0,
  agents: 80_000,
  settings: 1_000,
  caches: 0,
};

describe("the review", () => {
  it("confirms on the exact word only", () => {
    expect(confirms("erase")).toBe(true);
    for (const typed of ["Erase", "erase ", " erase", "eras", "ERASE", ""]) {
      expect(confirms(typed)).toBe(false);
    }
  });

  it("adds main's folders to the database's groups and names the accounts and messages", () => {
    const db = { groups, accounts: 2, messages: 1234, unsent: 0 };
    const main = {
      groups: { ...groups, mail: 0, files: 500_000, caches: 46_000_000 },
      earlier: null,
    };
    const rows = reviewRows(db, main);
    expect(rows.map((r) => r.id)).toEqual([
      "signIns",
      "mail",
      "files",
      "agents",
      "settings",
      "caches",
    ]);
    expect(rows[0]?.amount).toBe("2 accounts");
    expect(rows[1]?.detail).toMatch(/^1,234 messages/);
    expect(rows[2]?.amount).toBe("500 KB");
    expect(reviewTotal(db, main)).toBe(3_000_000 + 500_000 + 160_000 + 2_000 + 46_000_000);
  });

  it("names unsent mail only when there is some, and never says securely", () => {
    expect(unsentWarning(0)).toBeNull();
    expect(unsentWarning(1)).toBe(
      "1 message is still waiting to be sent. Erasing drops it unsent.",
    );
    expect(unsentWarning(2)).toMatch(/^2 messages are still waiting/);
    const words = [unsentWarning(3), erasedLine(8_270_000_000, 11_000, true), partialHeading(2)];
    for (const w of words) expect(w).not.toMatch(/secure|shred/i);
    expect(erasedLine(8_270_000_000, 11_000, true)).toBe(
      "8.3 GB erased in 11 seconds, the earlier copy included.",
    );
    expect(partialHeading(2)).toBe("Almost all of it is gone. Two things are still here.");
  });
});

describe("after a removal (rule 6)", () => {
  it("says the space and traces stay when the disk is too full to compact", async () => {
    let compacted = false;
    const port = databaseCompaction({
      storage: {
        accountData: { mergeIndexes: async () => {} } as never,
        storageSamples: {
          compact: async () => {
            compacted = true;
            return { freedBytes: 1, ms: 1 };
          },
        } as never,
      },
      dbPath: "/nowhere/matters.db",
      freeBytes: async () => 1_000,
      databaseBytes: async () => 2_000_000_000,
    });
    const outcome = await port.compactAfterRemoval();
    expect(outcome).toEqual({ kind: "lowDisk", neededBytes: 4_000_000_000, freeBytes: 1_000 });
    expect(compacted).toBe(false);
    expect(removalNotice("a@b.c", outcome)).toMatch(
      /^a@b\.c is removed\. The disk has too little free space .* traces of the removed mail, stay/,
    );
  });

  it("asks room for the temporary copy and the log, twice the database", async () => {
    let compacted = false;
    const port = databaseCompaction({
      storage: {
        accountData: { mergeIndexes: async () => {} } as never,
        storageSamples: {
          compact: async () => {
            compacted = true;
            return { freedBytes: 1, ms: 1 };
          },
        } as never,
      },
      dbPath: "/nowhere/matters.db",
      // More than the database, less than the rewrite needs.
      freeBytes: async () => 15_000,
      databaseBytes: async () => 10_000,
    });
    expect(await port.compactAfterRemoval()).toEqual({
      kind: "lowDisk",
      neededBytes: compactionBudget(10_000),
      freeBytes: 15_000,
    });
    expect(compacted).toBe(false);
  });

  it("is not compacted while a reader keeps the log from being truncated", async () => {
    const asked: unknown[] = [];
    const port = databaseCompaction({
      storage: {
        accountData: { mergeIndexes: async () => {} } as never,
        storageSamples: {
          compact: async (options: unknown) => {
            asked.push(options);
            throw new Error("a reader kept the log from being truncated");
          },
        } as never,
      },
      dbPath: "/nowhere/matters.db",
      freeBytes: async () => 10_000_000_000,
      databaseBytes: async () => 1_000,
    });
    expect((await port.compactAfterRemoval()).kind).toBe("failed");
    expect(asked).toEqual([{ requireCheckpoint: true }]);
  });

  it("compacts when there is room", async () => {
    const port = databaseCompaction({
      storage: {
        accountData: { mergeIndexes: async () => {} } as never,
        storageSamples: { compact: async () => ({ freedBytes: 5_000_000, ms: 10 }) } as never,
      },
      dbPath: "/nowhere/matters.db",
      freeBytes: async () => 10_000_000_000,
      databaseBytes: async () => 1_000,
    });
    expect(await port.compactAfterRemoval()).toEqual({ kind: "compacted", freedBytes: 5_000_000 });
  });
});

describe("the bridges", () => {
  it("pass the erase order's boolean and known page names only", async () => {
    const invoked: unknown[][] = [];
    const page = {};
    const bridge = createStorageBridge(
      {
        invoke: async (...args) => {
          invoked.push(args);
          return { ok: true };
        },
        post: () => {},
      },
      page,
    );
    bridge.message({
      source: page,
      data: {
        mattersStorage: {
          requestId: "1",
          action: "erase",
          earlierCopy: "yes",
          pages: ["microsoftWork", "https://elsewhere.example", "microsoftWork"],
        },
      },
    });
    await Promise.resolve();
    expect(invoked[0]).toEqual(["matters:storage", "erase", false, ["microsoftWork"]]);
  });

  it("let the erase window ask only for its own actions", async () => {
    const posted: unknown[] = [];
    const invoked: unknown[] = [];
    const page = {};
    const bridge = createEraseBridge(
      {
        invoke: async (_c, action) => {
          invoked.push(action);
          return { ok: true };
        },
        post: (m) => posted.push(m),
      },
      page,
    );
    bridge.message({ source: page, data: { mattersErase: { requestId: "1", action: "rm -rf" } } });
    bridge.message({ source: {}, data: { mattersErase: { requestId: "2", action: "quit" } } });
    expect(invoked).toEqual([]);
    expect(posted).toEqual([{ mattersEraseAnswer: { requestId: "1", answer: null } }]);
  });
});

describe("a data folder that could not be read", () => {
  it("says why in plain words, with the code only when nothing plainer is known", () => {
    expect(unreadableReason("EACCES")).toMatch(/does not allow Matters to open it/);
    expect(unreadableReason("EIO")).toMatch(/disk/);
    expect(unreadableReason("ELOOP")).toContain("(ELOOP)");
    expect(unreadableReason(null)).not.toContain("(");
  });
});
