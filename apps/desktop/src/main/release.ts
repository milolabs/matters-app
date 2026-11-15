// What main keeps of newer versions (ADR 0137, rule 14): `newer-version.json` in the data folder,
// with the switch, the last answer and its ETag, and the version About was last shown with. Pure,
// as appearance.ts is: main reads the file and makes the request, hands what it got here, and
// writes and tells every window what comes back. The rules themselves are in packages/core.
import type { ReleaseInfo, ReleaseNewer } from "@matters/contracts";
import {
  isNewerVersion,
  isPreRelease,
  isReleaseLink,
  type OfferedRelease,
  parseVersion,
  RELEASE_DOWNLOAD_PAGE,
  readReleaseFile,
  releaseActions,
  releaseDot,
  versionText,
} from "@matters/core";

/** The file's name in the data folder. */
export const RELEASE_STATE_FILE = "newer-version.json";

/** Why a check failed (rule 12); each is said in one phrase. */
export type ReleaseFailure =
  | "no-answer"
  | "status"
  | "redirect"
  | "too-big"
  | "not-json"
  | "no-version";

const FAILURES: readonly ReleaseFailure[] = [
  "no-answer",
  "status",
  "redirect",
  "too-big",
  "not-json",
  "no-version",
];

/** The phrase after "Could not check:" in Settings › About (rule 12). */
const FAILURE_PHRASES: Record<ReleaseFailure, string> = {
  "no-answer": "getmatters.app did not answer.",
  status: "getmatters.app answered with an error.",
  redirect: "getmatters.app sent the request elsewhere.",
  "too-big": "the answer was too large to be the release file.",
  "not-json": "the answer could not be read.",
  "no-version": "the answer names no version.",
};

/** What the file in the data folder holds. */
export interface StoredRelease {
  /** The switch (rule 6): on by default. */
  readonly enabled: boolean;
  /** The last answer that was read, and its ETag for `If-None-Match` (rule 4). */
  readonly answer: OfferedRelease | null;
  readonly etag: string | null;
  /** When a check last worked, and why the last one failed, if it did. */
  readonly checkedMs: number | null;
  readonly failure: ReleaseFailure | null;
  /** The newer version About was last shown with (rule 10). */
  readonly seen: string | null;
}

export const DEFAULT_RELEASE: StoredRelease = {
  enabled: true,
  answer: null,
  etag: null,
  checkedMs: null,
  failure: null,
  seen: null,
};

/** An ETag as it may be sent back: visible ASCII, short, never a line break. */
export const isEtag = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200 && /^[\x21-\x7e]+$/.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isFailure = (v: unknown): v is ReleaseFailure =>
  typeof v === "string" && (FAILURES as readonly string[]).includes(v);
const versionOrNull = (v: unknown): string | null => {
  const parsed = parseVersion(v);
  return parsed === null ? null : versionText(parsed);
};

/** A kept answer, checked again as if it had just come: the file under userData is not trusted either. */
function readAnswer(v: unknown): OfferedRelease | null {
  if (!isRecord(v)) return null;
  const version = versionOrNull(v.version);
  if (version === null) return null;
  return {
    version,
    stage: typeof v.stage === "string" && /^[a-z][a-z-]{0,19}$/.test(v.stage) ? v.stage : null,
    dateMs: isTime(v.dateMs) ? v.dateMs : null,
    download: isReleaseLink(v.download) ? v.download : null,
    notes: isReleaseLink(v.notes) ? v.notes : null,
  };
}

/**
 * The file's text as main reads it, or null when there is none. Anything that does not read is
 * the default for that key, so a damaged file can never turn the check off or show a version that
 * was not offered. An ETag is kept only with the answer it belongs to.
 */
export function parseStoredRelease(text: string | null): StoredRelease {
  if (text === null) return DEFAULT_RELEASE;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return DEFAULT_RELEASE;
  }
  if (!isRecord(saved)) return DEFAULT_RELEASE;
  const answer = readAnswer(saved.answer);
  return {
    enabled: saved.enabled !== false,
    answer,
    etag: answer !== null && isEtag(saved.etag) ? saved.etag : null,
    checkedMs: isTime(saved.checkedMs) ? saved.checkedMs : null,
    failure: isFailure(saved.failure) ? saved.failure : null,
    seen: versionOrNull(saved.seen),
  };
}

export function serializeStoredRelease(stored: StoredRelease): string {
  return JSON.stringify(stored);
}

