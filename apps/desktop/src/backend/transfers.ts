export type TransferStop = "stop" | "quit";

/**
 * The uploads in flight, each with the controller that can cut it short (ADR 0041, rules 14 and
 * 15). `stop` is the user's Stop; `abortAll("quit")` is shutdown, which must not wait for an
 * upload and must not be mistaken for the user's choice.
 */
export class TransferBook {
  private readonly active = new Map<string, AbortController>();

  start(operationId: string, controller: AbortController): void {
    this.active.set(operationId, controller);
  }

  end(operationId: string): void {
    this.active.delete(operationId);
  }

  /** False when no transfer of this operation is running. */
  stop(operationId: string): boolean {
    const controller = this.active.get(operationId);
    if (!controller) return false;
    controller.abort("stop" satisfies TransferStop);
    return true;
  }

  abortAll(reason: TransferStop): number {
    const all = [...this.active.values()];
    for (const controller of all) controller.abort(reason);
    return all.length;
  }

  get size(): number {
    return this.active.size;
  }
}
