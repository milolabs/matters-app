import type { MoveSummary } from "@matters/contracts";
import type { MoveOperation } from "@matters/core";
import { decodeTarget } from "@matters/core";

/**
 * The actions in their undo window, one per action id (ADR 0044, rule 10). A row that was tried
 * already (it waits for a retry) no longer takes part: its window is over, whatever its time says.
 */
export function summariseMoves(
  rows: readonly MoveOperation[],
  folders: readonly { readonly id: string; readonly accountId: string; readonly name: string }[],
): MoveSummary[] {
  const byAction = new Map<string, MoveOperation[]>();
  for (const row of rows) {
    if (row.action === "purge") continue;
    const list = byAction.get(row.operationId);
    if (list) list.push(row);
    else byAction.set(row.operationId, [row]);
  }
  const out: MoveSummary[] = [];
  for (const [id, list] of byAction) {
    if (list.some((o) => o.attempts > 0)) continue;
    const first = list[0] as MoveOperation;
    const target = decodeTarget(first.target);
    const place =
      target !== null && "folderId" in target
        ? (folders.find((f) => f.id === target.folderId && f.accountId === first.accountId)?.name ??
          target.folderId)
        : target !== null && "role" in target && first.action === "move"
          ? target.role === "inbox"
            ? "Inbox"
            : "Archive"
          : undefined;
    out.push({
      id,
      action: first.action,
      ...(place === undefined ? {} : { place }),
      count: list.length,
      notBeforeMs: Math.max(...list.map((o) => o.nextAttemptMs)),
    });
  }
  return out.sort((a, b) => a.notBeforeMs - b.notBeforeMs);
}
