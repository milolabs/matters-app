import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { PostalMimeParser } from "@matters/adapter-mime";
import { NodemailerComposer } from "@matters/adapter-smtp";
import type { ComposeInput } from "@matters/core";
import { encodedMessageBytes } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentPath,
  buildSpool,
  captureFile,
  createFileWork,
  type FileDirs,
  openSpool,
  readSpool,
  removeAttachments,
  removeSpool,
  statSource,
  sweep,
} from "../src/index.ts";

let root: string;
let dirs: FileDirs;
let origin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "matters-files-"));
  dirs = { attachments: join(root, "attachments"), spool: join(root, "spool") };
  origin = join(root, "originals");
  mkdirSync(origin);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");
const original = (name: string, content: string | Uint8Array) => {
  const path = join(origin, name);
  writeFileSync(path, content);
  return path;
};
const mode = (path: string) => statSync(path).mode & 0o777;
const kinds = (error: unknown) => (error as { kind?: string }).kind;

const bytes = (n: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
};

for (const clone of [true, false]) {
  describe(`captureFile (${clone ? "clone, then hash" : "streamed copy"})`, () => {
    const capture = (id: string, path: string, progress: number[] = [], signal?: AbortSignal) =>
      captureFile(dirs, { attachmentId: id, sourcePath: path }, (f) => progress.push(f), signal, {
        clone,
      });

    it("stores an exact copy under the id, with its hash, size and the original's time", async () => {
      const content = bytes(1_300_000);
      const path = original("report.pdf", content);
      utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_123_456));
      const progress: number[] = [];
      const result = await capture("a1", path, progress);
      expect(result).toEqual({
        sha256: sha(content),
        size: content.byteLength,
        sourceMtimeMs: 1_700_000_123_456,
      });
      const stored = attachmentPath(dirs, "a1");
      expect(Buffer.compare(readFileSync(stored), content)).toBe(0);
      expect(mode(stored)).toBe(0o600);
      expect(readdirSync(dirs.attachments)).toEqual(["a1"]);
      // read in pieces, never in one go, and always forwards to the end
      expect(progress.length).toBeGreaterThan(3);
      expect(progress).toEqual([...progress].sort((x, y) => x - y));
      expect(progress.at(-1)).toBe(1);
    });

    it("copes with an empty file", async () => {
      const progress: number[] = [];
      const result = await capture("e", original("empty.txt", ""), progress);
      expect(result).toEqual({
        sha256: sha(Buffer.alloc(0)),
        size: 0,
        sourceMtimeMs: expect.any(Number),
      });
      expect(statSync(attachmentPath(dirs, "e")).size).toBe(0);
      expect(progress.at(-1)).toBe(1);
    });

    it("keeps what was attached when the original is edited afterwards, and sees the edit", async () => {
      const path = original("notes.txt", "first version");
      utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      const done = await capture("n1", path);
      writeFileSync(path, "second, longer version");
      utimesSync(path, new Date(1_700_000_500_000), new Date(1_700_000_500_000));

      expect(readFileSync(attachmentPath(dirs, "n1"), "utf8")).toBe("first version");
      const now = await statSource(path);
      expect(now).toEqual({ mtimeMs: 1_700_000_500_000, size: 22 });
      expect(now?.mtimeMs).not.toBe(done.sourceMtimeMs);
      expect(now?.size).not.toBe(done.size);
      // asked again, it is a new copy under a new id
      const again = await capture("n2", path);
      expect(readFileSync(attachmentPath(dirs, "n2"), "utf8")).toBe("second, longer version");
      expect(again.sha256).not.toBe(done.sha256);
    });

    it("a missing original is unreadable, and leaves nothing behind", async () => {
      await expect(capture("x", join(origin, "gone.pdf"))).rejects.toMatchObject({
        name: "FileWorkError",
        kind: "unreadable",
      });
      expect(existsSync(dirs.attachments) ? readdirSync(dirs.attachments) : []).toEqual([]);
    });

    it("a folder is a folder", async () => {
      const dir = join(origin, "photos");
      mkdirSync(dir);
      await expect(capture("d", dir)).rejects.toMatchObject({ kind: "isDirectory" });
    });

    it.skipIf(process.getuid?.() === 0)("a file that may not be read is unreadable", async () => {
      const path = original("secret.txt", "x");
      chmodSync(path, 0o000);
      try {
        await expect(capture("s", path)).rejects.toMatchObject({ kind: "unreadable" });
        expect(readdirSync(dirs.attachments)).toEqual([]);
      } finally {
        chmodSync(path, 0o600);
      }
    });

    it("aborting leaves no partial copy", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        capture("z", original("big.bin", bytes(2_000_000)), [], controller.signal),
      ).rejects.toBeDefined();
      expect(readdirSync(dirs.attachments)).toEqual([]);
    });
  });
}

