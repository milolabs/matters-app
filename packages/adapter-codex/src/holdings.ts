import type { Holding } from "@matters/core";

/** Each turn, and each reading of the plan's limits, runs in a temp folder of its own. */
export const CODEX_TEMP_PREFIX = "matters-codex-";

/** What a turn leaves when the app stops in the middle of it (ADR 0138, rule 2). */
export const CODEX_HOLDINGS: readonly Holding[] = [
  {
    id: "codex.turns",
    group: "agents",
    place: { kind: "temp", prefix: CODEX_TEMP_PREFIX },
    step: "temp",
  },
];
