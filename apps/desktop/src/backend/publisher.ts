import type { ChangesEvent } from "@matters/contracts";
import type { MessageStorePort } from "@matters/core";

/**
 * Turns "the store changed" into `changes` events: reads what changed since the last event on
 * the reader connection (committed data only) and sends it. Bursts are merged: the first touch
 * goes out at once, later ones at most every `delayMs`, so a sync that commits batch after
 * batch cannot flood the renderer.
 */
export class ChangePublisher {
  private readonly read: Pick<MessageStorePort, "changesSince">;
  private readonly send: (event: ChangesEvent) => void;
  private readonly delayMs: number;
  private lastSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    read: Pick<MessageStorePort, "changesSince">,
    send: (event: ChangesEvent) => void,
    delayMs = 100,
  ) {
    this.read = read;
    this.send = send;
    this.delayMs = delayMs;
  }

  /** Starts counting from the store's current sequence; older changes were never announced. */
  async init(): Promise<void> {
    this.lastSeq = (await this.read.changesSince(Number.MAX_SAFE_INTEGER)).changeSeq;
  }

  touch(): void {
    if (this.timer) {
      this.dirty = true;
      return;
    }
    this.flush();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) {
        this.dirty = false;
        this.touch();
      }
    }, this.delayMs);
  }

  /** Resolves when everything touched so far was sent. */
  idle(): Promise<void> {
    return this.chain;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(): void {
    this.chain = this.chain
      .then(async () => {
        const changes = await this.read.changesSince(this.lastSeq);
        if (changes.changeSeq === this.lastSeq) return;
        this.lastSeq = changes.changeSeq;
        this.send({
          type: "changes",
          changeSeq: changes.changeSeq,
          changedKeys: changes.changedKeys,
          removedKeys: changes.removedKeys,
        });
      })
      .catch(() => {
        // a failed read only delays the next event; the next touch tries again
      });
  }
}