describe("ids name files, so they may not name paths", () => {
  it("refuses an id that is not plain", async () => {
    const path = original("a.txt", "x");
    for (const id of ["../evil", "a/b", "", ".", "..", "a b", "x".repeat(101)]) {
      await expect(
        captureFile(dirs, { attachmentId: id, sourcePath: path }, () => {}),
      ).rejects.toBeDefined();
    }
    expect(existsSync(join(root, "evil"))).toBe(false);
    expect(existsSync(dirs.attachments) ? readdirSync(dirs.attachments) : []).toEqual([]);
  });
});

describe("the spool (ADR 0041, rule 9)", () => {
  const input: ComposeInput = {
    from: { name: "Miłosz", address: "me@example.com" },
    to: [{ name: "Anna", address: "anna@northwind.example" }],
    cc: [],
    subject: "Wycena",
    inReplyTo: "",
    references: [],
    html: "<p>Cześć</p>",
    text: "Cześć",
    dateMs: Date.UTC(2026, 10, 4, 9, 0, 0),
  };
  const composer = new NodemailerComposer();
  const compose = (i: ComposeInput, files: readonly { path: string; filename: string }[]) =>
    composer.composeToStream(i, files);

  async function stored(id: string, name: string, content: Uint8Array) {
    const done = await captureFile(
      dirs,
      { attachmentId: id, sourcePath: original(`${id}-${name}`, content) },
      () => {},
    );
    return { attachmentId: id, name, sha256: done.sha256 };
  }

  it("holds the message with its files, readable by the parser, with the right bytes", async () => {
    const pdf = bytes(150_000);
    const note = Buffer.from("Zawartość pliku tekstowego\n".repeat(200));
    const files = [
      await stored("f1", "wycena.pdf", pdf),
      await stored("f2", "notatka ąę.txt", note),
    ];
    const built = await buildSpool(dirs, input, files, "op1", compose);

    expect(built.spoolPath).toBe(join(dirs.spool, "op1.eml"));
    expect(readdirSync(dirs.spool)).toEqual(["op1.eml"]);
    expect(mode(built.spoolPath)).toBe(0o600);
    const raw = readFileSync(built.spoolPath);
    expect(built.bytes).toBe(raw.byteLength);

    const parsed = await new PostalMimeParser().parse(new Uint8Array(raw));
    expect(parsed.messageId).toBe(built.messageId);
    expect(parsed.subject).toBe("Wycena");
    expect(parsed.text.trim()).toBe("Cześć");
    expect(parsed.attachments.map((a) => [a.filename, a.size, a.inline])).toEqual([
      ["wycena.pdf", pdf.byteLength, false],
      ["notatka ąę.txt", note.byteLength, false],
    ]);
    expect(parsed.attachments[0]?.mimeType).toBe("application/pdf");
    // the bytes are the files' bytes: their base64, 76 characters to a line
    const text = raw.toString("latin1");
    for (const file of [pdf, note]) {
      const wrapped = file.toString("base64").replace(/(.{76})/g, "$1\r\n");
      expect(text).toContain(wrapped);
    }
    // and the estimate the lanes and the limit use is close to the truth, and never below it
    const estimate = encodedMessageBytes([{ size: pdf.byteLength }, { size: note.byteLength }]);
    expect(estimate).toBeGreaterThanOrEqual(built.bytes - 2_000);
    expect(estimate).toBeLessThan(built.bytes + 2_000);
  });

  it("opens as a source of the size it has, and reads back whole", async () => {
    const file = await stored("f1", "a.bin", bytes(40_000));
    const built = await buildSpool(dirs, input, [file], "op2", compose);
    const source = openSpool(built.spoolPath);
    expect(source.size).toBe(built.bytes);
    const parts: Buffer[] = [];
    for await (const chunk of source.open()) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).byteLength).toBe(built.bytes);
    expect(Buffer.compare(Buffer.concat(parts), readFileSync(built.spoolPath))).toBe(0);
    expect(
      Buffer.compare(Buffer.from(await readSpool(built.spoolPath)), readFileSync(built.spoolPath)),
    ).toBe(0);
    expect(() => openSpool(join(dirs.spool, "nope.eml"))).toThrowError(/missing/);
    await expect(readSpool(join(dirs.spool, "nope.eml"))).rejects.toMatchObject({
      kind: "missing",
    });
  });

  it("a stored copy that is gone is missing, by the file's name, and nothing is written", async () => {
    const file = await stored("f1", "report.pdf", bytes(1000));
    rmSync(attachmentPath(dirs, "f1"));
    const error = await buildSpool(dirs, input, [file], "op3", compose).catch((e) => e);
    expect(kinds(error)).toBe("missing");
    expect(error.file).toBe("report.pdf");
    expect(error.message).toBe("report.pdf is missing");
    expect(existsSync(dirs.spool) ? readdirSync(dirs.spool) : []).toEqual([]);
  });

  it("a stored copy that changed is missing too", async () => {
    const file = await stored("f1", "report.pdf", bytes(1000));
    writeFileSync(attachmentPath(dirs, "f1"), "tampered");
    const error = await buildSpool(dirs, input, [file], "op4", compose).catch((e) => e);
    expect(kinds(error)).toBe("missing");
    expect(error.file).toBe("report.pdf");
  });

  it("leaves no temporary file when the message cannot be built", async () => {
    const file = await stored("f1", "report.pdf", bytes(1000));
    const failing = () => ({
      stream: (async function* () {
        yield new Uint8Array(5);
        throw new Error("composer failed");
      })(),
      messageId: "<x@y>",
    });
    await expect(buildSpool(dirs, input, [file], "op5", failing)).rejects.toThrow(/cannot be read/);
    expect(readdirSync(dirs.spool)).toEqual([]);
  });

  it("rebuilding an operation's message replaces its spool", async () => {
    const file = await stored("f1", "a.bin", bytes(500));
    const first = await buildSpool(dirs, input, [file], "op6", compose);
    const second = await buildSpool(dirs, input, [file], "op6", compose);
    expect(second.spoolPath).toBe(first.spoolPath);
    expect(readdirSync(dirs.spool)).toEqual(["op6.eml"]);
    expect(second.messageId).not.toBe(first.messageId);
  });
});

