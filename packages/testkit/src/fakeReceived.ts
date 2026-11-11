import type {
  CachedFile,
  MailAttachmentPort,
  MessageLocation,
  PartDownload,
  ReceivedFilesPort,
} from "@matters/core";

/** Where the in-memory cache says its files are: `FakeFileWork.readCache` reads a path back. */
const CACHE = "cache";

const partAt = (l: MessageLocation, partId: string): string =>
  [l.accountId, l.folderId, l.uidValidity, l.uid, partId].join("\u0000");

/**
 * The server's side of `MailAttachmentPort`: parts a test put there, as the chunks they arrive
 * in. A part nobody put, or one marked gone, is answered `gone`. Every call is counted, and a
 * test can hold a download open with a gate to watch how many run at once.
 */
export class FakeMailAttachments implements MailAttachmentPort {
  readonly requests: { location: MessageLocation; partId: string }[] = [];
  /** Failures to throw, one per call, before anything is answered. */
  readonly errors: unknown[] = [];
  /** Downloads running now; its high-water mark is `peak`. */
  active = 0;
  peak = 0;
  /** Each read of a chunk waits for this to resolve, when set. */
  gate: Promise<void> | null = null;
  private readonly parts = new Map<string, readonly Uint8Array[]>();

  put(location: MessageLocation, partId: string, ...chunks: Uint8Array[]): void {
    this.parts.set(partAt(location, partId), chunks);
  }

  async download(location: MessageLocation, partId: string): Promise<PartDownload> {
    this.requests.push({ location, partId });
    const failure = this.errors.shift();
    if (failure) throw failure;
    const chunks = this.parts.get(partAt(location, partId));
    if (!chunks) return { kind: "gone" };
    const server = this;
    return {
      kind: "found",
      content: (async function* () {
        server.active++;
        server.peak = Math.max(server.peak, server.active);
        try {
          for (const chunk of chunks) {
            if (server.gate) await server.gate;
            yield chunk;
          }
        } finally {
          server.active--;
        }
      })(),
    };
  }
}

interface Stored {
  bytes: Uint8Array[];
  name: string;
  usedMs: number;
  partial: boolean;
}

/**
 * `ReceivedFilesPort` in memory, honest about the same promises: a failed or aborted write leaves
 * nothing but, optionally, a partial file for the sweep to find; a finished one is whole.
 */
/** The cache's file at a path `locate` gave, or null for any other path. */
export function cachedAt(
  cache: Pick<InMemoryReceivedFiles, "content">,
  path: string,
): Uint8Array | null {
  const found = new RegExp(`^${CACHE}/(\\d+)/(.+)$`).exec(path);
  return found ? cache.content(Number(found[1]), found[2] as string) : null;
}

export class InMemoryReceivedFiles implements ReceivedFilesPort {
  private readonly files = new Map<string, Stored>();
  private nowMs = 0;
  /** Writes that stop after this many chunks, to leave a partial file behind (a crash). */
  crashAfterChunks: number | null = null;

  setNow(ms: number): void {
    this.nowMs = ms;
  }

  private id(key: number, partId: string): string {
    return `${key}/${partId}`;
  }

  async write(
    messageKey: number,
    partId: string,
    name: string,
    content: AsyncIterable<Uint8Array>,
    onBytes: (written: number) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    const id = this.id(messageKey, partId);
    const bytes: Uint8Array[] = [];
    let written = 0;
    for await (const chunk of content) {
      signal?.throwIfAborted();
      bytes.push(chunk);
      written += chunk.byteLength;
      onBytes(written);
      if (this.crashAfterChunks !== null && bytes.length >= this.crashAfterChunks) {
        this.files.set(id, { bytes, name, usedMs: this.nowMs, partial: true });
        throw new Error("crashed");
      }
    }
    this.files.set(id, { bytes, name, usedMs: this.nowMs, partial: false });
    return written;
  }

  async touch(messageKey: number, partId: string): Promise<boolean> {
    const file = this.files.get(this.id(messageKey, partId));
    if (!file || file.partial) return false;
    file.usedMs = this.nowMs;
    return true;
  }

  async locate(messageKey: number, partId: string): Promise<string | null> {
    const file = this.files.get(this.id(messageKey, partId));
    return file && !file.partial ? `${CACHE}/${this.id(messageKey, partId)}` : null;
  }

  /** A swept copy: the cache lost it, the message did not. */
  sweepAway(messageKey: number, partId: string): void {
    this.files.delete(this.id(messageKey, partId));
  }

  has(messageKey: number, partId: string): boolean {
    const file = this.files.get(this.id(messageKey, partId));
    return file !== undefined && !file.partial;
  }

  content(messageKey: number, partId: string): Uint8Array | null {
    const file = this.files.get(this.id(messageKey, partId));
    if (!file) return null;
    const out = new Uint8Array(file.bytes.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of file.bytes) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  /** Puts a finished file there with a last-used time, as an earlier run would have left it. */
  seed(messageKey: number, partId: string, bytes: number, usedMs: number, partial = false): void {
    this.files.set(this.id(messageKey, partId), {
      bytes: [new Uint8Array(bytes)],
      name: "file",
      usedMs,
      partial,
    });
  }

  async removeMessages(keys: readonly number[]): Promise<void> {
    const gone = new Set(keys);
    for (const id of [...this.files.keys()]) {
      if (gone.has(Number(id.slice(0, id.indexOf("/"))))) this.files.delete(id);
    }
  }

  async list(): Promise<readonly CachedFile[]> {
    return [...this.files].map(([id, f]) => {
      const slash = id.indexOf("/");
      return {
        messageKey: Number(id.slice(0, slash)),
        partId: id.slice(slash + 1),
        name: f.name,
        bytes: f.bytes.reduce((n, c) => n + c.byteLength, 0),
        usedMs: f.usedMs,
        partial: f.partial,
      };
    });
  }

  async remove(files: readonly CachedFile[]): Promise<void> {
    for (const f of files) this.files.delete(this.id(f.messageKey, f.partId));
  }

  get size(): number {
    return this.files.size;
  }
}
