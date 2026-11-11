// Imported first by each thread entry (backend router, sync worker): ES modules run their
// imports before their own body, so this is the only way to mark "the script started" before the
// heavy imports are evaluated. See trace.ts.
import { isMainThread, workerData } from "node:worker_threads";
import { mark } from "./trace.ts";

mark(
  isMainThread
    ? "backend-script-start"
    : (workerData as { dbPath?: unknown } | null)?.dbPath
      ? "worker-script-start"
      : "file-worker-script-start",
);
