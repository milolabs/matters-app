import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, type Dirent, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  BuiltMessage,
  CaptureJob,
  CaptureResult,
  ComposeInput,
  FileWorkPort,
  MimeSource,
} from "@matters/core";
import { FileWorkError } from "@matters/core";

/** The two directories the app keeps user files in, both under its data directory (ADR 0041). */
export interface FileDirs {
  /** Stored copies, one file per attachment id. */
  readonly attachments: string;
  /** Built messages, one file per send operation. */
  readonly spool: string;
}

/**
 * Builds a message as a stream from files on disk. The composer lives in another adapter, so
 * the caller brings it: `NodemailerComposer.composeToStream` does exactly this.
 */
export type ComposeStream = (
  input: ComposeInput,
  files: readonly { readonly path: string; readonly filename: string }[],
) => { readonly stream: AsyncIterable<Uint8Array>; readonly messageId: string };

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const CHUNK = 256 * 1024;
/** Ids come from outside the process; they name files, so they may not name a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function attachmentPath(dirs: FileDirs, id: string): string {
  if (!SAFE_ID.test(id)) throw new FileWorkError("unreadable", "That attachment id is not valid");
  return join(dirs.attachments, id);
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

/** The kinds of ADR 0041, rule 23, from what the operating system said. */
function fileError(error: unknown, what: string): FileWorkError {
  if (error instanceof FileWorkError) return error;
  const code = codeOf(error);
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new FileWorkError("noSpace", "There is not enough disk space");
  }
  if (code === "EISDIR") return new FileWorkError("isDirectory", `${what} is a folder`);
  return new FileWorkError("unreadable", `${what} cannot be read`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
}

/**
 * Reads a file in chunks, hashing and counting; never the whole file at once. One buffer is
 * reused for every read: a stream hands out a new 256 KB buffer per chunk, and those wait for the
 * garbage collector, so the process grows by about what it read until a collection (ADR 0041's
 * memory budget). Reading into one buffer keeps it flat however large the file.
 */
async function hashFile(
  path: string,
  onBytes?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let bytes = 0;
  const handle = await open(path, "r");
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      onBytes?.(bytes);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Copies an original into the data directory under the attachment's id (ADR 0041, rule 2). An
 * APFS clone is tried first (`COPYFILE_FICLONE_FORCE`): it costs almost nothing and is a snapshot
 * of the file as it is. Where the clone is refused (another volume, another file system) the
 * bytes are streamed instead, hashed and counted on the way. The copy has a temporary name until
 * it is whole, and mode 0600. The original's modification time is taken before the copy, so an
 * edit during it shows later as a change.
 */
export async function captureFile(
  dirs: FileDirs,
  job: CaptureJob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  options: { readonly clone?: boolean } = {},
): Promise<CaptureResult> {
  const dest = attachmentPath(dirs, job.attachmentId);
  const temp = `${dest}.part`;
  let before: Awaited<ReturnType<typeof stat>>;
  try {
    before = await stat(job.sourcePath);
  } catch (error) {
    throw fileError(error, job.sourcePath);
  }
  if (before.isDirectory()) throw new FileWorkError("isDirectory", `${job.sourcePath} is a folder`);
  if (!before.isFile()) throw new FileWorkError("unreadable", `${job.sourcePath} is not a file`);
  const total = Number(before.size);
  const report = (bytes: number) => onProgress(total === 0 ? 1 : Math.min(1, bytes / total));

  try {
    await ensureDir(dirs.attachments);
    await rm(temp, { force: true });
    let result: { sha256: string; bytes: number };
    try {
      // Tests turn the clone off to reach the streaming path on a volume that clones.
      if (options.clone === false) throw Object.assign(new Error("no clone"), { code: "ENOTSUP" });
      await copyFile(job.sourcePath, temp, constants.COPYFILE_FICLONE_FORCE);
      await chmod(temp, PRIVATE_FILE);
      result = await hashFile(temp, report, signal);
    } catch (error) {
      // Only a clone that is not possible falls back; a full disk or a gone file does not.
      const code = codeOf(error);
      if (code === "ENOSPC" || code === "EDQUOT" || code === "ENOENT" || code === "EACCES") {
        throw error;
      }
      if ((error as { name?: string }).name === "AbortError") throw error;
      await rm(temp, { force: true });
      result = await streamCopy(job.sourcePath, temp, report, signal);
    }
    await rename(temp, dest);
    report(result.bytes);
    return { sha256: result.sha256, size: result.bytes, sourceMtimeMs: before.mtimeMs };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw fileError(error, job.sourcePath);
  }
}

async function streamCopy(
  from: string,
  to: string,
  report: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let bytes = 0;
  const source = await open(from, "r");
  try {
    const target = await open(to, "wx", PRIVATE_FILE);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, CHUNK, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        // A write can take less than it was given; the rest goes after it.
        for (let done = 0; done < bytesRead; ) {
          done += (await target.write(buffer, done, bytesRead - done)).bytesWritten;
        }
        bytes += bytesRead;
        report(bytes);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Writes the message with its files to the spool (ADR 0041, rule 9): every stored copy is
 * hashed first and must match what was recorded, then the composed stream is written to a
 * temporary name, synced to disk and renamed. A file that is gone, or changed, is `missing`.
 */
export async function buildSpool(
  dirs: FileDirs,
  input: ComposeInput,
  files: readonly {
    readonly attachmentId: string;
    readonly name: string;
    readonly sha256: string;
  }[],
  operationId: string,
  compose: ComposeStream,
): Promise<BuiltMessage> {
  if (!SAFE_ID.test(operationId)) {
    throw new FileWorkError("unreadable", "That operation id is not valid");
  }
  const parts: { path: string; filename: string }[] = [];
  for (const file of files) {
    const path = attachmentPath(dirs, file.attachmentId);
    let found: { sha256: string };
    try {
      found = await hashFile(path);
    } catch {
      throw new FileWorkError("missing", `${file.name} is missing`, file.name);
    }
    if (found.sha256 !== file.sha256) {
      throw new FileWorkError("missing", `${file.name} is missing`, file.name);
    }
    parts.push({ path, filename: file.name });
  }

  await ensureDir(dirs.spool);
  const spoolPath = join(dirs.spool, `${operationId}.eml`);
  const temp = `${spoolPath}.part`;
  const { stream, messageId } = compose(input, parts);
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.byteLength;
      done(null, chunk);
    },
  });
  try {
    // `Readable.from` accepts any async iterable of bytes, a nodemailer stream included.
    await pipeline(
      Readable.from(stream, { objectMode: false }),
      count,
      createWriteStream(temp, { mode: PRIVATE_FILE, flags: "w" }),
    );
    // The stream closed its file; open it once more to ask the disk to keep what it was given.
    const handle = await open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (codeOf(error) === "ENOENT" && (error as { path?: string }).path !== temp) {
      // A stored copy vanished between the hash and the read.
      throw new FileWorkError("missing", "A file of the message is missing");
    }
    throw fileError(error, "The message");
  }
  await rename(temp, spoolPath);
  return { messageId, bytes, spoolPath };
}

