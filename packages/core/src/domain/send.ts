import { laneFor, type SendLane } from "./attachment.ts";
import type { Draft } from "./draft.ts";

/**
 * Consent bound to one exact draft (ADR 0020). `threadContext` is the newest key of a thread
 * message not sent by the user when Send was pressed; null when there is none.
 */
export interface Approval {
  readonly draftId: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly threadContext: number | null;
  readonly approvedAtMs: number;
}

export type ApprovalCheck = "valid" | "differentDraft" | "draftChanged" | "contextChanged";

export function approve(draft: Draft, threadContext: number | null, nowMs: number): Approval {
  return {
    draftId: draft.id,
    version: draft.version,
    fingerprint: draft.fingerprint,
    threadContext,
    approvedAtMs: nowMs,
  };
}

/** Run when Send is pressed and again right before the hand-off. */
export function checkApproval(
  approval: Approval,
  draft: Draft,
  currentThreadContext: number | null,
): ApprovalCheck {
  if (draft.id !== approval.draftId) return "differentDraft";
  if (draft.version !== approval.version || draft.fingerprint !== approval.fingerprint) {
    return "draftChanged";
  }
  if (currentThreadContext !== approval.threadContext) return "contextChanged";
  return "valid";
}

export function describeCheck(check: Exclude<ApprovalCheck, "valid">): string {
  switch (check) {
    case "differentDraft":
      return "The approval belonged to another draft.";
    case "draftChanged":
      return "The draft was edited after you pressed Send.";
    case "contextChanged":
      return "A new message arrived in the thread after you pressed Send.";
  }
}

export type SendState =
  /** In the undo window, or waiting for its turn. */
  | { readonly kind: "pending" }
  /** The window ended while the app was closed: waits for the user. */
  | { readonly kind: "held" }
  | { readonly kind: "running" }
  | { readonly kind: "succeeded"; readonly providerMessageId: string }
  /**
   * Definitely not delivered (rejected, refused before the message data, or lost before the data
   * ended). Retry is safe. `openDraft` says it would fail the same way: the draft has to change.
   */
  | { readonly kind: "failed"; readonly reason: string; readonly action?: "openDraft" }
  /** The connection was lost or timed out after the message data: reconcile before any retry. */
  | { readonly kind: "unknown" }
  | { readonly kind: "cancelled" }
  /** The approval no longer held at hand-off; nothing was sent. */
  | { readonly kind: "voided"; readonly reason: string };

export type SendStateKind = SendState["kind"];

export interface SendOperation {
  readonly id: string;
  readonly accountId: string;
  readonly draftId: string;
  /** What the user sees in the list of sends: subject and recipients at approval time. */
  readonly summary: string;
  readonly approval: Approval;
  readonly state: SendState;
  /** Times a hand-off was started. */
  readonly attempts: number;
  /** Earliest time the hand-off may start: the end of the undo window. */
  readonly notBeforeMs: number;
  /** Set when the message was built; the same on every attempt. */
  readonly messageId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** When the outcome became unknown; the grace period of a reconcile counts from here. */
  readonly unknownSinceMs: number | null;
  /** Something went wrong after a successful send (e.g. the Sent copy), for the user. */
  readonly warning: string | null;
  /**
   * What the message is estimated to weigh when encoded (`encodedMessageBytes`), fixed when Send
   * was pressed. It picks the lane (ADR 0041, rule 11) and does not change afterwards.
   */
  readonly encodedBytes: number;
  /**
   * The last byte of the message was handed to the connection (ADR 0041, rule 13): from here on a
   * lost connection means unknown. Written just before the stream ends, so a crash can be told
   * apart too.
   */
  readonly dataEnded: boolean;
  /** Connection losses retried by the app itself since the user last chose to send. */
  readonly autoRetries: number;
  /** Bytes of the built message, once it is built; the total a progress bar counts to. */
  readonly mimeBytes: number | null;
}

export const UNDO_WINDOW_MS = 10_000;

/** Waits before the app sends again by itself after a connection lost before the data ended. */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

export function laneOf(op: SendOperation): SendLane {
  return laneFor(op.encodedBytes);
}

