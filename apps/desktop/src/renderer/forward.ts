// What a forward starts with on the page (ADR 0045). Pure: the session in compose.ts holds the
// state and makes the requests.
import type { ThreadMessage } from "@matters/contracts";
import { forwardNotices } from "@matters/core";

/** A part of the quoted message that becomes a chip of the new draft (rule 6). */
export interface ForwardedFile {
  /** Made here, so the chip exists in the frame of the composer, before the backend answers. */
  readonly id: string;
  readonly messageKey: number;
  readonly partId: string;
  readonly name: string;
  /** An estimate until the file has been downloaded (rule 10). */
  readonly size: number;
}

export interface ForwardPlan {
  readonly files: readonly ForwardedFile[];
  /** What is not carried, in the lines of rules 11 and 12. */
  readonly notices: readonly string[];
}

/**
 * The files and the remarks for a forward of `message`, which the open thread already has (so the
 * chips need no request). A message the page does not know, or whose files are not known yet,
 * carries none (rule 11): nothing is guessed.
 */
export function planForward(message: ThreadMessage | undefined, newId: () => string): ForwardPlan {
  const known = message?.attachmentsKnown === true;
  const files =
    message && known
      ? message.attachments.map((a) => ({
          id: newId(),
          messageKey: message.key,
          partId: a.partId,
          name: a.name,
          size: a.size,
        }))
      : [];
  return {
    files,
    notices: forwardNotices({
      attachmentsKnown: known,
      htmlKind: message?.htmlKind,
      hasInline: message?.hasInline ?? false,
    }),
  };
}
