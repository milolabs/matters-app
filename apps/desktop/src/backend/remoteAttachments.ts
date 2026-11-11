import type { AttachmentInfo } from "@matters/contracts";
import { type Grant, type GrantBook, UnknownGrantError } from "./grantBook.ts";
import type { AttachmentsApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * The attachment requests as the router serves them. Here a grant becomes a path, once, and the
 * path goes to the sync worker in a command and nowhere else (ADR 0041, rule 3). What comes back
 * is `AttachmentInfo`, which has no path.
 */
export class RemoteAttachments implements AttachmentsApi {
  private readonly host: SyncHost;
  private readonly grants: GrantBook;
  /** Which grant stands behind a copy that is still running, to end it when the copy does. */
  private readonly behind = new Map<string, string>();

  constructor(host: SyncHost, grants: GrantBook) {
    this.host = host;
    this.grants = grants;
  }

  async add(
    draftId: string,
    files: readonly { id: string; grantId: string }[],
  ): Promise<readonly AttachmentInfo[]> {
    const taken = await this.grants.takeAll(files.map((f) => f.grantId));
    if (!taken) throw new UnknownGrantError();
    files.forEach((f, i) => {
      this.behind.set(f.id, (taken[i] as Grant).grantId);
    });
    try {
      return await this.host.command({
        name: "addAttachments",
        draftId,
        files: files.map((f, i) => {
          const grant = taken[i] as Grant;
          return { id: f.id, name: grant.name, size: grant.size, sourcePath: grant.path };
        }),
      });
    } catch (error) {
      // Nothing started copying: the grants are spent and the temporary files can go.
      this.captured(files.map((f) => f.id));
      throw error;
    }
  }

  addForwarded(
    draftId: string,
    files: readonly { id: string; messageKey: number; partId: string }[],
  ): Promise<readonly AttachmentInfo[]> {
    return this.host.command({ name: "addForwardedAttachments", draftId, files });
  }

  check(draftId: string): Promise<string[]> {
    return this.host.command({ name: "checkAttachmentSources", draftId }).then((ids) => [...ids]);
  }

  recapture(draftId: string, id: string): Promise<AttachmentInfo | null> {
    return this.host.command({ name: "recaptureAttachment", draftId, id });
  }

  /** The worker finished (or never started) the copies of these attachments. */
  captured(ids: readonly string[]): void {
    for (const id of ids) {
      const grantId = this.behind.get(id);
      if (grantId === undefined) continue;
      this.behind.delete(id);
      this.grants.end(grantId);
    }
  }
}