export function newSendOperation(input: {
  id: string;
  approval: Approval;
  accountId: string;
  summary?: string;
  nowMs: number;
  notBeforeMs: number;
  encodedBytes?: number;
}): SendOperation {
  return {
    id: input.id,
    accountId: input.accountId,
    draftId: input.approval.draftId,
    summary: input.summary ?? "",
    approval: input.approval,
    state: { kind: "pending" },
    attempts: 0,
    notBeforeMs: input.notBeforeMs,
    messageId: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    unknownSinceMs: null,
    warning: null,
    encodedBytes: input.encodedBytes ?? 0,
    dataEnded: false,
    autoRetries: 0,
    mimeBytes: null,
  };
}

const to = (op: SendOperation, state: SendState, nowMs: number): SendOperation => ({
  ...op,
  state,
  updatedAtMs: nowMs,
});

/** States that can still change by themselves or by the user's choice. */
export function isActive(op: SendOperation): boolean {
  const k = op.state.kind;
  return k === "pending" || k === "held" || k === "running" || k === "failed" || k === "unknown";
}

export function canRetry(op: SendOperation): boolean {
  return op.state.kind === "failed";
}

/** The undo window is still open. */
export function inUndoWindow(op: SendOperation, nowMs: number): boolean {
  return op.state.kind === "pending" && nowMs < op.notBeforeMs;
}

/**
 * Starts a hand-off. Only from pending or failed: a running send blocks a double click,
 * an unknown outcome blocks a blind resend. Null when not allowed.
 */
export function startSend(op: SendOperation, nowMs: number): SendOperation | null {
  const k = op.state.kind;
  if (k !== "pending" && k !== "failed") return null;
  return { ...to(op, { kind: "running" }, nowMs), attempts: op.attempts + 1, dataEnded: false };
}

export type SendResult =
  | { readonly kind: "succeeded"; readonly providerMessageId: string }
  | { readonly kind: "failed"; readonly reason: string; readonly action?: "openDraft" }
  | { readonly kind: "unknown" }
  /** The connection was lost before the data ended: not delivered, and the app tries again. */
  | { readonly kind: "interrupted"; readonly reason: string }
  /** The transfer was cut short on purpose: `stop` by the user, `quit` by the app closing. */
  | { readonly kind: "aborted"; readonly why: "stop" | "quit" };

/** Records how a running hand-off ended. Anything else is left as it is. */
export function finishSend(op: SendOperation, result: SendResult, nowMs: number): SendOperation {
  if (op.state.kind !== "running") return op;
  switch (result.kind) {
    case "interrupted":
      // Past the mark nobody can tell: the same as a connection lost while waiting for the answer.
      return op.dataEnded
        ? finishSend(op, { kind: "unknown" }, nowMs)
        : scheduleRetry(op, nowMs, result.reason);
    case "aborted":
      if (op.dataEnded) return finishSend(op, { kind: "unknown" }, nowMs);
      return result.why === "stop" ? stopSend(op, nowMs) : holdInterrupted(op, nowMs);
    case "unknown":
      return { ...to(op, result, nowMs), unknownSinceMs: nowMs };
    default:
      return to(op, result, nowMs);
  }
}

/** The last byte is about to be handed over: from now on a lost connection is unknown. */
export function markDataEnded(op: SendOperation): SendOperation {
  return op.state.kind === "running" ? { ...op, dataEnded: true } : op;
}

/**
 * A connection lost before the data ended is retried by the app after 5 s, 30 s and 2 min, with
 * the same bytes; after the third the send fails (ADR 0041, rule 16). Only from running and
 * before the mark: past it a retry could send twice.
 */
export function scheduleRetry(op: SendOperation, nowMs: number, reason?: string): SendOperation {
  if (op.state.kind !== "running" || op.dataEnded) return op;
  const delay = AUTO_RETRY_DELAYS_MS[op.autoRetries];
  if (delay === undefined) {
    const lost = reason === undefined || reason === "" ? "" : `: ${reason}`;
    return to(op, { kind: "failed", reason: `The connection kept dropping${lost}` }, nowMs);
  }
  return {
    ...to(op, { kind: "pending" }, nowMs),
    notBeforeMs: nowMs + delay,
    autoRetries: op.autoRetries + 1,
  };
}

