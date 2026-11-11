import type { AttachmentInfo } from "@matters/contracts";
import type { StoredAttachment } from "@matters/core";
import { canRetryAttachment } from "@matters/core";

/** What the page may know of a stored file: never the path, never the hash. */
export function toAttachmentInfo(row: StoredAttachment): AttachmentInfo {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    state: row.state,
    reason: row.reason,
    canRetry: canRetryAttachment(row),
    forwarded: row.origin !== null,
  };
}
