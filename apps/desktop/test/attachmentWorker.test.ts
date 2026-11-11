// The attachment worker is a real thread here (same runtime as the app, the real adapters),
// supervised by the same ThreadedFileWork the sync worker uses (ADR 0041, rule 4).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { FileDirs } from "@matters/adapter-files";
import { FileWorkError, isFileWorkError } from "@matters/core";
import { makePdf } from "@matters/testkit";
import PostalMime from "postal-mime";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadedFileWork } from "../src/backend/threadedFileWork.ts";

const workerUrl = new URL("../src/backend/attachmentWorker.ts", import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function rig(options: { idleMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "matters-attworker-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dirs: FileDirs = { attachments: join(root, "attachments"), spool: join(root, "spool") };
  const workers: Worker[] = [];
  const work = new ThreadedFileWork({
    dirs,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    spawn() {
      const worker = new Worker(workerUrl, { workerData: dirs });
      workers.push(worker);
      return worker;
    },
  });
  cleanups.push(() => work.dispose());
  return { root, dirs, workers, work };
}

const input = {
  from: { name: "Me", address: "me@example.test" },
  to: [{ name: "Anna", address: "anna@northwind.example" }],
  cc: [],
  subject: "Zdjęcia",
  inReplyTo: "",
  references: [],
  html: "<p>W załączniku.</p>",
  text: "W załączniku.",
  dateMs: Date.UTC(2026, 10, 4, 12),
};

describe("the attachment worker thread", () => {
  it("reads the text of a PDF on its own thread, and a text file, and fails soft on garbage (ADR 0087)", async () => {
    const { root, workers, work } = rig();
    const pdf = join(root, "contract.pdf");
    await writeFile(pdf, makePdf([["Notice period is three months"]]));
    const out = await work.extractText({ sourcePath: pdf, kind: "pdf" });
    expect(out).toMatchObject({ state: "ok", pages: 1 });
    expect(out.text).toContain("Notice period is three months");
    expect(workers).toHaveLength(1);
    const txt = join(root, "a.txt");
    await writeFile(txt, "plain words");
    expect((await work.extractText({ sourcePath: txt, kind: "text" })).text).toBe("plain words");
    const bad = join(root, "bad.pdf");
    await writeFile(bad, "not a pdf");
    expect((await work.extractText({ sourcePath: bad, kind: "pdf" })).state).toBe("failed");
    expect(workers).toHaveLength(1);
  });

  it("captures a file on its own thread, hashes it and reports progress", async () => {
    const { root, dirs, workers, work } = rig();
    const bytes = new Uint8Array(1_500_000).map((_, i) => (i * 7) % 251);
    const source = join(root, "report.pdf");
    await writeFile(source, bytes);

    const fractions: number[] = [];
    const done = await work.capture({ attachmentId: "att-1", sourcePath: source }, (f) =>
      fractions.push(f),
    );

    expect(done.sha256).toBe(sha256(bytes));
    expect(done.size).toBe(bytes.byteLength);
    expect(done.sourceMtimeMs).toBe(statSync(source).mtimeMs);
    expect(readFileSync(join(dirs.attachments, "att-1")).equals(bytes)).toBe(true);
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect(workers).toHaveLength(1);
    // The original is untouched, and a missing one is the typed error the chip words.
    expect(readFileSync(source).equals(bytes)).toBe(true);
    const gone = await work
      .capture({ attachmentId: "att-2", sourcePath: join(root, "nope") }, () => {})
      .catch((e: unknown) => e);
    expect(isFileWorkError(gone) && gone.kind).toBe("unreadable");
    expect(workers).toHaveLength(1);
  });

  it("builds a spool with the file in it, and refuses a copy that does not match its hash", async () => {
    const { root, dirs, work } = rig();
    const bytes = new Uint8Array(300_000).map((_, i) => (i * 13) % 253);
    const source = join(root, "photo.jpg");
    await writeFile(source, bytes);
    const copy = await work.capture({ attachmentId: "att-1", sourcePath: source }, () => {});

    const built = await work.buildMessage(
      input,
      [{ attachmentId: "att-1", name: "photo.jpg", sha256: copy.sha256 }],
      "op-1",
    );
    expect(built.spoolPath).toBe(join(dirs.spool, "op-1.eml"));
    expect(existsSync(`${built.spoolPath}.part`)).toBe(false);
    expect(statSync(built.spoolPath).size).toBe(built.bytes);
    // Opening it needs no thread: it is a file and a size.
    expect(work.openSpool(built.spoolPath).size).toBe(built.bytes);
    expect((await work.readSpool(built.spoolPath)).byteLength).toBe(built.bytes);

    const parsed = await PostalMime.parse(readFileSync(built.spoolPath));
    expect(parsed.messageId).toBe(built.messageId);
    expect(parsed.subject).toBe("Zdjęcia");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("photo.jpg");
    expect(Buffer.from(parsed.attachments[0]?.content as ArrayBuffer).equals(bytes)).toBe(true);

    const wrong = await work
      .buildMessage(
        input,
        [{ attachmentId: "att-1", name: "photo.jpg", sha256: "0".repeat(64) }],
        "op-2",
      )
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(FileWorkError);
    expect(wrong).toMatchObject({ kind: "missing", file: "photo.jpg" });
    expect(existsSync(join(dirs.spool, "op-2.eml"))).toBe(false);
  });

  it("exits after it has been idle, and starts again with the next job", async () => {
    const { root, workers, work } = rig({ idleMs: 150 });
    const source = join(root, "a.txt");
    await writeFile(source, "hello");
    await work.capture({ attachmentId: "att-1", sourcePath: source }, () => {});
    expect(work.running).toBe(true);
    expect(workers[0]?.threadId).toBeGreaterThan(0);

    await until(() => !work.running, "the idle exit");
    await until(() => workers[0]?.threadId === -1, "the thread to end");
    expect(work.spawned).toBe(1);

    // Its exit was not a crash: the next job just starts a new thread.
    const again = await work.capture({ attachmentId: "att-2", sourcePath: source }, () => {});
    expect(again.size).toBe(5);
    expect(work.spawned).toBe(2);
    expect(workers[1]?.threadId).toBeGreaterThan(0);
  });

  it("does not retire while a job is running", async () => {
    const { root, workers, work } = rig({ idleMs: 50 });
    const source = join(root, "big.bin");
    await writeFile(source, "x");
    truncateSync(source, 96 * 1024 * 1024);
    const done = await work.capture({ attachmentId: "att-1", sourcePath: source }, () => {});
    expect(done.size).toBe(96 * 1024 * 1024);
    expect(work.spawned).toBe(1);
    expect(workers).toHaveLength(1);
  });

  it("after a crash only the jobs in flight fail; the ones waiting go to the new thread", async () => {
    const { root, dirs, workers, work } = rig();
    const small = join(root, "small.txt");
    await writeFile(small, "still here");
    const big = join(root, "big.bin");
    await writeFile(big, "x");
    // A sparse file: a few lines of setup, and long enough to hash that the kill lands inside.
    truncateSync(big, 96 * 1024 * 1024);
    await work.capture({ attachmentId: "warm", sourcePath: small }, () => {});
    expect(work.spawned).toBe(1);

    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      void workers[0]?.terminate();
    };
    // Two jobs at once is the limit: the third waits for a free place.
    const a = work.capture({ attachmentId: "a", sourcePath: big }, kill).catch((e: unknown) => e);
    const b = work.capture({ attachmentId: "b", sourcePath: big }, kill).catch((e: unknown) => e);
    const c = work.capture({ attachmentId: "c", sourcePath: small }, () => {});

    const [lostA, lostB, saved] = await Promise.all([a, b, c]);
    expect(killed).toBe(true);
    for (const lost of [lostA, lostB]) {
      expect(lost).toBeInstanceOf(FileWorkError);
      expect(lost).toMatchObject({ kind: "unreadable" });
    }
    expect(saved).toMatchObject({
      size: 10,
      sha256: sha256(new TextEncoder().encode("still here")),
    });
    expect(work.spawned).toBe(2);
    expect(readFileSync(join(dirs.attachments, "c"), "utf8")).toBe("still here");

    // And the pool is healthy afterwards.
    const after = await work.capture({ attachmentId: "d", sourcePath: small }, () => {});
    expect(after.size).toBe(10);
    expect(work.spawned).toBe(2);
    // What the dead thread left half done is for the start-up sweep.
    await work.sweep(["warm", "c", "d"], []);
    expect(existsSync(join(dirs.attachments, "a.part"))).toBe(false);
    expect(existsSync(join(dirs.attachments, "b.part"))).toBe(false);
  }, 30_000);

  it("stops a copy in flight on request and leaves no partial file", async () => {
    const { root, dirs, work } = rig();
    const big = join(root, "big.bin");
    await writeFile(big, "x");
    truncateSync(big, 96 * 1024 * 1024);
    const controller = new AbortController();
    const result = await work
      .capture({ attachmentId: "a", sourcePath: big }, () => controller.abort(), controller.signal)
      .catch((e: unknown) => e);
    expect(result).toBeInstanceOf(FileWorkError);
    expect(existsSync(join(dirs.attachments, "a"))).toBe(false);
    expect(existsSync(join(dirs.attachments, "a.part"))).toBe(false);
  }, 30_000);

  it("fails every job and starts nothing once disposed", async () => {
    const { root, work } = rig();
    const source = join(root, "a.txt");
    await writeFile(source, "hello");
    await work.capture({ attachmentId: "att-1", sourcePath: source }, () => {});
    await work.dispose();
    expect(work.running).toBe(false);
    const late = await work
      .capture({ attachmentId: "att-2", sourcePath: source }, () => {})
      .catch((e: unknown) => e);
    expect(late).toBeInstanceOf(FileWorkError);
    expect(work.spawned).toBe(1);
  });
});
