/**
 * Whether a newer version of the app is out (ADR 0137). The rules only: how two versions compare
 * (rule 7), what of the site's `release.json` is believed (rule 8), which links from it may be
 * opened, and when the next check is due (rules 4 and 12). Main makes the request and keeps the
 * state; nothing here touches the network or a clock.
 */

/** The one file the app reads (ADR 0137, rule 2). */
export const RELEASE_FILE_URL = "https://getmatters.app/release.json";
/** Where the person is sent when the file gives no link that passes (rule 8). */
export const RELEASE_DOWNLOAD_PAGE = "https://getmatters.app/download.html";
/** The only links of the file that are ever opened lie under this (rule 8). */
export const RELEASE_LINK_PREFIX = "https://github.com/milolabs/matters-app/releases/";
/** The file is read up to this many bytes, and refused above it (rule 8). */
export const RELEASE_FILE_LIMIT = 16 * 1024;
/** A request that has not ended by then is a failed check (rule 8). */
export const RELEASE_TIMEOUT_MS = 10_000;
/** While the app runs, a check once in this long (rule 4). */
export const RELEASE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** The request's whole `User-Agent`: no version, no system (rule 3). */
export const RELEASE_USER_AGENT = "Matters";

/** A version by semantic versioning, as it compares (rule 7). */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The pre-release identifiers, numbers where they are numeric: `alpha.5` is `["alpha", 5]`. */
  readonly pre: readonly (string | number)[];
}

const NUMBER = "0|[1-9]\\d{0,8}";
const IDENT = "[0-9A-Za-z-]+";
const VERSION = new RegExp(
  `^v?(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`,
);
/** Longer than any tag the release workflow makes; a longer text is not read at all. */
const VERSION_LIMIT = 64;

/**
 * A version from a tag or a version text, the leading `v` dropped (rule 7); null for anything
 * that is not one. A numeric pre-release identifier with a leading zero is not one either.
 */
export function parseVersion(text: unknown): Version | null {
  if (typeof text !== "string" || text.length > VERSION_LIMIT) return null;
  const m = VERSION.exec(text);
  if (!m) return null;
  const pre: (string | number)[] = [];
  for (const part of m[4] === undefined ? [] : m[4].split(".")) {
    if (/^\d+$/.test(part)) {
      if (part.length > 1 && part.startsWith("0")) return null;
      if (part.length > 9) return null;
      pre.push(Number(part));
    } else pre.push(part);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** The version as the app shows it: no `v`, no build metadata. */
export function versionText(v: Version): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre.length === 0 ? core : `${core}-${v.pre.join(".")}`;
}

/**
 * Below 0 when `a` comes before `b`, above when after, 0 when they are the same release, by the
 * precedence of semantic versioning: a pre-release comes before its release, numeric identifiers
 * compare as numbers and before words, and more identifiers come after fewer (rule 7).
 */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i] as string | number;
    const y = b.pre[i] as string | number;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}

/** `offered` is newer than `running`; equal or older says nothing (rule 7). */
export function isNewerVersion(offered: Version, running: Version): boolean {
  return compareVersions(offered, running) > 0;
}

/**
 * A link of the file that may be opened (rule 8): an `https` link under the project's release
 * pages, in plain characters only, with no `.` or `..` segment and no empty one, so what is opened
 * is exactly what was checked. Anything else is left out.
 */
export function isReleaseLink(link: unknown): link is string {
  if (typeof link !== "string" || link.length > 512) return false;
  if (!link.startsWith(RELEASE_LINK_PREFIX)) return false;
  const rest = link.slice(RELEASE_LINK_PREFIX.length);
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(rest)) return false;
  return rest.split("/").every((segment) => segment !== "." && segment !== "..");
}

