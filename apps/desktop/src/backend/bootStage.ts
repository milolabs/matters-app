/**
 * What the backend is doing while the window waits for it (ADR 0103, rule 1). The backend tells main,
 * main tells the window's preload, and the loading screen says it. A stage is a name and two
 * integers, never anything read from the mail (ADR 0005: main sees no data).
 *
 * - `starting`: the process runs, the database is not looked at yet.
 * - `opening`: the database is being opened (read at once, or the worker is opening it).
 * - `updating`: the worker is updating the schema of a database that holds mail: step of total.
 * - `ready`: the backend answers reads; the rest is the page's.
 */
export type BootStage = "starting" | "opening" | "updating" | "ready";

export interface BootReport {
  readonly stage: BootStage;
  /** The step of an update, from 1; 0 when there is none or it is not known. */
  readonly step: number;
  /** How many steps the update has; 0 when there is none or it is not known. */
  readonly total: number;
}

/** The type of the backend's message to main that carries a report. */
export const BOOT_STAGE_MESSAGE = "bootStage";

const STAGES: readonly BootStage[] = ["starting", "opening", "updating", "ready"];

export const BOOT_START: BootReport = { stage: "starting", step: 0, total: 0 };

/** What happened at startup, as the router sees it. */
export type BootEvent =
  | { readonly kind: "open" }
  | { readonly kind: "migrating"; readonly step: number; readonly total: number }
  | { readonly kind: "ready" };

/**
 * The next report after `event`. Stages only go forward: a migration step that arrives after the
 * backend said it was ready changes nothing, and `ready` is final.
 */
export function nextBootReport(current: BootReport, event: BootEvent): BootReport {
  if (current.stage === "ready") return current;
  switch (event.kind) {
    case "open":
      return current.stage === "starting" ? { stage: "opening", step: 0, total: 0 } : current;
    case "migrating": {
      const counted = isCount(event.step) && isCount(event.total) && event.step <= event.total;
      return counted
        ? { stage: "updating", step: event.step, total: event.total }
        : { stage: "updating", step: 0, total: 0 };
    }
    case "ready":
      return { stage: "ready", step: 0, total: 0 };
  }
}

/** A report as it crossed a process boundary: a known stage and two small integers, or null. */
export function readBootReport(data: unknown): BootReport | null {
  if (typeof data !== "object" || data === null) return null;
  const { stage, step, total } = data as { stage?: unknown; step?: unknown; total?: unknown };
  if (typeof stage !== "string" || !STAGES.includes(stage as BootStage)) return null;
  const s = isCount(step) ? step : 0;
  const t = isCount(total) ? total : 0;
  return { stage: stage as BootStage, step: s <= t ? s : 0, total: s <= t ? t : 0 };
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 100_000;
}