/** The size is a `stat` away, so this is synchronous: a spool is a file, not a stream of unknown length. */
export function openSpool(path: string): MimeSource {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new FileWorkError("missing", "The built message is missing");
  }
  return {
    size,
    open: () => createReadStream(path, { highWaterMark: CHUNK }),
  };
}

export async function readSpool(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    throw new FileWorkError("missing", "The built message is missing");
  }
}

export async function statSource(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { mtimeMs: s.mtimeMs, size: Number(s.size) } : null;
  } catch {
    return null;
  }
}

export async function removeAttachments(dirs: FileDirs, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    if (!SAFE_ID.test(id)) continue;
    const path = join(dirs.attachments, id);
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
  }
}

/** Only files inside the spool directory are ever deleted, whatever path is passed in. */
export async function removeSpool(dirs: FileDirs, path: string): Promise<void> {
  const root = resolve(dirs.spool) + sep;
  if (!resolve(path).startsWith(root)) return;
  await rm(path, { force: true });
  await rm(`${path}.part`, { force: true });
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Deletes whatever the directories hold that no row or send refers to (ADR 0041, rule 19). */
export async function sweep(
  dirs: FileDirs,
  keepAttachmentIds: readonly string[],
  keepSpoolPaths: readonly string[],
): Promise<void> {
  const ids = new Set(keepAttachmentIds);
  for (const entry of await entries(dirs.attachments)) {
    const id = entry.name.endsWith(".part") ? entry.name.slice(0, -5) : entry.name;
    if (!ids.has(id))
      await rm(join(dirs.attachments, entry.name), { recursive: true, force: true });
  }
  const spools = new Set(keepSpoolPaths.map((p) => resolve(p)));
  for (const entry of await entries(dirs.spool)) {
    const path = join(dirs.spool, entry.name);
    const whole = entry.name.endsWith(".part") ? path.slice(0, -5) : path;
    if (!spools.has(resolve(whole))) await rm(path, { recursive: true, force: true });
  }
}

/** The whole `FileWorkPort` over two directories; `compose` is the message builder to stream. */
export function createFileWork(dirs: FileDirs, compose: ComposeStream): FileWorkPort {
  return {
    capture: (job, onProgress, signal) => captureFile(dirs, job, onProgress, signal),
    buildMessage: (input, files, operationId) =>
      buildSpool(dirs, input, files, operationId, compose),
    openSpool,
    readSpool,
    statSource,
    removeAttachments: (ids) => removeAttachments(dirs, ids),
    removeSpool: (path) => removeSpool(dirs, path),
    sweep: (ids, paths) => sweep(dirs, ids, paths),
  };
}
