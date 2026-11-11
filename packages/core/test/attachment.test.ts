import { describe, expect, it } from "vitest";
import {
  type AttachmentState,
  canonicalDraft,
  type DraftAttachment,
  DraftEncodingError,
  describeBlocker,
  describeLargeNotice,
  encodedMessageBytes,
  encodedPartBytes,
  fingerprintOf,
  HEAVY_BYTES,
  LARGE_LANE_BYTES,
  laneFor,
  notifyIfLarge,
  type OfferingCarrier,
  SendBlockedError,
  type StoredAttachment,
  sendBlockers,
} from "../src/index.ts";
import { content, sha256 } from "./support.ts";

const file = (over: Partial<DraftAttachment> = {}): DraftAttachment => ({
  id: "f1",
  name: "report.pdf",
  size: 1000,
  delivery: { kind: "inline" },
  ...over,
});

const row = (over: Partial<StoredAttachment> = {}): StoredAttachment => ({
  id: "f1",
  draftId: "d1",
  accountId: "acc1",
  name: "report.pdf",
  size: 1000,
  state: "ready",
  reason: null,
  sha256: "a".repeat(64),
  sourcePath: "/x/report.pdf",
  sourceMtimeMs: 1,
  origin: null,
  createdAtMs: 1,
  ...over,
});

describe("fingerprint with files (ADR 0040, rules 1 and 2)", () => {
  // The canonical form and hash of `content()` as they were before attachments existed. They
  // must never change, or every draft in someone's database would lose its approvals.
  const BEFORE =
    '{"account":"acc1","from":["me@example.com","Miłosz"],"to":[["anna@northwind.example","Anna Kowalska"]],"cc":[],"bcc":[],"subject":"Re: Wycena","body":"Cena: [cena]. Pozdrawiam","inReplyTo":"<a1@northwind.example>","references":["<a1@northwind.example>"],"thread":"t1"}';

  it("leaves the key out without files, so an existing fingerprint is unchanged", () => {
    expect(canonicalDraft(content())).toBe(BEFORE);
    expect(fingerprintOf(content(), sha256)).toBe(sha256(BEFORE));
    expect(canonicalDraft(content({ attachments: [] }))).toBe(BEFORE);
    expect(canonicalDraft(content({ attachments: undefined }))).toBe(BEFORE);
  });

  it("covers id, name, size and delivery, in order", () => {
    const base = fingerprintOf(content({ attachments: [file()] }), sha256);
    expect(base).not.toBe(fingerprintOf(content(), sha256));
    const changed: DraftAttachment[][] = [
      [file({ id: "f2" })],
      [file({ name: "other.pdf" })],
      [file({ size: 1001 })],
      [file({ delivery: { kind: "link", carrierId: "dropbox" } })],
      [file(), file({ id: "f2", name: "b.png" })],
    ];
    for (const attachments of changed) {
      expect(fingerprintOf(content({ attachments }), sha256)).not.toBe(base);
    }
    const two = [file(), file({ id: "f2", name: "b.png" })];
    expect(fingerprintOf(content({ attachments: two }), sha256)).not.toBe(
      fingerprintOf(
        content({ attachments: [two[1] as DraftAttachment, two[0] as DraftAttachment] }),
        sha256,
      ),
    );
    expect(
      fingerprintOf(
        content({ attachments: [file({ delivery: { kind: "link", carrierId: "a" } })] }),
        sha256,
      ),
    ).not.toBe(
      fingerprintOf(
        content({ attachments: [file({ delivery: { kind: "link", carrierId: "b" } })] }),
        sha256,
      ),
    );
    expect(fingerprintOf(content({ attachments: [file()] }), sha256)).toBe(base);
  });

  it("refuses a file that cannot be encoded", () => {
    expect(() => canonicalDraft(content({ attachments: [file({ size: -1 })] }))).toThrow(
      DraftEncodingError,
    );
    expect(() => canonicalDraft(content({ attachments: [file({ size: 1.5 })] }))).toThrow(
      DraftEncodingError,
    );
    expect(() => canonicalDraft(content({ attachments: [file({ name: "\ud800" })] }))).toThrow(
      DraftEncodingError,
    );
    expect(() =>
      canonicalDraft(content({ attachments: [{ ...file(), delivery: { kind: "x" } as never }] })),
    ).toThrow(DraftEncodingError);
  });
});