/** A stage word as the site writes it: "alpha", "beta", "pre-release"; null for a stable one. */
const STAGE = /^[a-z][a-z-]{0,19}$/;
/** The site's date: an instant in UTC, as GitHub gives it. */
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** What the app believes of the file: the version, the stage, the date and the two links. */
export interface OfferedRelease {
  /** The version as the app shows it, without the `v`. */
  readonly version: string;
  /** The stage the file names, or null for a stable release. */
  readonly stage: string | null;
  /** When it was published, ms since the epoch; null when the file gives no date that reads. */
  readonly dateMs: number | null;
  /** The disk image's link, when it passes `isReleaseLink`. */
  readonly download: string | null;
  /** The release notes' link, when it passes. */
  readonly notes: string | null;
}

/** Why a file was not believed; a failed check (rules 8 and 12). */
export type ReleaseFileProblem = "too-big" | "not-json" | "no-version";

export type ReleaseFileRead =
  | { readonly ok: true; readonly release: OfferedRelease }
  | { readonly ok: false; readonly problem: ReleaseFileProblem };

/**
 * The site's `release.json`, not trusted (rule 8). The version must be a version: a file without
 * one (the site's "no release" has `null`) is not "newest", it is a failed check. A stage, a date
 * or a link that does not read is left out; nothing else of the file is kept.
 */
export function readReleaseFile(text: string): ReleaseFileRead {
  if (text.length > RELEASE_FILE_LIMIT) return { ok: false, problem: "too-big" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not-json" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, problem: "not-json" };
  }
  const file = data as Record<string, unknown>;
  const version = parseVersion(file.version);
  if (version === null) return { ok: false, problem: "no-version" };
  const dateMs =
    typeof file.date === "string" && DATE.test(file.date) ? Date.parse(file.date) : NaN;
  return {
    ok: true,
    release: {
      version: versionText(version),
      stage: typeof file.stage === "string" && STAGE.test(file.stage) ? file.stage : null,
      dateMs: Number.isFinite(dateMs) ? dateMs : null,
      download: isReleaseLink(file.url) ? file.url : null,
      notes: isReleaseLink(file.notes) ? file.notes : null,
    },
  };
}

/**
 * The two actions of About, as main opens them (rule 8): a link that did not pass is left out,
 * and with neither, Download sends the person to the site's download page.
 */
export function releaseActions(release: Pick<OfferedRelease, "download" | "notes">): {
  readonly download: string | null;
  readonly notes: string | null;
} {
  if (release.download === null && release.notes === null) {
    return { download: RELEASE_DOWNLOAD_PAGE, notes: null };
  }
  return { download: release.download, notes: release.notes };
}

/** A pre-release: a version with pre-release identifiers, or one the file gives a stage. */
export function isPreRelease(release: Pick<OfferedRelease, "version" | "stage">): boolean {
  return release.stage !== null || (parseVersion(release.version)?.pre.length ?? 0) > 0;
}

/**
 * A check is due when none was tried yet in this run, or the last try is a day old (rule 4); a
 * failed check waits as long as one that worked (rule 12). A clock that went back counts as due,
 * so a wrong clock never stops the checks.
 */
export function checkDue(lastTriedMs: number | null, nowMs: number): boolean {
  return (
    lastTriedMs === null || nowMs < lastTriedMs || nowMs - lastTriedMs >= RELEASE_CHECK_EVERY_MS
  );
}

/** How long until the next check is due, 0 when it is now. */
export function msUntilCheck(lastTriedMs: number | null, nowMs: number): number {
  if (checkDue(lastTriedMs, nowMs)) return 0;
  return (lastTriedMs as number) + RELEASE_CHECK_EVERY_MS - nowMs;
}

/**
 * Whether the dot is on (rules 9 and 10): a newer version is known, and About has not been shown
 * while it, or one newer than it, was known.
 */
export function releaseDot(newer: string | null, seen: string | null): boolean {
  const offered = parseVersion(newer);
  if (offered === null) return false;
  const shown = parseVersion(seen);
  return shown === null || compareVersions(offered, shown) > 0;
}
