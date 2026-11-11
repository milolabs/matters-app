// What a send looks like in the tray: the dot, the line and the actions, from the operation alone
// (ADR 0041, rule 22). Pure, so each state's words and actions are tested without a page.
import type { SendOperation } from "@matters/core";
import { laneOf } from "@matters/core";
import { megabytes } from "./format.ts";
import { sentOf } from "./outbox.ts";

export type SendActionId =
  | "undo"
  | "stop"
  | "retryNow"
  | "discard"
  | "retry"
  | "openDraft"
  | "sendNow"
  | "sendAgain"
  | "markSent"
  | "dismiss";

/** The look of the dot; `plain` and `pulse` are the 6 px dot of messages under 1 MiB. */
export type DotKind =
  | "pulse"
  | "drain"
  | "breathe"
  | "ring"
  | "full"
  | "good"
  | "hollow"
  | "late"
  | "half"
  /** Cancelled: nothing to show. */
  | "none";

export interface SendView {
  /** True for a message under 1 MiB: it keeps the small dot and today's words. */
  readonly small: boolean;
  readonly dot: DotKind;
  /** The bold part of the line. */
  readonly line: string;
  /** Words after the line's bold part that the page changes by itself (bytes sent). */
  readonly live: string | null;
  /** The second line, under it. */
  readonly reason: string;
  readonly bad: boolean;
  readonly actions: readonly SendActionId[];
  /** What a screen reader hears when this changes: the state, never a number. */
  readonly announce: string;
}

export interface SendContext {
  /** Seconds left of the undo window (or of the wait before an automatic retry). */
  readonly secondsLeft: number;
  /** Names of the files of this send that are still being read. */
  readonly reading: readonly string[];
}

const waitingFor = (names: readonly string[]) =>
  names.length === 1 ? `Waiting for ${names[0]}` : `Waiting for ${names.length} files`;

function smallView(op: SendOperation, ctx: SendContext): SendView {
  const s = op.state;
  const bad = ["held", "failed", "unknown", "voided"].includes(s.kind);
  const line = {
    pending: "Sending…",
    running: "Sending…",
    succeeded: "Sent",
    held: "Not sent yet",
    failed: "Not sent",
    unknown: "Not sure it was sent",
    voided: "Not sent",
    cancelled: "Cancelled",
  }[s.kind];
  const reason = (() => {
    switch (s.kind) {
      case "held":
        return "The time to undo ended while Matters was closed. Nothing leaves without you.";
      case "failed":
        return s.reason;
      case "unknown":
        return "The connection broke before the server answered, so it may or may not have gone out.";
      case "voided":
        return s.reason;
      case "succeeded":
        return op.warning ?? "";
      default:
        return "";
    }
  })();
  const actions: SendActionId[] = [];
  if (s.kind === "pending" && ctx.secondsLeft > 0) actions.push("undo");
  if (s.kind === "held") actions.push("sendNow", "discard");
  if (s.kind === "failed") {
    actions.push(s.action === "openDraft" ? "openDraft" : "retry", "discard");
  }
  if (s.kind === "unknown") actions.push("sendAgain", "markSent");
  if (s.kind === "voided" || s.kind === "succeeded") actions.push("dismiss");
  return {
    small: true,
    dot: s.kind === "succeeded" ? "good" : bad ? "late" : s.kind === "cancelled" ? "none" : "pulse",
    line,
    live: null,
    reason,
    bad,
    actions,
    announce: line,
  };
}

/** The lines of a message of 1 MiB or more. */
function largeView(op: SendOperation, ctx: SendContext): SendView {
  const s = op.state;
  const view = (v: Pick<SendView, "dot" | "line" | "announce"> & Partial<SendView>): SendView => ({
    small: false,
    live: null,
    bad: false,
    reason: "",
    actions: [],
    ...v,
  });
  switch (s.kind) {
    case "pending": {
      if (op.autoRetries > 0) {
        const wait = ctx.secondsLeft > 0 ? ` in ${ctx.secondsLeft} s` : "";
        const line = `Connection lost · trying again${wait}`;
        // Discard here is an undo: the message has not gone.
        return view({
          dot: "hollow",
          line,
          bad: true,
          actions: ["retryNow", "discard"],
          announce: "Connection lost, trying again",
        });
      }
      if (ctx.secondsLeft > 0) {
        // The window counts down either way; the words say what the send is waiting for.
        const line = ctx.reading.length > 0 ? waitingFor(ctx.reading) : "Sending…";
        const announce = ctx.reading.length > 0 ? line : "Sending";
        return view({ dot: "drain", line, actions: ["undo"], announce });
      }
      if (ctx.reading.length > 0) {
        const line = waitingFor(ctx.reading);
        return view({ dot: "breathe", line, actions: ["undo"], announce: line });
      }
      return view({ dot: "breathe", line: "Preparing…", actions: ["undo"], announce: "Preparing" });
    }
    case "running": {
      if (op.dataEnded) {
        return view({
          dot: "full",
          line: "Waiting for the server…",
          announce: "Waiting for the server",
        });
      }
      if (op.mimeBytes === null) {
        return view({ dot: "breathe", line: "Preparing…", announce: "Preparing" });
      }
      return view({
        dot: "ring",
        line: "Sending…",
        // Rewritten by progress events; this is only where it starts.
        live: sentOf(0, op.mimeBytes),
        actions: ["stop"],
        announce: "Sending",
      });
    }
    case "succeeded":
      return view({
        dot: "good",
        line: "Sent",
        reason: op.warning ?? "",
        actions: ["dismiss"],
        announce: "Sent",
      });
    case "failed":
      return view({
        dot: "late",
        line: "Not sent",
        reason: s.reason,
        bad: true,
        actions: [s.action === "openDraft" ? "openDraft" : "retry", "discard"],
        announce: "Not sent",
      });
    case "unknown":
      return view({
        dot: "half",
        line: "Not sure it was sent",
        reason:
          "The connection broke before the server answered, so it may or may not have gone out.",
        bad: true,
        actions: ["sendAgain", "markSent"],
        announce: "Not sure it was sent",
      });
    case "held":
      return view({
        dot: "late",
        line: "Not sent yet",
        reason: `${megabytes(op.encodedBytes)} was not sent. Nothing leaves without you.`,
        bad: true,
        actions: ["sendNow", "discard"],
        announce: "Not sent yet",
      });
    case "voided":
      return view({
        dot: "late",
        line: "Not sent",
        reason: s.reason,
        bad: true,
        actions: ["dismiss"],
        announce: "Not sent",
      });
    case "cancelled":
      return view({ dot: "none", line: "Cancelled", announce: "Cancelled" });
  }
}

export function describeSend(op: SendOperation, ctx: SendContext): SendView {
  return laneOf(op) === "small" ? smallView(op, ctx) : largeView(op, ctx);
}
