import { describe, expect, it, vi } from "vitest";
import { type CompactionDeps, databaseCompaction } from "../src/backend/compaction.ts";

function rig(overrides: Partial<CompactionDeps> = {}) {
  const mergeIndexes = vi.fn(async () => {});
  const compact = vi.fn(async () => ({ freedBytes: 321, ms: 10 }));
  const freeBytes = vi.fn(async (): Promise<number | null> => 200);
  const databaseBytes = vi.fn(async () => 100);
  // Only the two calls the compaction makes are stood in for.
  const port = databaseCompaction({
    storage: {
      accountData: { mergeIndexes },
      storageSamples: { compact },
    } as unknown as CompactionDeps["storage"],
    dbPath: "/test/matters.db",
    freeBytes,
    databaseBytes,
    ...overrides,
  });
  return { port, mergeIndexes, compact, freeBytes, databaseBytes };
}

describe("compaction after account removal (ADR 0138, rule 6)", () => {
  it("does no disk work for an in-memory database", async () => {
    const r = rig({ dbPath: ":memory:" });
    await expect(r.port.compactAfterRemoval()).resolves.toEqual({
      kind: "compacted",
      freedBytes: 0,
    });
    for (const fn of [r.databaseBytes, r.freeBytes, r.mergeIndexes, r.compact])
      expect(fn).not.toHaveBeenCalled();
  });

  it("accepts exactly the rewrite budget and merges indexes before compacting", async () => {
    const r = rig();
    r.compact.mockImplementation(async () => {
      expect(r.mergeIndexes).toHaveBeenCalledOnce();
      return { freedBytes: 321, ms: 10 };
    });
    await expect(r.port.compactAfterRemoval()).resolves.toEqual({
      kind: "compacted",
      freedBytes: 321,
    });
    expect(r.databaseBytes).toHaveBeenCalledWith("/test/matters.db");
    expect(r.freeBytes).toHaveBeenCalledWith("/test/matters.db");
    expect(r.compact).toHaveBeenCalledExactlyOnceWith({ requireCheckpoint: true });
  });

  it("leaves both indexes and database untouched one byte below the budget", async () => {
    const r = rig();
    r.freeBytes.mockResolvedValue(199);
    await expect(r.port.compactAfterRemoval()).resolves.toEqual({
      kind: "lowDisk",
      neededBytes: 200,
      freeBytes: 199,
    });
    expect(r.mergeIndexes).not.toHaveBeenCalled();
    expect(r.compact).not.toHaveBeenCalled();
  });

  it("attempts compaction when available disk space is unknown", async () => {
    const r = rig();
    r.freeBytes.mockResolvedValue(null);
    await expect(r.port.compactAfterRemoval()).resolves.toEqual({
      kind: "compacted",
      freedBytes: 321,
    });
    expect(r.compact).toHaveBeenCalledOnce();
  });

  it.each(["merge", "compact"])(
    "reports a disk that fills during %s using a fresh measurement",
    async (stage) => {
      const r = rig();
      r.freeBytes.mockResolvedValueOnce(200).mockResolvedValueOnce(3);
      (stage === "merge" ? r.mergeIndexes : r.compact).mockRejectedValueOnce(
        new Error("SQLITE_FULL: database or disk is full"),
      );
      await expect(r.port.compactAfterRemoval()).resolves.toEqual({
        kind: "lowDisk",
        neededBytes: 200,
        freeBytes: 3,
      });
      expect(r.freeBytes).toHaveBeenCalledTimes(2);
      if (stage === "merge") expect(r.compact).not.toHaveBeenCalled();
    },
  );

  it("reports zero known free bytes when the disk cannot be measured after SQLITE_FULL", async () => {
    const r = rig();
    r.freeBytes.mockResolvedValueOnce(200).mockResolvedValueOnce(null);
    r.compact.mockRejectedValueOnce(new Error("SQLITE_FULL"));
    await expect(r.port.compactAfterRemoval()).resolves.toEqual({
      kind: "lowDisk",
      neededBytes: 200,
      freeBytes: 0,
    });
  });

  it.each([new Error("index is locked"), "index is locked"])(
    "reports merge failures without attempting the rewrite: %s",
    async (error) => {
      const r = rig();
      r.mergeIndexes.mockRejectedValueOnce(error);
      await expect(r.port.compactAfterRemoval()).resolves.toEqual({
        kind: "failed",
        message: "index is locked",
      });
      expect(r.compact).not.toHaveBeenCalled();
      expect(r.freeBytes).toHaveBeenCalledOnce();
    },
  );
});
