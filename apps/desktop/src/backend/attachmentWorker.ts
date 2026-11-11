// Entry of the attachment worker thread (ADR 0041, rule 4), spawned by the sync worker's
// `ThreadedFileWork` on first use. It captures files, hashes them and builds messages into the
// spool, so neither the router nor a sync batch ever waits for a hash. It also reads the text of
// received files for the agent (ADR 0087, rule 3). It never imports electron and knows no
// database: its whole world is two directories and the jobs it is sent.
import { parentPort, workerData } from "node:worker_threads";
import { createFileWork, type FileDirs } from "@matters/adapter-files";
import { extractFileText } from "@matters/adapter-filetext";
import { visibleText } from "@matters/adapter-mime";
import { NodemailerComposer } from "@matters/adapter-smtp";
import { isFileWorkError } from "@matters/core";
import type { FromFileWorker, ToFileWorker, WireFileError } from "./fileWorkProtocol.ts";

/** Progress is not data: a copy of a big file reports about this often, and no more. */
const PROGRESS_EVERY_MS = 100;

const port = parentPort;
if (!port) throw new Error("attachmentWorker must run as a worker thread");
const dirs = workerData as FileDirs;
const composer = new NodemailerComposer();
const work = createFileWork(dirs, (input, files) => composer.composeToStream(input, files));
const post = (message: FromFileWorker) => port.postMessage(message);
const running = new Map<number, AbortController>();

function wireError(error: unknown): WireFileError {
  if (isFileWorkError(error)) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.file === undefined ? {} : { file: error.file }),
    };
  }
  // A bug here must not take the thread down with a job half done: it is an unreadable file.
  return { kind: "unreadable", message: "The file could not be read" };
}

async function capture(id: number, attachmentId: string, sourcePath: string): Promise<void> {
  const controller = new AbortController();
  running.set(id, controller);
  let last = 0;
  try {
    const value = await work.capture(
      { attachmentId, sourcePath },
      (fraction) => {
        const now = Date.now();
        if (now - last < PROGRESS_EVERY_MS) return;
        last = now;
        post({ type: "progress", id, fraction });
      },
      controller.signal,
    );
    post({ type: "done", id, value });
  } catch (error) {
    post({ type: "failed", id, error: wireError(error) });
  } finally {
    running.delete(id);
  }
}

port.on("message", (message: ToFileWorker) => {
  switch (message.type) {
    case "capture":
      void capture(message.id, message.attachmentId, message.sourcePath);
      return;
    case "build":
      work.buildMessage(message.input, message.files, message.operationId).then(
        (value) => post({ type: "done", id: message.id, value }),
        (error) => post({ type: "failed", id: message.id, error: wireError(error) }),
      );
      return;
    case "text":
      // Never throws: a file that cannot be read is an answer, not a failed job.
      extractFileText(message.sourcePath, message.kind, { htmlToText: visibleText }).then(
        (value) => post({ type: "done", id: message.id, value }),
        (error) => post({ type: "failed", id: message.id, error: wireError(error) }),
      );
      return;
    case "abort":
      running.get(message.id)?.abort();
      return;
  }
});
