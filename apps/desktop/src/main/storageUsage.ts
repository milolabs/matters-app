import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MainStorageInfo, ProcessKind, ProcessUsageInfo } from "@matters/contracts";

export type { MainStorageInfo as MainStorage } from "@matters/contracts";

const FILES = new Set(["attachments", "spool", "received", "paste"]);
const CACHES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Shared Dictionary",
  "compile-cache",
]);

/** The kind of an entry directly under the user data folder. */
export function folderKind(name: string, databaseFile: string): keyof MainStorageInfo["folders"] {
  if (name === databaseFile || name.startsWith(`${databaseFile}-`)) return "databaseBytes";
  if (FILES.has(name)) return "filesBytes";
  if (CACHES.has(name)) return "cachesBytes";
  return "otherBytes";
}

/** Bytes under a path, links not followed; what cannot be read counts as nothing. */
export async function sizeOf(path: string): Promise<number> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) total += await sizeOf(join(path, entry.name));
  return total;
}

/** The folders under `userData`, by kind. `databasePath` may lie elsewhere (a test run). */
export async function folderUsage(
  userData: string,
  databasePath: string,
): Promise<MainStorageInfo["folders"]> {
  const databaseFile = basename(databasePath);
  const folders = { databaseBytes: 0, filesBytes: 0, cachesBytes: 0, otherBytes: 0 };
  let names: string[] = [];
  try {
    names = await readdir(userData);
  } catch {}
  for (const name of names)
    folders[folderKind(name, databaseFile)] += await sizeOf(join(userData, name));
  if (!names.includes(databaseFile)) {
    for (const suffix of ["", "-wal", "-shm"])
      folders.databaseBytes += await sizeOf(`${databasePath}${suffix}`);
  }
  return folders;
}

/** Electron's `ProcessMetric`, the fields this needs. */
export interface MetricLike {
  readonly pid: number;
  readonly type: string;
  readonly serviceName?: string;
  readonly memory: { readonly workingSetSize: number; readonly privateBytes?: number };
  readonly cpu: { readonly percentCPUUsage: number };
}

/** Each process of the app, named by what it does. Memory in KB from Electron, bytes here. */
export function processUsage(
  metrics: readonly MetricLike[],
  pids: { readonly backend?: number; readonly mail?: number; readonly settings?: number },
): ProcessUsageInfo[] {
  const kindOf = (m: MetricLike): ProcessKind => {
    if (m.pid === pids.backend) return "backend";
    if (m.pid === pids.mail) return "mail";
    if (m.pid === pids.settings) return "settings";
    if (m.type === "Browser") return "app";
    if (m.type === "GPU") return "gpu";
    if (m.type === "Utility" && m.serviceName === "network.mojom.NetworkService") return "network";
    return "other";
  };
  const byKind = new Map<ProcessKind, { memoryBytes: number; cpuPercent: number }>();
  for (const m of metrics) {
    const kind = kindOf(m);
    const entry = byKind.get(kind) ?? { memoryBytes: 0, cpuPercent: 0 };
    entry.memoryBytes += (m.memory.privateBytes ?? m.memory.workingSetSize) * 1024;
    entry.cpuPercent += m.cpu.percentCPUUsage;
    byKind.set(kind, entry);
  }
  return [...byKind]
    .map(([kind, v]) => ({ kind, ...v }))
    .sort((a, b) => b.memoryBytes - a.memoryBytes);
}