/** What one request ended with, as main's request gives it. */
export type ReleaseOutcome =
  | { readonly kind: "fresh"; readonly text: string; readonly etag: string | null }
  | { readonly kind: "same" }
  | { readonly kind: "failed"; readonly failure: ReleaseFailure };

/**
 * The state after a check. A new file is read by the rules of core (rule 8); "not modified" keeps
 * the last answer; a failure keeps the last answer and when the last check worked, and says why
 * (rule 12). A "not modified" with no answer to keep cannot be, so it counts as unreadable.
 */
export function afterCheck(
  stored: StoredRelease,
  outcome: ReleaseOutcome,
  nowMs: number,
): StoredRelease {
  if (outcome.kind === "same") {
    if (stored.answer === null) return { ...stored, failure: "not-json" };
    return { ...stored, checkedMs: nowMs, failure: null };
  }
  if (outcome.kind === "failed") return { ...stored, failure: outcome.failure };
  const read = readReleaseFile(outcome.text);
  if (!read.ok) return { ...stored, failure: read.problem };
  return {
    ...stored,
    answer: read.release,
    etag: isEtag(outcome.etag) ? outcome.etag : null,
    checkedMs: nowMs,
    failure: null,
  };
}

/** The ETag to send, only when there is an answer it stands for (rule 4). */
export const etagToSend = (stored: StoredRelease): string | null =>
  stored.answer === null ? null : stored.etag;

/** The newer version the kept answer names, if it is newer than the one that runs (rule 7). */
export function newerRelease(stored: StoredRelease, running: string): OfferedRelease | null {
  const offered = parseVersion(stored.answer?.version);
  const mine = parseVersion(running);
  if (offered === null || mine === null || stored.answer === null) return null;
  return isNewerVersion(offered, mine) ? stored.answer : null;
}

/** About has been shown while this answer was known (rule 10). */
export function markSeen(stored: StoredRelease, running: string, asks: boolean): StoredRelease {
  if (!asks || !stored.enabled) return stored;
  const newer = newerRelease(stored, running);
  if (newer === null || !releaseDot(newer.version, stored.seen)) return stored;
  return { ...stored, seen: newer.version };
}

/** Where About's Download or Release notes leads; main opens nothing else from the file (rule 8). */
export function releaseLinkFor(
  stored: StoredRelease,
  running: string,
  which: "download" | "notes",
): string | null {
  const newer = newerRelease(stored, running);
  if (newer === null) return null;
  return releaseActions(newer)[which];
}

/**
 * The project's own pages that About links to, fixed in the source, never from the file: the
 * site's download page, the source and the issues.
 */
export const ABOUT_LINKS = {
  site: RELEASE_DOWNLOAD_PAGE,
  source: "https://github.com/milolabs/matters-app",
  issues: "https://github.com/milolabs/matters-app/issues",
} as const;

/** The stage of the version that runs, from its pre-release identifier. */
export function runningStage(running: string): string | null {
  const first = parseVersion(running)?.pre[0];
  return typeof first === "string" && /^[a-z][a-z-]{0,19}$/i.test(first)
    ? first.toLowerCase()
    : (parseVersion(running)?.pre.length ?? 0) > 0
      ? "pre-release"
      : null;
}

/** Everything About and the gear show, from main's state. */
export function releaseInfo(
  stored: StoredRelease,
  running: string,
  asks: boolean,
  checking: boolean,
): ReleaseInfo {
  const shown = versionOrNull(running) ?? running.slice(0, 64);
  const on = asks && stored.enabled;
  const newer = on ? newerRelease(stored, running) : null;
  const actions = newer === null ? null : releaseActions(newer);
  const newerInfo: ReleaseNewer | null =
    newer === null || actions === null
      ? null
      : {
          version: newer.version,
          dateMs: newer.dateMs,
          preRelease: isPreRelease(newer),
          download: actions.download !== null,
          notes: actions.notes !== null,
        };
  return {
    version: shown,
    stage: runningStage(running),
    asks,
    enabled: stored.enabled,
    checking: on && checking,
    newer: newerInfo,
    dot: newer !== null && releaseDot(newer.version, stored.seen),
    checkedMs: on ? stored.checkedMs : null,
    failure: on && stored.failure !== null ? FAILURE_PHRASES[stored.failure] : null,
  };
}

/** The menu item under About (rule 11). */
export function releaseMenuLabel(info: ReleaseInfo): string {
  return info.newer ? `New Version: ${info.newer.version}…` : "Check for a Newer Version…";
}