describe("cleaning up", () => {
  it("removes copies by id, and only those", async () => {
    const a = await captureFile(
      dirs,
      { attachmentId: "a", sourcePath: original("a", "1") },
      () => {},
    );
    await captureFile(dirs, { attachmentId: "b", sourcePath: original("b", "2") }, () => {});
    expect(a.size).toBe(1);
    await removeAttachments(dirs, ["a", "nope", "../b"]);
    expect(readdirSync(dirs.attachments)).toEqual(["b"]);
  });

  it("removes a spool, but nothing outside the spool directory", async () => {
    mkdirSync(dirs.spool, { recursive: true });
    const inside = join(dirs.spool, "x.eml");
    writeFileSync(inside, "m");
    const outside = original("keep.txt", "keep");
    await removeSpool(dirs, outside);
    await removeSpool(dirs, join(dirs.spool, "..", "originals", "keep.txt"));
    expect(existsSync(outside)).toBe(true);
    await removeSpool(dirs, inside);
    expect(existsSync(inside)).toBe(false);
  });

  it("sweeps what nothing refers to, temporary files included", async () => {
    mkdirSync(dirs.attachments, { recursive: true });
    mkdirSync(dirs.spool, { recursive: true });
    for (const name of ["keep", "drop", "keep.part", "stray.part"]) {
      writeFileSync(join(dirs.attachments, name), "x");
    }
    for (const name of ["live.eml", "dead.eml", "dead.eml.part"])
      writeFileSync(join(dirs.spool, name), "x");
    await sweep(dirs, ["keep"], [join(dirs.spool, "live.eml")]);
    expect(readdirSync(dirs.attachments).sort()).toEqual(["keep", "keep.part"]);
    expect(readdirSync(dirs.spool)).toEqual(["live.eml"]);
  });

  it("sweeping directories that do not exist yet is fine", async () => {
    await sweep(dirs, [], []);
  });

  it("statSource says nothing about a folder or a missing file", async () => {
    expect(await statSource(origin)).toBeNull();
    expect(await statSource(join(origin, "no"))).toBeNull();
  });
});

describe("createFileWork", () => {
  it("is the whole port over the two directories", async () => {
    const work = createFileWork(dirs, (i, files) =>
      new NodemailerComposer().composeToStream(i, files),
    );
    const progress: number[] = [];
    const path = original("a.txt", "hello");
    const done = await work.capture({ attachmentId: "a", sourcePath: path }, (f) =>
      progress.push(f),
    );
    expect(done.size).toBe(5);
    const built = await work.buildMessage(
      {
        from: { address: "me@example.com" },
        to: [{ address: "anna@northwind.example" }],
        cc: [],
        subject: "s",
        inReplyTo: "",
        references: [],
        html: "<p>x</p>",
        text: "x",
        dateMs: 0,
      },
      [{ attachmentId: "a", name: "a.txt", sha256: done.sha256 }],
      "opA",
    );
    expect(work.openSpool(built.spoolPath).size).toBe(built.bytes);
    expect((await work.statSource(built.spoolPath))?.size).toBe(built.bytes);
    await work.sweep(["a"], [built.spoolPath]);
    expect(readdirSync(dirs.spool)).toEqual(["opA.eml"]);
    await work.removeSpool(built.spoolPath);
    await work.removeAttachments(["a"]);
    expect(readdirSync(dirs.spool)).toEqual([]);
    expect(readdirSync(dirs.attachments)).toEqual([]);
  });
});
