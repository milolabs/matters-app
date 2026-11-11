import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_DELAYS_MS,
  approve,
  cancelSend,
  checkApproval,
  failSend,
  finishSend,
  holdInterrupted,
  holdSend,
  interruptSend,
  inUndoWindow,
  laneOf,
  markDataEnded,
  markSent,
  newSendOperation,
  reconcileSend,
  requeueSend,
  reviseDraft,
  type SendOperation,
  scheduleRetry,
  sendAgain,
  startSend,
  stopSend,
  voidSend,
} from "../src/index.ts";
import { content, draft, me, sha256 } from "./support.ts";

const NOW = 1_793_610_000_000;

describe("Approval", () => {
  it("is valid while nothing changed", () => {
    const d = draft();
    expect(checkApproval(approve(d, 100, NOW), d, 100)).toBe("valid");
  });

  it("is voided by an edit", () => {
    const d = draft();
    const approval = approve(d, 100, NOW);
    const edited = reviseDraft(
      d,
      content({ bodyMarkdown: "Cena: 36 000 PLN. Pozdrawiam" }),
      sha256,
      NOW + 1,
    );
    expect(edited.version).toBe(2);
    expect(checkApproval(approval, edited, 100)).toBe("draftChanged");
  });

  it("is voided by a recipient change, a bcc included", () => {
    const d = draft();
    const approval = approve(d, 100, NOW);
    expect(
      checkApproval(approval, reviseDraft(d, content({ bcc: [me] }), sha256, NOW + 1), 100),
    ).toBe("draftChanged");
  });

  it("is voided by a new message in the thread", () => {
    const d = draft();
    expect(checkApproval(approve(d, 100, NOW), d, 101)).toBe("contextChanged");
    expect(checkApproval(approve(d, null, NOW), d, 100)).toBe("contextChanged");
  });

  it("belongs to one draft", () => {
    expect(checkApproval(approve(draft({}, "a"), 1, NOW), draft({}, "b"), 1)).toBe(
      "differentDraft",
    );
  });

  it("is voided when only the fingerprint differs, whatever the version says", () => {
    const d = draft();
    const forged = { ...d, fingerprint: "0".repeat(64) };
    expect(checkApproval(approve(d, 1, NOW), forged, 1)).toBe("draftChanged");
  });

  it("copes with a message that answers nothing", () => {
    const d = draft({ threadId: undefined });
    expect(checkApproval(approve(d, null, NOW), d, null)).toBe("valid");
  });
});

function pending(notBeforeMs = NOW + 10_000): SendOperation {
  return newSendOperation({
    id: "op1",
    accountId: "acc1",
    approval: approve(draft(), 1, NOW),
    nowMs: NOW,
    notBeforeMs,
  });
}

