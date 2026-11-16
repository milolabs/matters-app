import { randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SourceFilesPort } from "@matters/core";

const PRIVATE_FILE = 0o600;

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
 * Messages saved as files (ADR 0145, rule 2), written where main's dialog said. The temporary
 * file is beside the target (so the last step is a rename on one disk), named with a leading dot
 * and the target's own name, `.Lunch 2026-11-16.eml.part-<random>`, made with `wx` (never an
 * existing file, never through a link) and mode 0600: no execute bit, readable by the person
 * alone. It is flushed to disk before it takes the name. With `overwrite`, the rename replaces
 * what is there (the dialog asked); without, a hard link takes the name only if it is free, so a
 * file that is there is never replaced, and the temporary name goes after.
 */
export function createSourceFiles(): SourceFilesPort {
  return {
    async write(target, overwrite, content, onBytes, signal) {
      const temp = join(dirname(target), `.${basename(target)}.part-${randomUUID()}`);
      const handle = await open(temp, "wx", PRIVATE_FILE);
      let written = 0;
      try {
        try {
          // One chunk at a time: the next is pulled only once this one is written.
          for await (const chunk of content) {
            signal?.throwIfAborted();
            await writeAll(handle, chunk);
            written += chunk.byteLength;
            onBytes(written);
          }
          signal?.throwIfAborted();
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (overwrite) {
          await rename(temp, target);
        } else {
          await link(temp, target);
          await rm(temp, { force: true });
        }
        return written;
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    },
  };
}
