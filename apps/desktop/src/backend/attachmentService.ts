import type { AttachmentInfo } from "@matters/contracts";
import type { AttachmentDeps, ProbeLimitDeps } from "@matters/core";
import {
  addAttachments,
  addForwardedAttachments,
  checkAttachmentSources,
  probeMessageLimit,
  recaptureAttachment,
  resumeCaptures,
  sweepAttachmentFiles,
} from "@matters/core";
import { toAttachmentInfo } from "./attachmentInfo.ts";

export interface AttachmentServiceDeps {
  readonly attach: AttachmentDeps;
  readonly probe: ProbeLimitDeps;
  /** The copies of these attachments ended: their grants (and temporary files) can go. */
  readonly onCaptured: (ids: readonly string[]) => void;
}

/**
 * The attachment requests of the router, over the core use cases. Runs in the sync worker: it
 * writes rows, and its copies run on the attachment thread through `FileWorkPort`.
 */
export class AttachmentService {
  private readonly deps: AttachmentServiceDeps;

  constructor(deps: AttachmentServiceDeps) {
    this.deps = deps;
  }

  /** Rows are written and answered at once; the copies go on in the background. */
  async add(
    draftId: string,
    files: readonly { id: string; name: string; size: number; sourcePath: string }[],
  ): Promise<readonly AttachmentInfo[]> {
    const added = await addAttachments(this.deps.attach, draftId, files);
    const ids = files.map((f) => f.id);
    void added.settled.then(() => this.deps.onCaptured(ids));
    return added.attachments.map(toAttachmentInfo);
  }

  /** The same, for parts of received messages: downloaded, then captured (ADR 0045). */
  async addForwarded(
    draftId: string,
    files: readonly { id: string; messageKey: number; partId: string }[],
  ): Promise<readonly AttachmentInfo[]> {
    const added = await addForwardedAttachments(
      this.deps.attach,
      draftId,
      files.map((f) => ({ id: f.id, origin: { messageKey: f.messageKey, partId: f.partId } })),
    );
    return added.attachments.map(toAttachmentInfo);
  }

  check(draftId: string): Promise<string[]> {
    return checkAttachmentSources(this.deps.attach, draftId);
  }

  async recapture(draftId: string, id: string): Promise<AttachmentInfo | null> {
    const added = await recaptureAttachment(this.deps.attach, draftId, id);
    const row = added?.attachments[0];
    return row ? toAttachmentInfo(row) : null;
  }

  probeLimit(accountId: string): Promise<number | null> {
    return probeMessageLimit(this.deps.probe, accountId);
  }

  /**
   * Start-up (ADR 0041, rule 19): stray files go first, then copies that were running when the
   * app stopped start again. Returns when the sweep is done; the copies go on by themselves.
   */
  async start(): Promise<void> {
    await sweepAttachmentFiles(this.deps.attach);
    await resumeCaptures(this.deps.attach);
  }
}