describe("SendOperation", () => {
  it("a double click does not send twice", () => {
    const first = startSend(pending(), NOW);
    expect(first).toMatchObject({ state: { kind: "running" }, attempts: 1 });
    expect(startSend(first as SendOperation, NOW)).toBeNull();
  });

  it("an unknown outcome blocks a blind retry and is settled by a search", () => {
    const running = startSend(pending(), NOW) as SendOperation;
    const unknown = finishSend(running, { kind: "unknown" }, NOW + 5);
    expect(unknown.state.kind).toBe("unknown");
    expect(unknown.unknownSinceMs).toBe(NOW + 5);
    expect(startSend(unknown, NOW + 6)).toBeNull();
    expect(requeueSend(unknown, NOW + 6)).toBe(unknown);
    expect(reconcileSend(unknown, "gm:123", NOW + 7).state).toEqual({
      kind: "succeeded",
      providerMessageId: "gm:123",
    });
  });

  it("an unknown send that was not found becomes failed, and may be retried", () => {
    const unknown = finishSend(
      startSend(pending(), NOW) as SendOperation,
      { kind: "unknown" },
      NOW,
    );
    const failed = reconcileSend(unknown, null, NOW + 1);
    expect(failed.state.kind).toBe("failed");
    expect(startSend(failed, NOW + 2)).toMatchObject({ state: { kind: "running" }, attempts: 2 });
  });

  it("reconcile does nothing outside unknown", () => {
    const p = pending();
    const running = startSend(p, NOW) as SendOperation;
    const failed = finishSend(running, { kind: "failed", reason: "550" }, NOW);
    const done = finishSend(running, { kind: "succeeded", providerMessageId: "x" }, NOW);
    for (const op of [p, running, failed, done]) {
      expect(reconcileSend(op, "gm:1", NOW)).toBe(op);
      expect(reconcileSend(op, null, NOW)).toBe(op);
    }
  });

  it("failed can be retried: start works again and counts attempts", () => {
    const failed = finishSend(
      startSend(pending(), NOW) as SendOperation,
      { kind: "failed", reason: "550 no" },
      NOW,
    );
    const again = startSend(failed, NOW + 1) as SendOperation;
    expect(again).toMatchObject({ state: { kind: "running" }, attempts: 2 });
    const requeued = requeueSend(failed, NOW + 1);
    expect(requeued).toMatchObject({ state: { kind: "pending" }, notBeforeMs: NOW + 1 });
  });

  it("finish only applies to a running operation", () => {
    const p = pending();
    expect(finishSend(p, { kind: "succeeded", providerMessageId: "x" }, NOW)).toBe(p);
  });

  it("undo cancels a waiting send, and only one that has not started", () => {
    const p = pending();
    expect(inUndoWindow(p, NOW + 9_999)).toBe(true);
    expect(inUndoWindow(p, NOW + 10_000)).toBe(false);
    expect(cancelSend(p, NOW + 2).state.kind).toBe("cancelled");
    const running = startSend(p, NOW) as SendOperation;
    expect(cancelSend(running, NOW)).toBe(running);
    const done = finishSend(running, { kind: "succeeded", providerMessageId: "x" }, NOW);
    expect(cancelSend(done, NOW)).toBe(done);
    const unknown = finishSend(running, { kind: "unknown" }, NOW);
    expect(cancelSend(unknown, NOW)).toBe(unknown);
  });

  it("a cancelled send cannot start", () => {
    expect(startSend(cancelSend(pending(), NOW), NOW)).toBeNull();
  });

  it("holds a window that expired, not one that is still open", () => {
    const p = pending();
    expect(holdSend(p, NOW + 9_999)).toBe(p);
    const held = holdSend(p, NOW + 10_000);
    expect(held.state.kind).toBe("held");
    expect(startSend(held, NOW + 10_001)).toBeNull();
    expect(requeueSend(held, NOW + 20_000)).toMatchObject({
      state: { kind: "pending" },
      notBeforeMs: NOW + 20_000,
    });
    expect(cancelSend(held, NOW).state.kind).toBe("cancelled");
  });

  it("an interrupted hand-off becomes unknown, never pending, once its data had ended", () => {
    // ADR 0041, rule 13: before the mark the message cannot have been delivered, so interruptSend
    // leaves it to holdInterrupted; the old rule (always unknown) no longer holds.
    const running = startSend(pending(), NOW) as SendOperation;
    expect(interruptSend(running, NOW + 3)).toBe(running);
    const ended = markDataEnded(running);
    expect(interruptSend(ended, NOW + 3).state.kind).toBe("unknown");
    const p = pending();
    expect(interruptSend(p, NOW)).toBe(p);
  });

  it("a voided send cannot start or be revived", () => {
    const voided = voidSend(pending(), "edited", NOW);
    expect(voided.state).toEqual({ kind: "voided", reason: "edited" });
    expect(startSend(voided, NOW)).toBeNull();
    expect(requeueSend(voided, NOW)).toBe(voided);
    expect(voidSend(voided, "again", NOW)).toBe(voided);
  });

  it("the user settles an unknown send: mark as sent, or send the same message again", () => {
    const unknown = finishSend(
      startSend({ ...pending(), messageId: "<m@x>" }, NOW) as SendOperation,
      { kind: "unknown" },
      NOW,
    );
    expect(markSent(unknown, NOW + 1).state).toEqual({
      kind: "succeeded",
      providerMessageId: "<m@x>",
    });
    const again = sendAgain(unknown, NOW + 1);
    expect(again).toMatchObject({
      state: { kind: "pending" },
      notBeforeMs: NOW + 1,
      unknownSinceMs: null,
    });
    expect(again.messageId).toBe("<m@x>");
    const p = pending();
    expect(markSent(p, NOW)).toBe(p);
    expect(sendAgain(p, NOW)).toBe(p);
  });
});

const running = (over: Partial<SendOperation> = {}): SendOperation =>
  ({ ...(startSend(pending(), NOW) as SendOperation), ...over }) as SendOperation;

