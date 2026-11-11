/**
 * What the reader asked of one message's `\Seen` flag, kept until the server has it (ADR 0039).
 * One per message: a newer request replaces the older one, so only the latest intent is pushed.
 */
export interface SeenIntent {
  /** Store key of the message. */
  readonly key: number;
  readonly accountId: string;
  /** The wanted state. */
  readonly seen: boolean;
  /** What the message was before the first request that is still unpushed: the server's state. */
  readonly previousSeen: boolean;
  /** Failed pushes so far; drives the backoff. */
  readonly attempts: number;
  readonly nextAttemptMs: number;
  readonly createdAtMs: number;
  /** Grows with every replacement, so a push can tell that a newer request arrived meanwhile. */
  readonly rev: number;
}

/** A request to record; `previousSeen` is kept from the existing intent of the same message. */
export interface NewSeenIntent {
  readonly key: number;
  readonly accountId: string;
  readonly seen: boolean;
  readonly previousSeen: boolean;
  readonly nextAttemptMs: number;
  readonly createdAtMs: number;
}

/**
 * Quiet time before a request is pushed: toggling a message back and forth, or marking a long
 * thread, then costs one `STORE` and not one for each press.
 */
export const SEEN_PUSH_DELAY_MS = 1000;
/** The longest wait between two pushes of a request the server could not take yet. */
export const SEEN_BACKOFF_CAP_MS = 5 * 60_000;
