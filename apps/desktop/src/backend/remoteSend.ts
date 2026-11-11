import type { SendAction } from "@matters/contracts";
import type { Draft, DraftContent, SendOperation, UndoResult } from "@matters/core";
import type { SendApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * The send requests as the router serves them: every one writes or talks to a server, so each
 * is a command to the sync worker (ADR 0019). Reads (drafts, the outbox list, the preview) never
 * come through here.
 */
export class RemoteSend implements SendApi {
  private readonly host: SyncHost;

  constructor(host: SyncHost) {
    this.host = host;
  }

  saveDraft(input: { id?: string; content: DraftContent }): Promise<Draft> {
    return this.host.command({
      name: "saveDraft",
      content: input.content,
      ...(input.id === undefined ? {} : { id: input.id }),
    });
  }

  deleteDraft(draftId: string): Promise<boolean> {
    return this.host.command({ name: "deleteDraft", draftId });
  }

  requestSend(draftId: string): Promise<SendOperation> {
    return this.host.command({ name: "requestSend", draftId });
  }

  undoSend(operationId: string): Promise<UndoResult> {
    return this.host.command({ name: "undoSend", operationId });
  }

  sendAction(operationId: string, action: SendAction): Promise<boolean> {
    return this.host.command({ name: "sendAction", operationId, action });
  }
}
