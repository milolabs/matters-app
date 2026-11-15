import type { StorageReport, StorageSampleInfo } from "@matters/contracts";
import { describe, expect, it } from "vitest";
import { accountShare, removalNotice } from "../src/renderer/removal.ts";

const sample: StorageSampleInfo = {
  atMs: 1,
  messages: 4,
  fileBytes: 9999,
  freeBytes: 8888,
  htmlBytes: 100,
  textBytes: 200,
  mailBytes: 300,
  searchBytes: 400,
  filesTextBytes: 7777,
};
const report = (over: Partial<StorageReport> = {}): StorageReport => ({
  messages: 4,
  accounts: [
    { accountId: "a", messages: 1 },
    { accountId: "b", messages: 3 },
  ],
  fileBytes: 9999,
  freeBytes: 8888,
  filesRead: 0,
  repack: { left: 0, listing: false },
  samples: [sample],
  ...over,
});

describe("account removal's measured share", () => {
  it("uses the latest sample and only mail bytes, proportionally to message count", () => {
    const r = report({ samples: [{ ...sample, htmlBytes: 10000 }, sample] });
    expect(accountShare(r, "a")).toEqual({ messages: 1, bytes: 250 });
    expect(accountShare(r, "b")).toEqual({ messages: 3, bytes: 750 });
  });
  it("has no share until the account is in a report", () => {
    expect(accountShare(null, "a")).toBeNull();
    expect(accountShare(report(), "missing")).toBeNull();
  });
  it.each([report({ samples: [] }), report({ messages: 0 })])(
    "does not invent a byte estimate without a usable measurement",
    (r) => {
      expect(accountShare(r, "a")).toEqual({ messages: 1, bytes: null });
    },
  );
  it("distinguishes a measured zero from an unknown size", () => {
    expect(
      accountShare(report({ accounts: [{ accountId: "empty", messages: 0 }] }), "empty"),
    ).toEqual({ messages: 0, bytes: 0 });
  });
});

describe("account removal result", () => {
  it("makes no compaction claim for a backend without that result", () => {
    expect(removalNotice("a@example.org", undefined)).toBe(
      "a@example.org is removed from this computer.",
    );
  });
  it("reports the space actually returned by compaction", () => {
    expect(removalNotice("a@example.org", { kind: "compacted", freedBytes: 2_000_000 })).toBe(
      "a@example.org is removed from this computer, and the database is compacted: 2 MB given back.",
    );
  });
  it("explains retained traces and a recovery path without exposing backend errors", () => {
    const notice = removalNotice("a@example.org", {
      kind: "failed",
      message: "/private/database: internal error",
    });
    expect(notice).toContain("a@example.org is removed.");
    expect(notice).toContain(
      "traces of the removed mail stay in the file until it is compacted in Storage",
    );
    expect(notice).not.toContain("/private");
    expect(notice).not.toContain("internal error");
  });
});
