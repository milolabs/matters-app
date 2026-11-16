// What crosses between main and a page about newer versions (ADR 0137). The preload reads main's
// answers through these before a page sees them, as every bridge does; kept apart from release.ts
// so the preload does not carry the rules of core.
import type {
  ReleaseInfo,
  ReleaseInstall,
  ReleaseInstallStep,
  ReleaseNewer,
} from "@matters/contracts";

/** The links About may ask main to open, by name: main alone knows where each leads (rule 8). */
export type ReleaseOpen = "download" | "notes" | "site" | "source" | "issues";
export const RELEASE_OPENS: readonly ReleaseOpen[] = [
  "download",
  "notes",
  "site",
  "source",
  "issues",
];
export const isReleaseOpen = (v: unknown): v is ReleaseOpen =>
  typeof v === "string" && (RELEASE_OPENS as readonly string[]).includes(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** A version as main shows it: digits, letters, dots and hyphens, short. */
const isVersionText = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9A-Za-z.-]{1,64}$/.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const timeOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : isTime(v) ? v : undefined;

function readNewer(v: unknown): ReleaseNewer | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !isVersionText(v.version)) return undefined;
  const dateMs = timeOrNull(v.dateMs);
  if (dateMs === undefined) return undefined;
  if (typeof v.preRelease !== "boolean" || typeof v.download !== "boolean") return undefined;
  if (typeof v.notes !== "boolean") return undefined;
  return {
    version: v.version,
    dateMs,
    preRelease: v.preRelease,
    download: v.download,
    notes: v.notes,
  };
}

const STEPS: readonly ReleaseInstallStep[] = [
  "idle",
  "downloading",
  "checking",
  "installing",
  "restarting",
  "failed",
];
const textOrNull = (v: unknown, max: number): string | null | undefined =>
  v === null ? null : isText(v, max) ? v : undefined;

/** Where an install stands, rebuilt; undefined when it is not one (ADR 0140). */
function readInstall(v: unknown): ReleaseInstall | undefined {
  if (!isRecord(v) || typeof v.offered !== "boolean") return undefined;
  if (typeof v.step !== "string" || !(STEPS as readonly string[]).includes(v.step))
    return undefined;
  const cannot = textOrNull(v.cannot, 200);
  const line = textOrNull(v.line, 300);
  const note = textOrNull(v.note, 300);
  if (cannot === undefined || line === undefined || note === undefined) return undefined;
  return {
    offered: v.offered,
    cannot,
    step: v.step as ReleaseInstallStep,
    line,
    note,
  };
}

/** The state as a page may see it, rebuilt, or null when main's answer is not one. */
export function readReleaseInfo(v: unknown): ReleaseInfo | null {
  if (!isRecord(v) || !isText(v.version, 64)) return null;
  const stage = v.stage === null ? null : isText(v.stage, 20) ? v.stage : undefined;
  const newer = readNewer(v.newer);
  const checkedMs = timeOrNull(v.checkedMs);
  const failure = v.failure === null ? null : isText(v.failure, 200) ? v.failure : undefined;
  if (stage === undefined || newer === undefined || checkedMs === undefined) return null;
  if (failure === undefined) return null;
  const install = readInstall(v.install);
  if (install === undefined) return null;
  const { asks, enabled, checking, dot } = v;
  if (typeof asks !== "boolean" || typeof enabled !== "boolean") return null;
  if (typeof checking !== "boolean" || typeof dot !== "boolean") return null;
  return {
    version: v.version,
    stage,
    asks,
    enabled,
    checking,
    newer,
    dot: dot && newer !== null,
    checkedMs,
    failure,
    install,
  };
}
