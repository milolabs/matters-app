import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepReceived } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReceivedFiles } from "../src/index.ts";

let root: string;
let cache: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "matters-received-"));
  cache = join(root, "received");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const noop = () => {};
const chunks = (...parts: Uint8Array[]) =>
  (async function* () {
    for (const p of parts) yield p;
  })();
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe("writing a received file (ADR 0043, rule 6)", () => {
  it("lands at received/<key>/<part>/<name> with only the owner able to read it", async () => {
    const files = createReceivedFiles(cache);
    const written = await files.write(
      42,
      "2.1",
      "Faktura.pdf",
      chunks(bytes(3, 1), bytes(2, 2)),
      noop,
    );
    const path = join(cache, "42", "2.1", "Faktura.pdf");
    expect(written).toBe(5);
    expect([...readFileSync(path)]).toEqual([1, 1, 1, 2, 2]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(cache, "42", "2.1")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(cache, "42", "2.1"))).toEqual(["Faktura.pdf"]);
  });

  it("reports the running total after every chunk", async () => {
    const files = createReceivedFiles(cache);
    const seen: number[] = [];
    await files.write(1, "2", "a.bin", chunks(bytes(10), bytes(20), bytes(5)), (n) => seen.push(n));
    expect(seen).toEqual([10, 30, 35]);
  });

  it("is not a file until it is whole: a temporary name holds the bytes meanwhile", async () => {
    const files = createReceivedFiles(cache);
    const dir = join(cache, "1", "2");
    let during: string[] = [];
    const slow = (async function* () {
      yield bytes(4);
      during = readdirSync(dir);
      yield bytes(4);
    })();
    await files.write(1, "2", "big.zip", slow, noop);
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(/^\.part-/);
    expect(readdirSync(dir)).toEqual(["big.zip"]);
  });

  it("cleans the temporary name up when the download fails", async () => {
    const files = createReceivedFiles(cache);
    const broken = (async function* () {
      yield bytes(4);
      throw new Error("connection reset");
    })();
    await expect(files.write(1, "2", "a.pdf", broken, noop)).rejects.toThrow("connection reset");
    expect(readdirSync(join(cache, "1", "2"))).toEqual([]);
    expect(await files.touch(1, "2")).toBe(false);
  });

  it("cleans up when it is aborted, and stops reading", async () => {
    const files = createReceivedFiles(cache);
    const controller = new AbortController();
    let pulled = 0;
    const endless = (async function* () {
      for (;;) {
        pulled++;
        yield bytes(8);
        if (pulled === 2) controller.abort();
      }
    })();
    await expect(files.write(1, "2", "a.pdf", endless, noop, controller.signal)).rejects.toThrow();
    expect(pulled).toBeLessThan(5);
    expect(readdirSync(join(cache, "1", "2"))).toEqual([]);
  });

  it("does not replace an earlier whole copy when a later download fails", async () => {
    const files = createReceivedFiles(cache);
    await files.write(1, "2", "a.pdf", chunks(bytes(3, 9)), noop);
    const broken = (async function* () {
      yield bytes(1);
      throw new Error("lost");
    })();
    await expect(files.write(1, "2", "a.pdf", broken, noop)).rejects.toThrow("lost");
    expect([...readFileSync(join(cache, "1", "2", "a.pdf"))]).toEqual([9, 9, 9]);
  });

  it("replaces a copy and drops one under another name", async () => {
    const files = createReceivedFiles(cache);
    await files.write(1, "2", "old name.pdf", chunks(bytes(3, 1)), noop);
    await files.write(1, "2", "new name.pdf", chunks(bytes(2, 5)), noop);
    expect(readdirSync(join(cache, "1", "2"))).toEqual(["new name.pdf"]);
  });

  it("holds no more than a chunk at a time: it pulls the next only after writing the last", async () => {
    const files = createReceivedFiles(cache);
    const order: string[] = [];
    const source = (async function* () {
      for (let i = 0; i < 4; i++) {
        order.push(`pull${i}`);
        yield bytes(1024 * 1024);
      }
    })();
    await files.write(1, "2", "big.bin", source, (n) => order.push(`wrote${n / (1024 * 1024)}`));
    expect(order).toEqual([
      "pull0",
      "wrote1",
      "pull1",
      "wrote2",
      "pull2",
      "wrote3",
      "pull3",
      "wrote4",
    ]);
  });

  it("writes several megabytes byte for byte", async () => {
    const files = createReceivedFiles(cache);
    const big = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const parts: Uint8Array[] = [];
    for (let at = 0; at < big.length; at += 100_000) parts.push(big.subarray(at, at + 100_000));
    await files.write(9, "3", "blob.bin", chunks(...parts), noop);
    expect(readFileSync(join(cache, "9", "3", "blob.bin")).equals(big)).toBe(true);
  });

  it("cleans the name again, whatever it was given", async () => {
    const files = createReceivedFiles(cache);
    await files.write(1, "2", "../../escape.txt", chunks(bytes(1)), noop);
    expect(readdirSync(join(cache, "1", "2"))).toEqual(["escape.txt"]);
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });

  it("refuses a key or part that is not one", async () => {
    const files = createReceivedFiles(cache);
    await expect(files.write(0, "2", "a", chunks(), noop)).rejects.toThrow();
    await expect(files.write(1, "../2", "a", chunks(), noop)).rejects.toThrow();
    await expect(files.write(1, "", "a", chunks(), noop)).rejects.toThrow();
    expect(existsSync(cache)).toBe(false);
  });
});

