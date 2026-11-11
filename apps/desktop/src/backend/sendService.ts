import type { SendAction } from "@matters/contracts";
import type {
  Draft,
  DraftContent,
  ProcessDeps,
  SendLane,
  SendOperation,
  UndoResult,
} from "@matters/core";
import {
  deleteDraft,
  discardSend,
  holdExpiredOnStartup,
  processOutbox,
  reconcileUnknown,
  releaseSend,
  requestSend,
  resolveUnknown,
  saveDraft,
  undoSend,
} from "@matters/core";
import type { SendApi } from "./handler.ts";
import type { OutboxRunner } from "./outboxRunner.ts";
import type { TransferBook } from "./transfers.ts";

/** How long an unknown send may stay unfound at the provider before it counts as failed. */
export const RECONCILE_GRACE_MS = 2 * 60_000;
/** Finished sends are kept this long for the record. */
const KEEP_FINISHED_MS = 7 * 24 * 3_600_000;

export interface SendServiceDeps {
  readonly process: ProcessDeps;
  /** The outbox changed in a way the UI has to hear about. */
  readonly onChanged: () => void;
  /** The uploads in flight, so Stop can reach one (ADR 0041, rule 14). */
  readonly transfers: TransferBook;
}

/** One runner for each lane (ADR 0041, rule 11): a reply never waits behind a large upload. */
export interface OutboxRunners {
  /** Also settles unknown sends of both lanes. */
  readonly small: OutboxRunner;
  readonly large: OutboxRunner;
}

/**
 * The send requests of the renderer, over the core use cases. Runs in the sync worker (it
 * writes and talks to servers); the router serves the same API through `RemoteSend`.
 */
export class SendService implements SendApi {
  private readonly deps: SendServiceDeps;
  private runners: OutboxRunners | null = null;

  constructor(deps: SendServiceDeps) {
    this.deps = deps;
  }

  attach(runners: OutboxRunners): void {
    this.runners = runners;
  }

  /** Something a waiting send needed changed: look at both lanes again. */
  wake(): void {
    this.runners?.small.wake();
    this.runners?.large.wake();
  }

  /** Start-up (ADR 0020, rule 5): hold sends whose window ended while the app was closed. */
  async recover(): Promise<{ held: number; interrupted: number }> {
    const { process } = this.deps;
    await process.outbox.pruneFinished(process.now() - KEEP_FINISHED_MS);
    return holdExpiredOnStartup(process);
  }

  /** What the runner calls. */
  process(lane: SendLane): Promise<readonly SendOperation[]> {
    return processOutbox(this.deps.process, { lane });
  }

  reconcile() {
    return reconcileUnknown(this.deps.process, { graceMs: RECONCILE_GRACE_MS });
  }

  async hasUnknown(): Promise<boolean> {
    return (await this.deps.process.outbox.listByState(["unknown"])).length > 0;
  }

  nextDueMs(lane: SendLane): Promise<number | null> {
    return this.deps.process.outbox.nextDueMs(lane);
  }

  async saveDraft(input: { id?: string; content: DraftContent }): Promise<Draft> {
    const draft = await saveDraft(this.deps.process, input);
    this.announce();
    return draft;
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    const removed = await deleteDraft(this.deps.process, draftId);
    this.announce();
    return removed;
  }

  async requestSend(draftId: string): Promise<SendOperation> {
    const op = await requestSend(this.deps.process, draftId);
    this.announce();
    this.wake();
    return op;
  }

  async undoSend(operationId: string): Promise<UndoResult> {
    const result = await undoSend(this.deps.process, operationId);
    this.announce();
    this.wake();
    return result;
  }

  async sendAction(operationId: string, action: SendAction): Promise<boolean> {
    const { process } = this.deps;
    let done: boolean;
    switch (action) {
      case "sendNow":
      case "retry":
        done = await releaseSend(process, operationId);
        break;
      case "discard":
        done = (await discardSend(process, operationId)) === "cancelled";
        break;
      case "sendAgain":
        done = await resolveUnknown(process, operationId, "sendAgain");
        break;
      case "markSent":
        done = await resolveUnknown(process, operationId, "markSent");
        break;
      case "stop":
        // The transfer ends itself: the controller's reason tells `handOff` it was the user.
        done = this.deps.transfers.stop(operationId);
        break;
    }
    this.announce();
    this.wake();
    return done;
  }

  private announce(): void {
    this.deps.onChanged();
  }
}
