// Main's part of the erase review (ADR 0138, rule 9): what the folders and files outside the
// database's pages hold, by the review's groups, and the earlier copy. Measured when the review
// opens; nothing about paths leaves main.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_KEY_PREFIX, VAULT_FILE } from "@matters/adapter-secrets";
import type { MainEraseOverview } from "@matters/contracts";
import { HOLDING_GROUPS, type HoldingGroup } from "@matters/core";
import { type EraseTargets, nodeEraseFs, pathsOf } from "./erase.ts";
import { ALL_HOLDINGS } from "./holdings.ts";
import { MARKER } from "./identityMigration.ts";
import { sizeOf } from "./storageUsage.ts";

export async function eraseOverview(o: {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly earlierDir: string | null;
}): Promise<MainEraseOverview> {
  const groups = Object.fromEntries(HOLDING_GROUPS.map((g) => [g, 0])) as Record<
    HoldingGroup,
    number
  >;
  const targets: EraseTargets = {
    dataDir: o.dataDir,
    databasePath: o.databasePath,
    // Temp folders are not measured: they live for one turn of an agent.
    tempDir: "",
    earlierDir: null,
    keychain: { current: null, earlier: null },
  };
  for (const h of ALL_HOLDINGS) {
    const p = h.place;
    // The database file's pages are measured by the backend, by table.
    if (p.kind === "temp" || (p.kind === "database" && p.suffix === "")) continue;
    for (const path of pathsOf(h, targets, nodeEraseFs)) groups[h.group] += await sizeOf(path);
  }
  let earlier: MainEraseOverview["earlier"] = null;
  if (o.earlierDir !== null && nodeEraseFs.entry(o.earlierDir)?.kind === "dir") {
    let sinceMs: number | null = null;
    try {
      const marker = JSON.parse(await readFile(join(o.dataDir, MARKER), "utf8")) as {
        at?: unknown;
      };
      const at = typeof marker.at === "string" ? Date.parse(marker.at) : Number.NaN;
      sinceMs = Number.isFinite(at) ? at : null;
    } catch {
      // No marker: the date is not known.
    }
    earlier = { bytes: await sizeOf(o.earlierDir), sinceMs };
  }
  return { groups, earlier, agentKeys: await agentKeysIn(join(o.dataDir, VAULT_FILE)) };
}

/**
 * How many API keys of runtimes the vault holds (ADR 0141, rule 4), from the names of its entries:
 * nothing is decrypted. A vault that cannot be read counts none; the erase removes it whole.
 */
async function agentKeysIn(path: string): Promise<number> {
  try {
    const vault = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown };
    if (typeof vault.entries !== "object" || vault.entries === null) return 0;
    return Object.keys(vault.entries).filter((id) => id.startsWith(AGENT_KEY_PREFIX)).length;
  } catch {
    return 0;
  }
}