describe("encoded sizes", () => {
  it("counts base64 with a CRLF every 76 characters", () => {
    expect(encodedPartBytes(0)).toBe(0);
    expect(encodedPartBytes(1)).toBe(4 + 2);
    expect(encodedPartBytes(3)).toBe(4 + 2);
    expect(encodedPartBytes(4)).toBe(8 + 2);
    // 57 bytes fill exactly one 76 character line
    expect(encodedPartBytes(57)).toBe(76 + 2);
    expect(encodedPartBytes(58)).toBe(80 + 4);
    expect(encodedPartBytes(1_000_000)).toBe(1_333_336 + 2 * 17_544);
  });

  it("adds a fixed 512 bytes of headers per part and nothing for no files", () => {
    expect(encodedMessageBytes([])).toBe(0);
    expect(encodedMessageBytes([{ size: 0 }])).toBe(512);
    expect(encodedMessageBytes([{ size: 57 }, { size: 3 }])).toBe(78 + 512 + 6 + 512);
  });

  it("picks the lane at 1 MiB", () => {
    expect(laneFor(0)).toBe("small");
    expect(laneFor(LARGE_LANE_BYTES - 1)).toBe("small");
    expect(laneFor(LARGE_LANE_BYTES)).toBe("large");
  });
});

/** A file whose encoded message weighs about `encoded` bytes. */
function weighing(encoded: number, over: Partial<StoredAttachment> = {}): StoredAttachment {
  // invert encodedPartBytes closely, then nudge until it fits exactly or just under
  let size = Math.floor(((encoded - 512) / 78) * 57);
  while (encodedMessageBytes([{ size }]) > encoded) size--;
  return row({ size, ...over });
}

describe("notifyIfLarge (ADR 0040, rule 3)", () => {
  const none: OfferingCarrier[] = [];

  it("says nothing without files, whatever the limit", () => {
    expect(notifyIfLarge([], null, none)).toBeNull();
    expect(notifyIfLarge([], 0, none)).toBeNull();
  });

  it("says nothing for a small message, with or without a limit", () => {
    const small = [row({ size: 100_000 })];
    expect(notifyIfLarge(small, null, none)).toBeNull();
    expect(notifyIfLarge(small, 25_000_000, none)).toBeNull();
  });

  it("is heavy from 10 MB encoded, when the limit is unknown", () => {
    const f = weighing(HEAVY_BYTES);
    expect(encodedMessageBytes([f])).toBeLessThanOrEqual(HEAVY_BYTES);
    const just = [row({ size: f.size + 60 })];
    expect(encodedMessageBytes(just)).toBeGreaterThanOrEqual(HEAVY_BYTES);
    expect(notifyIfLarge([f], null, none)?.kind).not.toBe("heavy");
    expect(notifyIfLarge(just, null, none)).toEqual({
      kind: "heavy",
      encodedBytes: encodedMessageBytes(just),
      limitBytes: null,
      offers: [],
    });
  });

  it("is heavy when within a known limit", () => {
    const files = [row({ size: 10_000_000 })];
    const notice = notifyIfLarge(files, 26_214_400, none);
    expect(notice).toMatchObject({ kind: "heavy", limitBytes: 26_214_400 });
  });

  it("is tooLarge over a known limit, and counts the encoding, not the file sizes", () => {
    // 19 MB of files is under a 25 MB limit by size and over it once encoded
    const files = [row({ size: 19_000_000 })];
    const encoded = encodedMessageBytes(files);
    expect(encoded).toBeGreaterThan(25_000_000);
    expect(notifyIfLarge(files, 25_000_000, none)).toMatchObject({
      kind: "tooLarge",
      encodedBytes: encoded,
      limitBytes: 25_000_000,
    });
    // the limit is a ceiling: exactly at it still goes
    expect(notifyIfLarge(files, encoded, none)?.kind).toBe("heavy");
    expect(notifyIfLarge(files, encoded - 1, none)?.kind).toBe("tooLarge");
  });

  it("a small limit makes even a small message tooLarge", () => {
    expect(notifyIfLarge([row({ size: 5000 })], 1000, none)?.kind).toBe("tooLarge");
  });

  it("carries the offers of every carrier for every file, for both kinds", () => {
    const carrier: OfferingCarrier = {
      id: "dropbox",
      label: "Dropbox",
      offerFor: (file, accountId) =>
        accountId === "acc1" && file.size > 1
          ? { carrierId: "dropbox", label: "Dropbox", fileId: file.id }
          : null,
    };
    const files = [
      row({ id: "a", size: 6_000_000 }),
      row({ id: "b", size: 6_000_000 }),
      row({ id: "c", size: 1 }),
    ];
    const heavy = notifyIfLarge(files, null, [carrier]);
    expect(heavy?.kind).toBe("heavy");
    expect(heavy?.offers.map((o) => o.fileId)).toEqual(["a", "b"]);
    const tooLarge = notifyIfLarge(files, 1000, [carrier]);
    expect(tooLarge?.kind).toBe("tooLarge");
    expect(tooLarge?.offers).toHaveLength(2);
    expect(notifyIfLarge([row({ size: 5 })], null, [carrier])).toBeNull();
  });

  it("says it in the words of the boards", () => {
    expect(
      describeLargeNotice({
        kind: "tooLarge",
        encodedBytes: 45_100_000,
        limitBytes: 25_000_000,
        offers: [],
      }),
    ).toBe("45.1 MB to send, your server takes 25 MB. Remove a file.");
    expect(
      describeLargeNotice({
        kind: "heavy",
        encodedBytes: 18_600_000,
        limitBytes: null,
        offers: [],
      }),
    ).toBe("18.6 MB to send. Some servers refuse mail this large.");
  });
});