/** Stop pressed while the data was still going out: not delivered, so it is cancelled. */
export function stopSend(op: SendOperation, nowMs: number): SendOperation {
  return op.state.kind === "running" && !op.dataEnded ? to(op, { kind: "cancelled" }, nowMs) : op;
}

/** The app is quitting during an upload: not delivered, and waits for the user next time. */
export function holdInterrupted(op: SendOperation, nowMs: number): SendOperation {
  return op.state.kind === "running" && !op.dataEnded ? to(op, { kind: "held" }, nowMs) : op;
}

/**
 * Something that waited for its turn cannot go: a file it needs failed. Only from pending or
 * held. `openDraft` because pressing Retry would find the same file.
 */
export function failSend(
  op: SendOperation,
  reason: string,
  nowMs: number,
  action?: "openDraft",
): SendOperation {
  const k = op.state.kind;
  if (k !== "pending" && k !== "held") return op;
  return to(op, { kind: "failed", reason, ...(action ? { action } : {}) }, nowMs);
}

/**
 * Settles an unknown outcome by what the mailbox shows: the message was found (its provider id),
 * or, after the grace period the caller applies, it was not (retryable). Only from unknown.
 */
export function reconcileSend(
  op: SendOperation,
  found: string | null,
  nowMs: number,
): SendOperation {
  if (op.state.kind !== "unknown") return op;
  return found === null
    ? to(op, { kind: "failed", reason: "Not found in your mailbox after the timeout" }, nowMs)
    : to(op, { kind: "succeeded", providerMessageId: found }, nowMs);
}

/** The app started and the window had already ended: wait for the user. Only from pending. */
export function holdSend(op: SendOperation, nowMs: number): SendOperation {
  return op.state.kind === "pending" && op.notBeforeMs <= nowMs
    ? to(op, { kind: "held" }, nowMs)
    : op;
}

/**
 * The app stopped while a hand-off ran, after its data had ended: nobody knows whether it went
 * out. Before that mark it did not (see `holdInterrupted`). Only from running.
 */
export function interruptSend(op: SendOperation, nowMs: number): SendOperation {
  return op.dataEnded ? finishSend(op, { kind: "unknown" }, nowMs) : op;
}

/**
 * "Send now" on a held operation, or "Retry" on a failed one: goes again at once. "Retry now" on a
 * send that waits to try again after a lost connection (`autoRetries > 0`) skips the wait; a send
 * still in its undo window is not released, since that would take the undo away.
 */
export function requeueSend(op: SendOperation, nowMs: number): SendOperation {
  const k = op.state.kind;
  const waitingToRetry = k === "pending" && op.autoRetries > 0;
  if (k !== "held" && k !== "failed" && !waitingToRetry) return op;
  return {
    ...to(op, { kind: "pending" }, nowMs),
    notBeforeMs: nowMs,
    dataEnded: false,
    autoRetries: 0,
  };
}

/** Undo, or "Discard". Not possible once the hand-off started or finished, nor for unknown. */
export function cancelSend(op: SendOperation, nowMs: number): SendOperation {
  const k = op.state.kind;
  return k === "pending" || k === "held" || k === "failed"
    ? to(op, { kind: "cancelled" }, nowMs)
    : op;
}

export function voidSend(op: SendOperation, reason: string, nowMs: number): SendOperation {
  const k = op.state.kind;
  return k === "pending" || k === "held" || k === "running" || k === "failed"
    ? to(op, { kind: "voided", reason }, nowMs)
    : op;
}

/** The user says an unknown send did go out. Only from unknown. */
export function markSent(op: SendOperation, nowMs: number): SendOperation {
  if (op.state.kind !== "unknown") return op;
  return to(op, { kind: "succeeded", providerMessageId: op.messageId ?? "" }, nowMs);
}

/** The user chooses to send an unknown one again: the same bytes, right away. Only from unknown. */
export function sendAgain(op: SendOperation, nowMs: number): SendOperation {
  if (op.state.kind !== "unknown") return op;
  return {
    ...to(op, { kind: "pending" }, nowMs),
    notBeforeMs: nowMs,
    unknownSinceMs: null,
    dataEnded: false,
    autoRetries: 0,
  };
}

export function withWarning(op: SendOperation, warning: string): SendOperation {
  return { ...op, warning };
}

export function withMessageId(op: SendOperation, messageId: string): SendOperation {
  return { ...op, messageId };
}
