import type { BootStage } from "../backend/bootStage.ts";

/**
 * When the window is shown (ADR 0103, rule 2). The window is created hidden and normally opens with the
 * mail in it, the moment the page says its first screen is ready (ADR 0070, rule 3). These are the
 * numbers for a start that does not get there by itself.
 */

/** The loading screen comes no later than this after the window was created, as in ADR 0070. */
export const REVEAL_DEADLINE_MS = 800;
/**
 * How long a page whose script has started is given to finish its first screen. Measured from the
 * script's start to the first screen: 135–150 ms built on the real mailbox with AI on, 55–150 ms in
 * dev; 350 leaves more than twice that.
 */
export const SCRIPT_GRACE_MS = 350;

export interface RevealState {
  /** When the window was created, on main's clock. */
  readonly createdAtMs: number;
  /** When the page said its script started, on the same clock; null until it has. */
  readonly scriptStartedAtMs: number | null;
  readonly stage: BootStage;
}

/**
 * When the loading screen is shown if the page has not said its first screen is ready by then. A
 * page that has started is not pre-empted by the loader while it is about to finish; an update of
 * the database is a long wait whatever the page does, and is shown at the deadline.
 */
export function revealDeadline(state: RevealState): number {
  const deadline = state.createdAtMs + REVEAL_DEADLINE_MS;
  if (state.stage === "updating" || state.scriptStartedAtMs === null) return deadline;
  return Math.max(deadline, state.scriptStartedAtMs + SCRIPT_GRACE_MS);
}
