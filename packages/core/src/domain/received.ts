import type { MessageLocation } from "./entities.ts";

/**
 * Files that arrived by mail (ADR 0043). A message's attachments are rows, read with its thread;
 * the bytes stay on the server until someone asks for them, and then live in a cache.
 */

/** One part of a message that is a file, as `BODYSTRUCTURE` described it. */
export interface ReceivedAttachment {
  /** The IMAP part number, `1`, `2.1`: what fetches this part later. */
  readonly partId: string;
  /** Already through `safeFileName`. */
  readonly name: string;
  readonly mimeType: string;
  /** Decoded bytes, estimated from the encoded size (ADR 0043, rule 1). */
  readonly size: number;
  readonly contentId?: string;
  /** Shown inside the body (a logo), not something to list. */
  readonly inline: boolean;
}

/** What the server said about the files of the message at this location. */
export interface AttachmentAnswer {
  readonly location: MessageLocation;
  /** Every file part in order, inline ones too. */
  readonly attachments: readonly ReceivedAttachment[];
}

/** The attachments of one message as an opened thread shows them. */
export interface MessageAttachments {
  /** False until the structure has been read: the reader shows the old badge, with no actions. */
  readonly known: boolean;
  /** The ones to list, in order: inline parts are not among them. */
  readonly items: readonly ReceivedAttachment[];
  /** The message also has parts inside its body, which are not listed (a logo, a picture). */
  readonly hasInline: boolean;
}

/** Part numbers are digits and dots (`2`, `1.2.1`); anything else never names a directory. */
const PART_ID = /^\d+(?:\.\d+)*$/;
const MAX_PART_ID_LENGTH = 64;

export function isPartId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PART_ID_LENGTH && PART_ID.test(value);
}

/** A message key is a positive safe integer (ADR 0006); it names a directory of the cache. */
export function isMessageKey(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** What a part is called when the cache is asked about it: one key for joining and in-use checks. */
export const receivedId = (messageKey: number, partId: string): string => `${messageKey}/${partId}`;

/** Seven days: a copy nobody opened for this long goes (ADR 0043, rule 8). */
export const RECEIVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The cache is cut back to this, oldest first. */
export const RECEIVED_MAX_BYTES = 2_000_000_000;

/** A file of the cache as the sweep sees it. */
export interface CachedFile {
  readonly messageKey: number;
  readonly partId: string;
  /** The file's name in its directory; a partial file has a temporary one. */
  readonly name: string;
  readonly bytes: number;
  /** Last time it was downloaded or opened. */
  readonly usedMs: number;
  /** Left over from a download that did not finish. */
  readonly partial: boolean;
}

export interface SweepPolicy {
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  /** `receivedId`s that are being downloaded or opened right now. */
  readonly inUse: ReadonlySet<string>;
}

/**
 * What to delete from the cache (ADR 0043, rule 8): partial files that nothing is writing, then
 * everything not used for `maxAgeMs`, then the oldest of the rest until no more than `maxBytes`
 * remain. A file in use is never chosen, whatever its age.
 */
export function planSweep(files: readonly CachedFile[], policy: SweepPolicy): CachedFile[] {
  const busy = (f: CachedFile) => policy.inUse.has(receivedId(f.messageKey, f.partId));
  const doomed = new Set<CachedFile>();
  for (const f of files) if (f.partial && !busy(f)) doomed.add(f);
  for (const f of files) {
    if (!f.partial && !busy(f) && policy.nowMs - f.usedMs > policy.maxAgeMs) doomed.add(f);
  }
  const kept = files.filter((f) => !f.partial && !doomed.has(f));
  let total = kept.reduce((n, f) => n + f.bytes, 0);
  for (const f of [...kept].sort((a, b) => a.usedMs - b.usedMs)) {
    if (total <= policy.maxBytes) break;
    if (busy(f)) continue;
    doomed.add(f);
    total -= f.bytes;
  }
  return [...doomed];
}
