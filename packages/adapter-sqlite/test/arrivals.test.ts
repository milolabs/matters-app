import { makeLocation, makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStorage, type SqliteStorage } from "../src/index.ts";

const open: SqliteStorage[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe("arrivals, by the order the server gave them (ADR 0106, rule 1)", () => {
  it("reads marks from the cursors and finds unread mail above them", async () => {
    const s = createSqliteStorage(":memory:");
    open.push(s);
    // An old Date header at a high UID, and a new one at a low UID: the UID decides.
    const late = makeMessage({ dateMs: Date.UTC(2001, 0, 1) });
    const backfilled = makeMessage({ dateMs: Date.UTC(2024, 5, 1) });
    const read = makeMessage({
      flags: { seen: true, flagged: false, answered: false, draft: false },
    });
    await s.store.upsertMessages([late, backfilled, read]);
    await s.store.addLocations([
      { key: backfilled.key, location: makeLocation(3) },
      { key: late.key, location: makeLocation(11) },
      { key: read.key, location: makeLocation(12) },
      { key: late.key, location: makeLocation(40, "Archive") },
    ]);
    await s.cursors.set("acc1", "INBOX", {
      uidValidity: "1",
      lastUid: "12",
      lowUid: "1",
      complete: "1",
      highestModseq: null,
    });
    await s.cursors.set("acc1", "Archive", { uidValidity: "1", lastUid: 40 });
    // A cursor that names no UIDVALIDITY gives no mark.
    await s.cursors.set("acc1", "Odd", { lastUid: "5" });

    const marks = await s.read.arrivals.marks();
    expect([...marks].sort((a, b) => a.folderId.localeCompare(b.folderId))).toEqual([
      { accountId: "acc1", folderId: "Archive", uidValidity: "1", uid: 40 },
      { accountId: "acc1", folderId: "INBOX", uidValidity: "1", uid: 12 },
    ]);
    const span = (folderId: string, afterUid: number, upToUid: number) => ({
      accountId: "acc1",
      folderId,
      uidValidity: "1",
      afterUid,
      upToUid,
    });
    expect(await s.read.arrivals.unreadIn([span("INBOX", 10, 12)], 10)).toEqual([late.key]);
    expect(
      await s.read.arrivals.unreadIn([span("INBOX", 0, 12), span("Archive", 0, 40)], 10),
    ).toEqual([backfilled.key, late.key].sort((a, b) => b - a));
    expect(await s.read.arrivals.unreadIn([span("INBOX", 0, 12)], 1)).toHaveLength(1);
    expect(await s.read.arrivals.unreadIn([span("INBOX", 12, 20)], 10)).toEqual([]);
  });
});