describe("send blockers with files", () => {
  const withFile = (state: AttachmentState = "ready", over: Partial<StoredAttachment> = {}) => ({
    content: content({ bodyMarkdown: "Hello", attachments: [file()] }),
    rows: [row({ state, ...over })],
  });

  it("behaves as before without a context", () => {
    expect(sendBlockers(content({ bodyMarkdown: "Hello", attachments: [file()] }))).toEqual([]);
    expect(sendBlockers(content({ to: [], bodyMarkdown: "Hello" }))).toEqual([
      { kind: "noRecipients" },
    ]);
  });

  it("lets a file that is ready, or still being read, go", () => {
    for (const state of ["ready", "reading"] as const) {
      const { content: c, rows } = withFile(state);
      expect(sendBlockers(c, { attachments: rows, limitBytes: 25_000_000 })).toEqual([]);
    }
  });

  it("blocks on a failed file, with its reason", () => {
    const { content: c, rows } = withFile("failed", { reason: "Can't read this file" });
    const blockers = sendBlockers(c, { attachments: rows });
    expect(blockers).toEqual([
      { kind: "attachmentProblem", name: "report.pdf", reason: "Can't read this file" },
    ]);
    expect(describeBlocker(blockers[0] as never)).toBe("report.pdf: Can't read this file");
    expect(() => {
      throw new SendBlockedError(blockers);
    }).toThrow("report.pdf: Can't read this file");
  });

  it("blocks on a file with no row", () => {
    const blockers = sendBlockers(content({ bodyMarkdown: "Hello", attachments: [file()] }), {
      attachments: [],
    });
    expect(blockers).toEqual([
      { kind: "attachmentProblem", name: "report.pdf", reason: "It is not attached yet" },
    ]);
  });

  it("blocks on the files together being over the limit, once", () => {
    const rows = [
      row({ id: "a", size: 15_000_000 }),
      row({ id: "b", size: 15_000_000, name: "b.bin" }),
    ];
    const c = content({
      bodyMarkdown: "Hello",
      attachments: [file({ id: "a" }), file({ id: "b", name: "b.bin" })],
    });
    const blockers = sendBlockers(c, { attachments: rows, limitBytes: 25_000_000 });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ kind: "tooLarge", notice: { kind: "tooLarge" } });
    expect(describeBlocker(blockers[0] as never)).toMatch(/MB to send, your server takes 25 MB/);
    // the same files without a known limit are only heavy, which blocks nothing
    expect(sendBlockers(c, { attachments: rows })).toEqual([]);
  });

  it("a file marked tooLarge blocks even when its row says so alone", () => {
    const { content: c, rows } = withFile("tooLarge", { reason: "Larger than your server takes" });
    expect(sendBlockers(c, { attachments: rows })).toEqual([
      { kind: "attachmentProblem", name: "report.pdf", reason: "Larger than your server takes" },
    ]);
  });

  it("reports the text problems and the file problems together", () => {
    const { content: c, rows } = withFile("failed", { reason: "Not enough disk space" });
    const kinds = sendBlockers({ ...c, to: [] }, { attachments: rows }).map((b) => b.kind);
    expect(kinds).toEqual(["noRecipients", "attachmentProblem"]);
  });

  it("only looks at the files the draft lists", () => {
    const stray = row({ id: "old", state: "failed", reason: "x" });
    expect(
      sendBlockers(content({ bodyMarkdown: "Hello", attachments: [file()] }), {
        attachments: [row(), stray],
      }),
    ).toEqual([]);
  });
});