describe("sending a large message (ADR 0041)", () => {
  it("the lane is fixed by the estimate made when Send was pressed", () => {
    const op = (encodedBytes: number) =>
      newSendOperation({
        id: "o",
        accountId: "a",
        approval: approve(draft(), 1, NOW),
        nowMs: NOW,
        notBeforeMs: NOW,
        encodedBytes,
      });
    expect(laneOf(op(0))).toBe("small");
    expect(laneOf(op(1_048_575))).toBe("small");
    expect(laneOf(op(1_048_576))).toBe("large");
    expect(pending()).toMatchObject({
      encodedBytes: 0,
      dataEnded: false,
      autoRetries: 0,
      mimeBytes: null,
    });
  });

  it("marks the end of the data only on a running operation", () => {
    const op = running();
    expect(markDataEnded(op).dataEnded).toBe(true);
    const p = pending();
    expect(markDataEnded(p)).toBe(p);
    // starting again clears it
    const failed = finishSend(markDataEnded(op), { kind: "failed", reason: "550" }, NOW);
    expect(startSend(failed, NOW + 1)?.dataEnded).toBe(false);
  });

  it("a connection lost before the end retries by itself after 5 s, 30 s and 2 min, then fails", () => {
    expect(AUTO_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000]);
    let op = running();
    let now = NOW;
    for (const [i, delay] of [5_000, 30_000, 120_000].entries()) {
      now += 1000;
      op = finishSend(op, { kind: "interrupted", reason: "ECONNRESET" }, now);
      expect(op.state.kind).toBe("pending");
      expect(op.notBeforeMs).toBe(now + delay);
      expect(op.autoRetries).toBe(i + 1);
      expect(op.dataEnded).toBe(false);
      now = op.notBeforeMs;
      op = startSend(op, now) as SendOperation;
      expect(op.attempts).toBe(i + 2);
      expect(op.autoRetries).toBe(i + 1);
    }
    const last = finishSend(op, { kind: "interrupted", reason: "ECONNRESET" }, now + 1);
    expect(last.state).toEqual({
      kind: "failed",
      reason: "The connection kept dropping: ECONNRESET",
    });
    // the user's Retry starts the count again
    const again = requeueSend(last, now + 2);
    expect(again).toMatchObject({ state: { kind: "pending" }, autoRetries: 0, dataEnded: false });
  });

  it("'Retry now' skips the wait of a connection lost before the end; the undo window stays", () => {
    const waiting = finishSend(running(), { kind: "interrupted", reason: "reset" }, NOW + 1);
    expect(waiting).toMatchObject({ state: { kind: "pending" }, autoRetries: 1 });
    expect(requeueSend(waiting, NOW + 2)).toMatchObject({
      state: { kind: "pending" },
      notBeforeMs: NOW + 2,
      autoRetries: 0,
    });
    // an ordinary send in its undo window is not released early
    const fresh = pending();
    expect(requeueSend(fresh, NOW + 1)).toBe(fresh);
  });

  it("past the mark a lost connection is unknown, never a retry", () => {
    const ended = markDataEnded(running());
    expect(scheduleRetry(ended, NOW)).toBe(ended);
    const lost = finishSend(ended, { kind: "interrupted", reason: "reset" }, NOW + 5);
    expect(lost.state.kind).toBe("unknown");
    expect(lost.unknownSinceMs).toBe(NOW + 5);
  });

  it("Stop cancels before the end of the data and is too late after it", () => {
    const op = running();
    expect(stopSend(op, NOW + 1).state.kind).toBe("cancelled");
    expect(finishSend(op, { kind: "aborted", why: "stop" }, NOW + 1).state.kind).toBe("cancelled");
    const ended = markDataEnded(op);
    expect(stopSend(ended, NOW + 1)).toBe(ended);
    expect(finishSend(ended, { kind: "aborted", why: "stop" }, NOW + 1).state.kind).toBe("unknown");
    const p = pending();
    expect(stopSend(p, NOW)).toBe(p);
  });

  it("quitting during an upload holds it; with the mark it is left to finish", () => {
    const op = running();
    expect(holdInterrupted(op, NOW + 1).state.kind).toBe("held");
    expect(finishSend(op, { kind: "aborted", why: "quit" }, NOW + 1).state.kind).toBe("held");
    const ended = markDataEnded(op);
    expect(holdInterrupted(ended, NOW + 1)).toBe(ended);
    // and "Send now" on the held one sends the same message again
    expect(requeueSend(holdInterrupted(op, NOW + 1), NOW + 2).state.kind).toBe("pending");
  });

  it("'send again' on an unknown one clears the mark and the retries", () => {
    const unknown = finishSend(
      { ...markDataEnded(running({ messageId: "<m@x>" })), autoRetries: 2 },
      { kind: "unknown" },
      NOW,
    );
    expect(sendAgain(unknown, NOW + 1)).toMatchObject({ dataEnded: false, autoRetries: 0 });
  });

  it("a failure can say that only the draft can help", () => {
    const op = finishSend(
      running(),
      { kind: "failed", reason: "552 too large", action: "openDraft" },
      NOW,
    );
    expect(op.state).toEqual({ kind: "failed", reason: "552 too large", action: "openDraft" });
    expect(requeueSend(op, NOW + 1).state).toEqual({ kind: "pending" });
  });

  it("a waiting send fails when a file it needs fails; a running one is not touched", () => {
    const p = pending();
    expect(failSend(p, "a.pdf: Can't read this file", NOW + 1, "openDraft").state).toEqual({
      kind: "failed",
      reason: "a.pdf: Can't read this file",
      action: "openDraft",
    });
    const held = holdSend(p, NOW + 10_000);
    expect(failSend(held, "x", NOW + 10_001).state).toEqual({ kind: "failed", reason: "x" });
    const r = running();
    expect(failSend(r, "x", NOW)).toBe(r);
  });
});