describe("touch", () => {
  it("is false without a finished copy, true with one, and moves its use time", async () => {
    const files = createReceivedFiles(cache);
    expect(await files.touch(1, "2")).toBe(false);
    await files.write(1, "2", "a.pdf", chunks(bytes(1)), noop);
    const path = join(cache, "1", "2", "a.pdf");
    utimesSync(path, new Date(1000), new Date(1000));
    expect(await files.touch(1, "2")).toBe(true);
    expect(statSync(path).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("does not take a partial file for a copy", async () => {
    const files = createReceivedFiles(cache);
    mkdirSync(join(cache, "1", "2"), { recursive: true });
    writeFileSync(join(cache, "1", "2", ".part-abc"), "half");
    expect(await files.touch(1, "2")).toBe(false);
  });
});

describe("locate (ADR 0045, rule 7)", () => {
  it("is the path of the finished copy, which a capture can read", async () => {
    const files = createReceivedFiles(cache);
    expect(await files.locate(1, "2")).toBeNull();
    await files.write(1, "2", "Faktura FV 1.pdf", chunks(bytes(3, 9)), noop);
    const path = await files.locate(1, "2");
    expect(path).toBe(join(cache, "1", "2", "Faktura FV 1.pdf"));
    expect(readFileSync(path as string)).toEqual(Buffer.from(bytes(3, 9)));
  });

  it("does not take a partial file for a copy, and is null again once the copy is swept", async () => {
    const files = createReceivedFiles(cache);
    mkdirSync(join(cache, "1", "2"), { recursive: true });
    writeFileSync(join(cache, "1", "2", ".part-abc"), "half");
    expect(await files.locate(1, "2")).toBeNull();
    await files.write(1, "3", "a.pdf", chunks(bytes(1)), noop);
    await files.removeMessages([1]);
    expect(await files.locate(1, "3")).toBeNull();
  });

  it("refuses a key or part that is not one, so no path is made of them", async () => {
    const files = createReceivedFiles(cache);
    await expect(files.locate(1, "../../etc")).rejects.toThrow();
    await expect(files.locate(-1, "2")).rejects.toThrow();
  });
});

describe("removing with the message", () => {
  it("deletes every part of the messages named and nothing else", async () => {
    const files = createReceivedFiles(cache);
    await files.write(1, "2", "a.pdf", chunks(bytes(1)), noop);
    await files.write(1, "3", "b.pdf", chunks(bytes(1)), noop);
    await files.write(2, "2", "c.pdf", chunks(bytes(1)), noop);
    await files.removeMessages([1, 99]);
    expect(readdirSync(cache)).toEqual(["2"]);
  });

  it("ignores a key that is not one", async () => {
    const files = createReceivedFiles(cache);
    await files.write(1, "2", "a.pdf", chunks(bytes(1)), noop);
    await files.removeMessages([0, -5, Number.NaN, 1.5]);
    expect(readdirSync(cache)).toEqual(["1"]);
  });

  it("works when nothing was ever downloaded", async () => {
    await expect(createReceivedFiles(cache).removeMessages([1, 2])).resolves.toBeUndefined();
  });
});

describe("listing and sweeping (ADR 0043, rule 8)", () => {
  it("lists every copy with its size and last use, and marks partial files", async () => {
    const files = createReceivedFiles(cache);
    await files.write(7, "2", "a.pdf", chunks(bytes(5)), noop);
    writeFileSync(join(cache, "7", "2", ".part-xyz"), "123");
    mkdirSync(join(cache, "not-a-key"));
    mkdirSync(join(cache, "8", "not.a.part!"), { recursive: true });
    const listed = await files.list();
    expect(listed.map((f) => [f.messageKey, f.partId, f.name, f.bytes, f.partial]).sort()).toEqual([
      [7, "2", ".part-xyz", 3, true],
      [7, "2", "a.pdf", 5, false],
    ]);
    expect(Date.now() - (listed[0]?.usedMs ?? 0)).toBeLessThan(60_000);
  });

  it("lists nothing for a cache that does not exist", async () => {
    expect(await createReceivedFiles(cache).list()).toEqual([]);
  });

  it("removes the files named and tidies the empty directories", async () => {
    const files = createReceivedFiles(cache);
    await files.write(7, "2", "a.pdf", chunks(bytes(5)), noop);
    await files.write(7, "3", "b.pdf", chunks(bytes(5)), noop);
    const listed = await files.list();
    await files.remove(listed.filter((f) => f.partId === "2"));
    expect(existsSync(join(cache, "7", "2"))).toBe(false);
    expect(existsSync(join(cache, "7", "3", "b.pdf"))).toBe(true);
    await files.remove(await files.list());
    expect(existsSync(join(cache, "7"))).toBe(false);
  });

  it("will not remove a name that climbs out of its directory", async () => {
    const files = createReceivedFiles(cache);
    await files.write(7, "2", "a.pdf", chunks(bytes(5)), noop);
    writeFileSync(join(root, "precious"), "keep");
    await files.remove([
      {
        messageKey: 7,
        partId: "2",
        name: "../../../precious",
        bytes: 0,
        usedMs: 0,
        partial: false,
      },
    ]);
    expect(existsSync(join(root, "precious"))).toBe(true);
  });

  it("sweeps by age, by size and the leftovers of a download, on a real directory", async () => {
    const files = createReceivedFiles(cache);
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await files.write(1, "2", "stale.pdf", chunks(bytes(100)), noop);
    await files.write(2, "2", "older.pdf", chunks(bytes(600)), noop);
    await files.write(3, "2", "newer.pdf", chunks(bytes(600)), noop);
    await files.write(4, "2", "fresh.pdf", chunks(bytes(10)), noop);
    mkdirSync(join(cache, "5", "2"), { recursive: true });
    writeFileSync(join(cache, "5", "2", ".part-left"), "x");
    const age = (key: number, name: string, days: number) => {
      const when = new Date(now - days * DAY);
      utimesSync(join(cache, String(key), "2", name), when, when);
    };
    age(1, "stale.pdf", 9);
    age(2, "older.pdf", 3);
    age(3, "newer.pdf", 2);

    const removed = await sweepReceived({
      files,
      nowMs: now,
      inUse: new Set(),
      maxBytes: 700,
    });

    // The stale one by age, the leftover by being partial, the oldest of the rest by size.
    expect(removed).toBe(3);
    expect((await files.list()).map((f) => f.name).sort()).toEqual(["fresh.pdf", "newer.pdf"]);
  });

  it("leaves a part that a download is writing, however old", async () => {
    const files = createReceivedFiles(cache);
    mkdirSync(join(cache, "1", "2"), { recursive: true });
    const partial = join(cache, "1", "2", ".part-live");
    writeFileSync(partial, "x");
    utimesSync(partial, new Date(1000), new Date(1000));
    await sweepReceived({ files, nowMs: Date.now(), inUse: new Set(["1/2"]) });
    expect(existsSync(partial)).toBe(true);
  });
});
