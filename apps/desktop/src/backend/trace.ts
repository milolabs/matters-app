// Launch trace (dev builds only): tools/bench-launch.ts sets MATTERS_TRACE_FILE and every
// process of the app appends one `name epochMs` line per phase. Epoch milliseconds come from
// `performance.timeOrigin + performance.now()`, a clock all processes of a machine share, with
// sub-millisecond resolution. Main drops the variable in a packaged app and never hands it to the
// backend, so there the hook does nothing: no file is opened, nothing is written.
import { appendFileSync } from "node:fs";

/** Appends a phase to the trace file; does nothing unless the file is named. */
export function mark(name: string, epochMs = performance.timeOrigin + performance.now()): void {
  const file = process.env.MATTERS_TRACE_FILE;
  if (!file) return;
  try {
    appendFileSync(file, `${name} ${epochMs.toFixed(3)}\n`);
  } catch {
    // a trace that cannot be written must never disturb the app
  }
}
