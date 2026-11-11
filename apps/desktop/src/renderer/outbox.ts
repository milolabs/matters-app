import type { AttachmentInfo, SendAction } from "@matters/contracts";
import type { SendOperation } from "@matters/core";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type Backend, BackendError } from "./client.ts";
import { megabytes } from "./format.ts";
import { type ProgressSink, progress, sendKey } from "./progress.ts";

/** "14 of 34 MB": the words beside the ring while a message goes out. */
export function sentOf(sentBytes: number, totalBytes: number): string {
  const total = megabytes(totalBytes);
  const sent = megabytes(Math.min(sentBytes, totalBytes));
  // Both in the unit of the total, so the pair reads as one quantity.
  return `${sent.replace(" MB", "")} of ${total}`;
}

/** Sends in progress: undo windows, held, failed and unknown ones, kept current by pushes. */
export function createOutboxStore(
  backend: Backend,
  clock: () => number = Date.now,
  sink: ProgressSink = progress,
) {
  const [operations, setOperations] = createSignal<readonly SendOperation[]>([]);
  // The files of the drafts that have a send: a send that waits names the file it waits for.
  const [files, setFiles] = createSignal<ReadonlyMap<string, readonly AttachmentInfo[]>>(new Map());
  const asked = new Set<string>();
  const noteFiles = (draftId: string, list: readonly AttachmentInfo[]) =>
    setFiles((m) => new Map(m).set(draftId, list));
  // The countdown needs a clock signal; it ticks only while some send waits.
  const [nowMs, setNowMs] = createSignal(clock());
  const [problem, setProblem] = createSignal("");

  const pending = createMemo(() => operations().filter((o) => o.state.kind === "pending"));
  createEffect(() => {
    if (pending().length === 0) return;
    setNowMs(clock());
    const timer = setInterval(() => setNowMs(clock()), 250);
    onCleanup(() => clearInterval(timer));
  });

  backend.onEvent((event) => {
    if (event.type === "outbox") {
      setOperations(event.operations);
      // A send that survived a restart has no list yet: ask once, for the ones that wait.
      for (const op of event.operations) {
        if (op.state.kind !== "pending" || asked.has(op.draftId)) continue;
        asked.add(op.draftId);
        void backend
          .listAttachments(op.draftId)
          .then((list) => noteFiles(op.draftId, list))
          .catch(() => {});
      }
    } else if (event.type === "attachments") {
      noteFiles(event.draftId, event.attachments);
    } else if (event.type === "sendProgress") {
      // Straight to the dot and its words: no signal, so nothing in the tray renders again.
      sink.report(
        sendKey(event.operationId),
        event.totalBytes > 0 ? event.sentBytes / event.totalBytes : 0,
        sentOf(event.sentBytes, event.totalBytes),
      );
    }
  });

  async function refresh() {
    setOperations((await backend.listOutbox()).operations);
  }

  return {
    operations,
    /** Sends still in their undo window or waiting, oldest first. */
    pending,
    /** The send ⌘Z takes back: the one pressed last. */
    latestPending: () => pending().at(-1),
    /** Whole seconds left of the undo window; 0 when it is over. */
    secondsLeft: (op: SendOperation) => Math.max(0, Math.ceil((op.notBeforeMs - nowMs()) / 1000)),
    forDraft: (draftId: string) => operations().findLast((o) => o.draftId === draftId),
    /** Names of the draft's files that are still being read. */
    readingFiles: (draftId: string): readonly string[] =>
      (files().get(draftId) ?? []).filter((f) => f.state === "reading").map((f) => f.name),
    problem,
    refresh,
    async undo(operationId: string) {
      setProblem("");
      const result = await backend.undoSend(operationId).catch(() => "tooLate" as const);
      if (result === "tooLate") setProblem("Too late to undo: the message is already on its way.");
      return result;
    },
    async act(operationId: string, action: SendAction) {
      setProblem("");
      try {
        return await backend.sendAction(operationId, action);
      } catch (error) {
        setProblem(error instanceof BackendError ? error.message : "That did not work.");
        return false;
      }
    },
  };
}

export type OutboxStore = ReturnType<typeof createOutboxStore>;
