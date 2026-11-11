/**
 * How a file reaches the recipient (ADR 0040). `inline` is a part of the MIME message; a link
 * is a file some carrier keeps for us. Only `inline` exists until a carrier is built.
 */
export type AttachmentDelivery =
  | { readonly kind: "inline" }
  | { readonly kind: "link"; readonly carrierId: string };

/** A file as the draft lists it. The id names one immutable stored copy (ADR 0041, rule 2). */
export interface DraftAttachment {
  readonly id: string;
  readonly name: string;
  /** Bytes of the file itself, not of its encoding. */
  readonly size: number;
  readonly delivery: AttachmentDelivery;
}

/**
 * - `reading`: being copied into the app's data directory. Never blocks Send (ADR 0041, rule 7).
 * - `ready`: the copy exists and its hash is known.
 * - `failed`: the original could not be read; `reason` says why.
 * - `tooLarge`: alone over the account's limit, so it was not copied at all.
 */
export type AttachmentState = "reading" | "ready" | "failed" | "tooLarge";

/**
 * Where a forwarded file comes from (ADR 0045, rule 8): a part of a received message. This, and
 * not a path, is what a retry starts from, because the cache entry it was copied from may be gone.
 */
export interface AttachmentOrigin {
  readonly messageKey: number;
  readonly partId: string;
}

/** What the backend keeps about a file of a draft. The bytes live in the data directory. */
export interface StoredAttachment {
  readonly id: string;
  readonly draftId: string;
  readonly accountId: string;
  readonly name: string;
  readonly size: number;
  readonly state: AttachmentState;
  /** Why it `failed` or is `tooLarge`, in words for the user; null otherwise. */
  readonly reason: string | null;
  /** SHA-256 (hex) of the stored copy; null until it is `ready`. */
  readonly sha256: string | null;
  /**
   * Where the original was; kept to read it again and to notice that it changed. Null for a
   * forwarded file: it has an `origin` instead, and the cache copy it was read from is not its own.
   */
  readonly sourcePath: string | null;
  readonly sourceMtimeMs: number | null;
  /** Set for a file forwarded from a received message (ADR 0045); null for every other. */
  readonly origin: AttachmentOrigin | null;
  readonly createdAtMs: number;
}

/** Heavy mail is said, not refused: a recipient's server may take less than ours (ADR 0040). */
export const HEAVY_BYTES = 10_000_000;
/** From this encoded size a message goes through the large lane (ADR 0041, rule 11). */
export const LARGE_LANE_BYTES = 1_048_576;
/** What one part's headers and boundary are counted as. A fixed figure keeps the estimate stable. */
export const PART_OVERHEAD_BYTES = 512;

/**
 * What one file costs on the wire: base64 grows 3 bytes to 4, and a line break (CRLF) follows
 * every 76 characters.
 */
export function encodedPartBytes(rawBytes: number): number {
  const base64 = Math.ceil(rawBytes / 3) * 4;
  return base64 + 2 * Math.ceil(base64 / 76);
}

/**
 * What the server will count for these files: the encoded parts and a fixed allowance for their
 * headers. The body the user wrote is not part of the estimate. No files, no bytes.
 */
export function encodedMessageBytes(files: readonly { readonly size: number }[]): number {
  let total = 0;
  for (const f of files) total += encodedPartBytes(f.size) + PART_OVERHEAD_BYTES;
  return total;
}

/** One way to send a file other than inside the message; offered by a carrier (ADR 0040). */
export interface CarrierOffer {
  readonly carrierId: string;
  /** "Dropbox". */
  readonly label: string;
  readonly fileId: string;
}

/** What `notifyIfLarge` needs of a carrier; the full port is `AttachmentCarrierPort`. */
export interface OfferingCarrier {
  readonly id: string;
  readonly label: string;
  /** Cheap and offline: can this carrier take this file for this account? */
  offerFor(file: StoredAttachment, accountId: string): CarrierOffer | null;
}

export interface LargeNotice {
  readonly kind: "heavy" | "tooLarge";
  /** What the server will count, not the sum of the file sizes. */
  readonly encodedBytes: number;
  /** The account's, when known. */
  readonly limitBytes: number | null;
  /** Ways to send the files some other way; empty until a carrier exists. */
  readonly offers: readonly CarrierOffer[];
}

/**
 * The one place that decides "this is large" (ADR 0040, rule 3); nothing else compares a size to
 * a limit. `tooLarge` is a send blocker, `heavy` only a remark.
 */
export function notifyIfLarge(
  files: readonly StoredAttachment[],
  limitBytes: number | null,
  carriers: readonly OfferingCarrier[],
): LargeNotice | null {
  const encodedBytes = encodedMessageBytes(files);
  const kind =
    limitBytes !== null && encodedBytes > limitBytes
      ? "tooLarge"
      : encodedBytes >= HEAVY_BYTES
        ? "heavy"
        : null;
  if (kind === null) return null;
  const offers: CarrierOffer[] = [];
  for (const carrier of carriers) {
    for (const file of files) {
      const offer = carrier.offerFor(file, file.accountId);
      if (offer) offers.push(offer);
    }
  }
  return { kind, encodedBytes, limitBytes, offers };
}

/** Megabytes as a person counts them (Finder does the same): 1 MB is a million bytes. */
function megabytes(bytes: number): string {
  const rounded = Math.round(bytes / 100_000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}

export function describeLargeNotice(notice: LargeNotice): string {
  const size = megabytes(notice.encodedBytes);
  if (notice.kind === "heavy") return `${size} to send. Some servers refuse mail this large.`;
  const limit =
    notice.limitBytes === null ? "" : `, your server takes ${megabytes(notice.limitBytes)}`;
  return `${size} to send${limit}. Remove a file.`;
}

/** Where a message that is large travels (ADR 0041, rule 11). */
export type SendLane = "small" | "large";

export function laneFor(encodedBytes: number): SendLane {
  return encodedBytes >= LARGE_LANE_BYTES ? "large" : "small";
}

/** The reason shown on a chip for each way a copy can fail (ADR 0041, rule 23). */
export const ATTACHMENT_REASONS = {
  unreadable: "Can't read this file",
  noSpace: "Not enough disk space",
  isDirectory: "Folders can't be attached. Zip it first.",
  tooLarge: "Larger than your server takes",
  /** A forwarded file could not be downloaded: offline, or the server said no (ADR 0045). */
  download: "Couldn’t download",
  /** The message is no longer on the server, so there is nothing to try again (ADR 0043, rule 9). */
  gone: "No longer on the server",
} as const;

/** Whether "Try again" can help: a message that left the server will not come back. */
export function canRetryAttachment(file: Pick<StoredAttachment, "state" | "reason">): boolean {
  return file.state === "failed" && file.reason !== ATTACHMENT_REASONS.gone;
}
