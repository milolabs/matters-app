import { createHash } from "node:crypto";
import type {
  AttachmentCarrierPort,
  AttachmentState,
  AttachmentStorePort,
  BuiltMessage,
  CaptureJob,
  CaptureResult,
  CarriedFile,
  CarrierOffer,
  CarryContext,
  ComposeInput,
  FileWorkPort,
  MimeSource,
  StoredAttachment,
} from "@matters/core";
import { FileWorkError } from "@matters/core";
import { cachedAt, type InMemoryReceivedFiles } from "./fakeReceived.ts";

/** The rows of draft files, in memory. Snapshots are not needed: no unit of work includes them. */
export class InMemoryAttachmentStore implements AttachmentStorePort {
  private rows = new Map<string, StoredAttachment>();

  async add(attachment: StoredAttachment): Promise<void> {
    if (this.rows.has(attachment.id)) throw new Error(`attachment ${attachment.id} exists`);
    this.rows.set(attachment.id, attachment);
  }

  async get(id: string): Promise<StoredAttachment | null> {
    return this.rows.get(id) ?? null;
  }

  async forDraft(draftId: string): Promise<readonly StoredAttachment[]> {
    return [...this.rows.values()].filter((r) => r.draftId === draftId);
  }

  async update(attachment: StoredAttachment): Promise<void> {
    const row = this.rows.get(attachment.id);
    if (row) this.rows.set(attachment.id, { ...attachment, accountId: row.accountId });
  }

  async moveDraft(draftId: string, accountId: string): Promise<void> {
    for (const row of await this.forDraft(draftId)) {
      this.rows.set(row.id, { ...row, accountId });
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }

  async listByState(states: readonly AttachmentState[]): Promise<readonly StoredAttachment[]> {
    return [...this.rows.values()].filter((r) => states.includes(r.state));
  }

  async allIds(): Promise<readonly string[]> {
    return [...this.rows.keys()];
  }

  async discardAccount(accountId: string): Promise<void> {
    for (const [id, r] of this.rows) if (r.accountId === accountId) this.rows.delete(id);
  }
}

/** What a fake path holds: a file with bytes, or a thing that cannot be read. */
export type FakeSource =
  | { readonly kind: "file"; readonly bytes: Uint8Array; readonly mtimeMs: number }
  | { readonly kind: "directory" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "noSpace" };

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * File work without a disk or a thread: originals are put in `sources`, stored copies and spools
 * are kept in maps. A capture can be held with `hold(path)` so a test sees the `reading` state.
 */
export class FakeFileWork implements FileWorkPort {
  readonly sources = new Map<string, FakeSource>();
  readonly stored = new Map<string, { bytes: Uint8Array; sha256: string }>();
  readonly spools = new Map<string, Uint8Array>();
  readonly captures: CaptureJob[] = [];
  readonly built: { operationId: string; input: ComposeInput; names: string[] }[] = [];
  readonly swept: { keepAttachmentIds: readonly string[]; keepSpoolPaths: readonly string[] }[] =
    [];
  /** The received-file cache that paths from `locate` point into (ADR 0045). */
  cache: Pick<InMemoryReceivedFiles, "content"> | null = null;
  /** Makes the next `buildMessage` fail with this. */
  failBuild: FileWorkError | null = null;
  private readonly holds = new Map<string, Promise<void>>();
  private builds = 0;

  addFile(path: string, content: string | Uint8Array, mtimeMs = 1_000): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.sources.set(path, { kind: "file", bytes, mtimeMs });
  }

  /** Holds captures of this path until the returned function is called. */
  hold(path: string): () => void {
    let release: () => void = () => {};
    this.holds.set(
      path,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      release();
      this.holds.delete(path);
    };
  }

