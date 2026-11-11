import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, rmdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { CachedFile, ReceivedFilesPort } from "@matters/core";
import { isMessageKey, isPartId, safeFileName } from "@matters/core";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** A download in progress; no real file starts with a dot, since `safeFileName` removes them. */
const PARTIAL = ".part-";

function partDir(root: string, messageKey: number, partId: string): string {
  if (!isMessageKey(messageKey) || !isPartId(partId)) {
    throw new Error("That is not the key of a received file");
  }
  return join(root, String(messageKey), partId);
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The one finished file of a part's directory, if there is one. */
async function finishedFile(dir: string): Promise<string | null> {
  for (const name of await names(dir)) {
    if (name.startsWith(".")) continue;
    const found = await stat(join(dir, name)).catch(() => null);
    if (found?.isFile()) return name;
  }
  return null;
}

/** Hands the file everything the chunk holds, as many writes as the system takes to do it. */
async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  for (let done = 0; done < chunk.byteLength; ) {
    done += (await handle.write(chunk, done, chunk.byteLength - done)).bytesWritten;
  }
}

/**
 * The cache of received files (ADR 0043, rules 6 and 8) under `root`, as
 * `<message key>/<part id>/<name>`. Keys and part ids are checked before they become a path.
 */
export function createReceivedFiles(root: string): ReceivedFilesPort {
  return {
    async write(messageKey, partId, name, content, onBytes, signal) {
      const dir = partDir(root, messageKey, partId);
      await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
      const temp = join(dir, `${PARTIAL}${randomUUID()}`);
      // One chunk at a time: the next is pulled only once this one is written, which is the
      // backpressure. Nothing here ever holds more than a chunk.
      const handle = await open(temp, "wx", PRIVATE_FILE);
      let written = 0;
      try {
        try {
          for await (const chunk of content) {
            signal?.throwIfAborted();
            await writeAll(handle, chunk);
            written += chunk.byteLength;
            onBytes(written);
          }
        } finally {
          await handle.close();
        }
        // A copy under another name (the name was corrected since) must not stay beside it.
        const final = safeFileName(name);
        for (const other of await names(dir)) {
          if (other !== final && !other.startsWith(PARTIAL))
            await rm(join(dir, other), { force: true });
        }
        await rename(temp, join(dir, final));
        return written;
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    },

    async touch(messageKey, partId) {
      const dir = partDir(root, messageKey, partId);
      const name = await finishedFile(dir);
      if (name === null) return false;
      const now = new Date();
      await utimes(join(dir, name), now, now).catch(() => {});
      return true;
    },

    async locate(messageKey, partId) {
      const dir = partDir(root, messageKey, partId);
      const name = await finishedFile(dir);
      return name === null ? null : join(dir, name);
    },

    async removeMessages(keys) {
      for (const key of keys) {
        if (isMessageKey(key)) await rm(join(root, String(key)), { recursive: true, force: true });
      }
    },

    async list() {
      const out: CachedFile[] = [];
      for (const keyName of await names(root)) {
        const messageKey = Number(keyName);
        if (!isMessageKey(messageKey) || String(messageKey) !== keyName) continue;
        for (const partId of await names(join(root, keyName))) {
          if (!isPartId(partId)) continue;
          for (const name of await names(join(root, keyName, partId))) {
            const found = await stat(join(root, keyName, partId, name)).catch(() => null);
            if (!found?.isFile()) continue;
            out.push({
              messageKey,
              partId,
              name,
              bytes: found.size,
              usedMs: found.mtimeMs,
              partial: name.startsWith(PARTIAL),
            });
          }
        }
      }
      return out;
    },

    async remove(files) {
      for (const f of files) {
        const dir = partDir(root, f.messageKey, f.partId);
        // `name` came from our own listing, but it still may not climb out of the directory.
        if (f.name.includes("/") || f.name.includes("\\") || f.name === "..") continue;
        await rm(join(dir, f.name), { force: true });
        // Empty directories go too; a directory that is not empty stays, and that is fine.
        await rmdir(dir).catch(() => {});
        await rmdir(join(root, String(f.messageKey))).catch(() => {});
      }
    },
  };
}
