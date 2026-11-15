import type { Holding } from "@matters/core";

/** Each turn runs in a folder of its own in the system's temp directory, removed after it. */
export const AGENT_TEMP_PREFIX = "matters-agent-";

/** What a turn leaves when the app stops in the middle of it (ADR 0138, rule 2). */
export const CLAUDE_CODE_HOLDINGS: readonly Holding[] = [
  {
    id: "claudeCode.turns",
    group: "agents",
    place: { kind: "temp", prefix: AGENT_TEMP_PREFIX },
    step: "temp",
  },
];