  async capture(
    job: CaptureJob,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<CaptureResult> {
    this.captures.push(job);
    onProgress(0);
    await this.holds.get(job.sourcePath);
    if (signal?.aborted) throw new FileWorkError("unreadable", "Aborted");
    const cached = this.cache ? cachedAt(this.cache, job.sourcePath) : null;
    const source: FakeSource | undefined = cached
      ? { kind: "file", bytes: cached, mtimeMs: 1_000 }
      : this.sources.get(job.sourcePath);
    if (!source) throw new FileWorkError("unreadable", `${job.sourcePath} cannot be read`);
    if (source.kind === "directory") {
      throw new FileWorkError("isDirectory", `${job.sourcePath} is a folder`);
    }
    if (source.kind === "noSpace") throw new FileWorkError("noSpace", "No space left on device");
    if (source.kind === "unreadable") {
      throw new FileWorkError("unreadable", `${job.sourcePath} cannot be read`);
    }
    onProgress(1);
    const sha256 = sha256Of(source.bytes);
    this.stored.set(job.attachmentId, { bytes: source.bytes, sha256 });
    return { sha256, size: source.bytes.byteLength, sourceMtimeMs: source.mtimeMs };
  }

  /**
   * Not a MIME message, but one a test can read: headers, the text, then each file between
   * markers. Checks the stored copies as the real one does.
   */
  async buildMessage(
    input: ComposeInput,
    files: readonly { attachmentId: string; name: string; sha256: string }[],
    operationId: string,
  ): Promise<BuiltMessage> {
    if (this.failBuild) {
      const error = this.failBuild;
      this.failBuild = null;
      throw error;
    }
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    this.builds++;
    const messageId = `<fake-spool-${this.builds}@example.test>`;
    parts.push(
      encoder.encode(
        `Message-ID: ${messageId}\r\nSubject: ${input.subject}\r\n\r\n${input.text}\r\n`,
      ),
    );
    for (const file of files) {
      const copy = this.stored.get(file.attachmentId);
      if (!copy || copy.sha256 !== file.sha256) {
        throw new FileWorkError("missing", `${file.name} is missing`, file.name);
      }
      parts.push(encoder.encode(`--file ${file.name}\r\n`), copy.bytes);
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    const spoolPath = `spool/${operationId}`;
    this.spools.set(spoolPath, bytes);
    this.built.push({ operationId, input, names: files.map((f) => f.name) });
    return { messageId, bytes: bytes.byteLength, spoolPath };
  }

  openSpool(path: string): MimeSource {
    const bytes = this.spools.get(path);
    if (!bytes) throw new FileWorkError("missing", `${path} is missing`);
    // Two chunks, so progress has something to report.
    const half = Math.ceil(bytes.byteLength / 2);
    return {
      size: bytes.byteLength,
      open: () =>
        (async function* () {
          yield bytes.subarray(0, half);
          yield bytes.subarray(half);
        })(),
    };
  }

  async readSpool(path: string): Promise<Uint8Array> {
    const bytes = this.spools.get(path);
    if (!bytes) throw new FileWorkError("missing", `${path} is missing`);
    return bytes;
  }

  async statSource(path: string): Promise<{ mtimeMs: number; size: number } | null> {
    const spool = this.spools.get(path);
    if (spool) return { mtimeMs: 0, size: spool.byteLength };
    const source = this.sources.get(path);
    return source?.kind === "file"
      ? { mtimeMs: source.mtimeMs, size: source.bytes.byteLength }
      : null;
  }

  async removeAttachments(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.stored.delete(id);
  }

  async removeSpool(path: string): Promise<void> {
    this.spools.delete(path);
  }

  async sweep(keepAttachmentIds: readonly string[], keepSpoolPaths: readonly string[]) {
    this.swept.push({ keepAttachmentIds, keepSpoolPaths });
    for (const id of [...this.stored.keys()]) {
      if (!keepAttachmentIds.includes(id)) this.stored.delete(id);
    }
    for (const path of [...this.spools.keys()]) {
      if (!keepSpoolPaths.includes(path)) this.spools.delete(path);
    }
  }
}

/**
 * A carrier that offers to take any file over `minBytes`, so the seam of ADR 0040 is exercised
 * by every test that asks `notifyIfLarge`. Its `carry` is not called by anything yet.
 */
export class FakeCarrier implements AttachmentCarrierPort {
  readonly id = "fake";
  readonly label = "Fake Drive";
  readonly offered: string[] = [];
  private readonly minBytes: number;

  constructor(minBytes = 0) {
    this.minBytes = minBytes;
  }

  offerFor(file: StoredAttachment, _accountId: string): CarrierOffer | null {
    this.offered.push(file.id);
    return file.size >= this.minBytes
      ? { carrierId: this.id, label: this.label, fileId: file.id }
      : null;
  }

  async carry(file: StoredAttachment, _context: CarryContext): Promise<CarriedFile> {
    return {
      attachmentId: file.id,
      url: `https://fake.example/${file.id}`,
      audience: "Anyone with the link",
      expiresAtMs: null,
    };
  }
}
