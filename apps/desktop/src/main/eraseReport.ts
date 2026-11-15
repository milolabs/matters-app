// What the erase window shows once (ADR 0138, rule 11): sizes and kinds, never a file's contents.
// Paths are shown only for what was left, so the person can find it.
import type { EraseReport } from "@matters/contracts";
import { type EraseResult, eraseSummary, HOLDING_GROUPS, type HoldingGroup } from "@matters/core";

export function eraseReport(result: EraseResult, markerLeft = false): EraseReport {
  const { bytes, left } = eraseSummary(result);
  const byGroup = new Map<HoldingGroup, number>();
  let keys = 0;
  for (const o of result.outcomes) {
    if (o.outcome.kind !== "gone") continue;
    if (o.holding.place.kind === "keychain") keys++;
    byGroup.set(o.holding.group, (byGroup.get(o.holding.group) ?? 0) + o.outcome.bytes);
  }
  return {
    ok: left.length === 0,
    bytes,
    ms: result.endedAtMs - result.startedAtMs,
    earlierCopy: result.earlierCopy,
    groups: HOLDING_GROUPS.filter((g) => byGroup.has(g)).map((g) => ({
      group: g,
      bytes: byGroup.get(g) ?? 0,
    })),
    left: left.map(({ holding, outcome }) => ({
      group: holding.group,
      kind: holding.place.kind === "keychain" ? "key" : "path",
      reason: outcome.kind === "left" ? outcome.reason : "failed",
      bytes: outcome.kind === "left" ? outcome.bytes : 0,
      where: outcome.kind === "left" ? outcome.where : null,
    })),
    keys,
    markerLeft,
  };
}
