/**
 * Installing a newer version when the person asks (ADR 0140). The rules only: which files come
 * from where (rule 3), where a download may be sent on to, the line of `SHA256SUMS.txt` that
 * names the image, whether the running copy is somewhere it can be replaced (rule 2), the steps of
 * an install and what moves it from one to the next, and what About says at each. Main downloads,
 * runs the programs and swaps the bundle; nothing here touches the network, a file or a clock.
 */
import { isNewerVersion, parseVersion, versionText } from "./release.ts";

/** The repository the files come from, and the workflow that must have built them (rule 3). */
export const INSTALL_REPO = "milolabs/matters-app";
export const INSTALL_WORKFLOW = "milolabs/matters-app/.github/workflows/release.yml";
/** Every file of a release is under this, followed by the tag (rule 3). */
export const INSTALL_DOWNLOAD_BASE = "https://github.com/milolabs/matters-app/releases/download/";
/**
 * Where GitHub sends a release file on to. Seen on 2026-11-16 with `curl -sIL` for the image, the
 * checksums and the build record of `v0.1.0-alpha.5`: one redirect, to this host. Nothing else.
 */
export const INSTALL_REDIRECT_HOSTS: readonly string[] = ["release-assets.githubusercontent.com"];
/** More redirects than this and the download is refused. */
export const INSTALL_MAX_REDIRECTS = 3;
/** The bundle's identifier, as the release build writes it. */
export const INSTALL_BUNDLE_ID = "app.getmatters.Matters";

/** A file is read up to `bytes`, within `ms`, and refused when no byte came for `idleMs`. */
export interface DownloadLimits {
  readonly bytes: number;
  readonly ms: number;
  readonly idleMs: number;
}

/** The limits of rule 3: the image was 192 MB for `v0.1.0-alpha.5`. */
export const INSTALL_LIMITS: Readonly<Record<"image" | "sums" | "record", DownloadLimits>> = {
  image: { bytes: 512 * 1024 * 1024, ms: 20 * 60 * 1000, idleMs: 60_000 },
  sums: { bytes: 64 * 1024, ms: 30_000, idleMs: 30_000 },
  record: { bytes: 4 * 1024 * 1024, ms: 60_000, idleMs: 30_000 },
};

/** The names in the folder of the app, the same as `site/install.sh` (ADR 0139, rule 5). */
export const INSTALL_NAMES = {
  app: "Matters.app",
  installing: ".Matters.app.installing",
  previous: ".Matters.app.previous",
  lock: ".Matters.app.lock",
} as const;

/** Where `gh` is looked for: fixed places, never a shell's PATH (rule 3). */
export const GH_PLACES: readonly string[] = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

/** The version as it may become a tag and a file name: the pattern of `site/install.sh`. */
const INSTALLABLE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?$/;

/** The files of one release, and where each is downloaded from. */
export interface InstallFiles {
  readonly version: string;
  readonly tag: string;
  /** `Matters-<version>-arm64.dmg`. */
  readonly image: string;
  readonly record: string;
  readonly imageUrl: string;
  readonly sumsUrl: string;
  readonly recordUrl: string;
}

/**
 * The files for a version (rule 3), or null when the version does not look like one that a
 * release has. The tag is the version with a `v`. `base` is the release downloads, and only a
 * window test hands in another (a stand-in on this machine).
 */
export function installFiles(
  version: unknown,
  base: string = INSTALL_DOWNLOAD_BASE,
): InstallFiles | null {
  const parsed = parseVersion(version);
  if (parsed === null || typeof version !== "string") return null;
  const text = versionText(parsed);
  // The text as given, not only as it reads: build metadata (`+…`) is no part of a tag.
  if (!INSTALLABLE.test(text) || version.replace(/^v/, "") !== text) return null;
  const tag = `v${text}`;
  const image = `Matters-${text}-arm64.dmg`;
  const record = `${image}.intoto.jsonl`;
  const dir = `${base}${tag}/`;
  return {
    version: text,
    tag,
    image,
    record,
    imageUrl: `${dir}${image}`,
    sumsUrl: `${dir}SHA256SUMS.txt`,
    recordUrl: `${dir}${record}`,
  };
}

/** `https://<host><path>` with a plain host (no user, no port) and a path; null otherwise. */
function hostAndPath(url: string): { host: string; path: string } | null {
  if (url.length > 4096) return null;
  const m = /^https:\/\/([a-z0-9.-]+)(\/[\x21-\x7e]*)$/.exec(url);
  if (!m) return null;
  return { host: m[1] as string, path: m[2] as string };
}

/**
 * Where a download may be sent on to (rule 3): `https` only, to one of GitHub's hosts for release
 * files, or back under the release downloads of the repository.
 */
export function isInstallRedirect(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const at = hostAndPath(url);
  if (at === null) return false;
  if (at.host === "github.com") return url.startsWith(INSTALL_DOWNLOAD_BASE);
  return INSTALL_REDIRECT_HOSTS.includes(at.host);
}

export type SumsRead =
  | { readonly ok: true; readonly sum: string }
  | { readonly ok: false; readonly problem: "missing" | "twice" };

const SUM_LINE = /^([0-9A-Fa-f]{64}) [ *](.+)$/;

/**
 * The SHA-256 that `SHA256SUMS.txt` gives for `name`, in lower case. The lines are those of
 * `shasum -a 256`: the sum, a space, a space or `*`, the file name. The name must be the whole
 * name. No line is a failure; two lines that give different sums are too.
 */
export function readSums(text: string, name: string): SumsRead {
  let found: string | null = null;
  for (const raw of text.split("\n")) {
    const m = SUM_LINE.exec(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (!m || m[2] !== name) continue;
    const sum = (m[1] as string).toLowerCase();
    if (found !== null && found !== sum) return { ok: false, problem: "twice" };
    found = sum;
  }
  return found === null ? { ok: false, problem: "missing" } : { ok: true, sum: found };
}

/** Two sums are the same: 64 hex digits each, case aside. */
export function sameSum(a: string, b: string): boolean {
  return /^[0-9a-f]{64}$/i.test(a) && a.toLowerCase() === b.toLowerCase();
}

/** Why this copy cannot install a newer one (rule 2). */
export type InstallRefusal =
  | "not-release"
  | "platform"
  | "not-bundle"
  | "translocated"
  | "disk-image"
  | "read-only"
  /** The version is newer, but not in the form a release's files are named by. */
  | "version";

/** What main finds out about the running copy, for `installPlace`. */
export interface PlaceFacts {
  /** A release build (`app.isPackaged`), or a window test's stand-in. */
  readonly release: boolean;
  readonly platform: string;
  readonly arch: string;
  /** The running `Matters.app`, as the system names it (links resolved); null when there is none. */
  readonly bundle: string | null;
  /** The folder it is in can be written, and the bundle itself can be moved. */
  readonly folderWritable: boolean;
  readonly bundleWritable: boolean;
}

export type InstallPlace =
  | { readonly ok: true; readonly folder: string }
  | { readonly ok: false; readonly why: InstallRefusal };

/**
 * The bundle a program runs from: `<…>/Matters.app` for `<…>/Matters.app/Contents/MacOS/Matters`,
 * an absolute path with no `.` or `..` part; null for anything else.
 */
export function bundleOf(executable: string): string | null {
  const tail = `/${INSTALL_NAMES.app}/Contents/MacOS/Matters`;
  if (!executable.startsWith("/") || !executable.endsWith(tail)) return null;
  const bundle = executable.slice(0, -"/Contents/MacOS/Matters".length);
  const parts = bundle.split("/").slice(1);
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return bundle;
}

/**
 * Whether this copy can be replaced where it is (rule 2): a release build, on macOS with Apple
 * silicon, running as a real `Matters.app` that is not under App Translocation (macOS runs a
 * quarantined app from a read-only copy in a random folder) and that sits in a folder the person
 * can write to. A read-only folder under `/Volumes` is the disk image.
 */
export function installPlace(facts: PlaceFacts): InstallPlace {
  if (!facts.release) return { ok: false, why: "not-release" };
  if (facts.platform !== "darwin" || facts.arch !== "arm64") return { ok: false, why: "platform" };
  if (facts.bundle === null || !facts.bundle.endsWith(`/${INSTALL_NAMES.app}`)) {
    return { ok: false, why: "not-bundle" };
  }
  if (facts.bundle.includes("/AppTranslocation/")) return { ok: false, why: "translocated" };
  const folder = facts.bundle.slice(0, -`/${INSTALL_NAMES.app}`.length) || "/";
  if (!facts.folderWritable || !facts.bundleWritable) {
    return { ok: false, why: folder.startsWith("/Volumes/") ? "disk-image" : "read-only" };
  }
  return { ok: true, folder };
}

/** What is said after "Matters cannot install it here:" (rule 2). */
const REFUSALS: Record<InstallRefusal, string> = {
  "not-release": "this build was not made by the release workflow",
  platform: "it installs only on a Mac with Apple silicon",
  "not-bundle": "it does not run as Matters.app",
  translocated: "macOS runs this copy from a temporary folder. Move Matters to Applications first",
  "disk-image": "it runs from the disk image. Drag Matters to Applications first",
  "read-only": "you cannot write to the folder Matters is in",
  version: "its version is not in the form a release's files are named by",
};

export function refusalPhrase(why: InstallRefusal): string {
  return REFUSALS[why];
}

/** Why an install stopped; each is said in one phrase, with "Nothing was installed." */
export type InstallFailure =
  | "older"
  | "download"
  | "status"
  | "redirect"
  | "too-big"
  | "timeout"
  | "sums"
  | "checksum"
  | "build-record"
  | "image"
  | "locked"
  | "copy"
  | "signature"
  | "not-matters"
  | "restart"
  | "cancelled";

export const INSTALL_FAILURES: readonly InstallFailure[] = [
  "older",
  "download",
  "status",
  "redirect",
  "too-big",
  "timeout",
  "sums",
  "checksum",
  "build-record",
  "image",
  "locked",
  "copy",
  "signature",
  "not-matters",
  "restart",
  "cancelled",
];

const FAILURES: Record<InstallFailure, string> = {
  older: "It is not newer than the version that runs.",
  download: "The download did not finish.",
  status: "GitHub answered with an error.",
  redirect: "GitHub sent the download somewhere Matters does not download from.",
  "too-big": "The download was larger than a release can be.",
  timeout: "The download took too long.",
  sums: "SHA256SUMS.txt does not list the disk image.",
  checksum: "The download does not match its checksum.",
  "build-record": "gh could not confirm that the release workflow built it.",
  image: "The disk image could not be opened, or holds no Matters.app.",
  locked: `Another install into this folder is under way. If none is, remove ${INSTALL_NAMES.lock} there.`,
  copy: "The new app could not be copied beside this one.",
  signature: "The new app's signature does not hold.",
  "not-matters": "The app in the disk image is not that version of Matters.",
  restart: "Matters could not start the step that swaps the app.",
  cancelled: "Cancelled.",
};

/** What is checked while the step is "checking" (rule 5). */
export type InstallCheck = "checksum" | "build-record";

/** The steps of an install, as About says them (rule 5). */
export type InstallState =
  | { readonly step: "idle" }
  | {
      readonly step: "downloading";
      readonly version: string;
      readonly received: number;
      readonly total: number | null;
    }
  | { readonly step: "checking"; readonly version: string; readonly check: InstallCheck }
  | { readonly step: "installing"; readonly version: string; readonly recorded: boolean }
  | { readonly step: "restarting"; readonly version: string; readonly recorded: boolean }
  | { readonly step: "failed"; readonly version: string; readonly failure: InstallFailure };

export type InstallEvent =
  | { readonly kind: "start"; readonly version: string }
  | { readonly kind: "progress"; readonly received: number; readonly total: number | null }
  | { readonly kind: "check"; readonly check: InstallCheck }
  /** The checks of the download passed; `recorded` says whether the build record was among them. */
  | { readonly kind: "install"; readonly recorded: boolean }
  | { readonly kind: "restart" }
  | { readonly kind: "fail"; readonly failure: InstallFailure }
  | { readonly kind: "cancel" };

export const INSTALL_IDLE: InstallState = { step: "idle" };

/** An install is under way: a second one is not started, and the switch stays as it is. */
export function installBusy(state: InstallState): boolean {
  return state.step !== "idle" && state.step !== "failed";
}

const size = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * The next state. An event that does not fit the step changes nothing: a progress after the
 * download ended, a cancel once the checks run (rule 5 lets the person cancel while it downloads),
 * a second start while one runs. Restarting is the last step; nothing leaves it.
 */
export function nextInstall(state: InstallState, event: InstallEvent): InstallState {
  switch (event.kind) {
    case "start":
      if (installBusy(state) || parseVersion(event.version) === null) return state;
      return { step: "downloading", version: event.version, received: 0, total: null };
    case "progress":
      if (state.step !== "downloading" || !size(event.received)) return state;
      return {
        ...state,
        received: event.received,
        total: event.total !== null && size(event.total) ? event.total : null,
      };
    case "check":
      if (state.step !== "downloading" && state.step !== "checking") return state;
      return { step: "checking", version: state.version, check: event.check };
    case "install":
      if (state.step !== "downloading" && state.step !== "checking") return state;
      return { step: "installing", version: state.version, recorded: event.recorded };
    case "restart":
      if (state.step !== "installing") return state;
      return { step: "restarting", version: state.version, recorded: state.recorded };
    case "fail":
      if (state.step === "idle" || state.step === "failed" || state.step === "restarting") {
        return state;
      }
      return { step: "failed", version: state.version, failure: event.failure };
    case "cancel":
      if (state.step !== "downloading") return state;
      return { step: "failed", version: state.version, failure: "cancelled" };
  }
}

/** How much of the image has come, 0 to 1; null when its size is not known. */
export function installFraction(state: InstallState): number | null {
  if (state.step !== "downloading" || state.total === null || state.total === 0) return null;
  return Math.min(1, state.received / state.total);
}

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

/** The line of About for the step (rule 5); null when there is no install to speak of. */
export function installLine(state: InstallState): string | null {
  switch (state.step) {
    case "idle":
      return null;
    case "downloading":
      return state.total === null
        ? `Downloading ${state.version}: ${mb(state.received)} MB…`
        : `Downloading ${state.version}: ${mb(state.received)} of ${mb(state.total)} MB…`;
    case "checking":
      return state.check === "checksum"
        ? "Checking the download against its checksum…"
        : "Checking that the release workflow built it…";
    case "installing":
      return `Installing ${state.version}…`;
    case "restarting":
      return `Restarting into ${state.version}…`;
    case "failed":
      return `${FAILURES[state.failure]} Nothing was installed.`;
  }
}

/** What About says under the line: whether the build record was checked (rule 3). */
export function installNote(state: InstallState): string | null {
  if (state.step !== "installing" && state.step !== "restarting") return null;
  return state.recorded
    ? `The checksum matches, and the release workflow of ${INSTALL_REPO} built it.`
    : "The checksum matches. Not checked: where it was built. With the GitHub CLI (gh) installed, Matters checks that too.";
}

/**
 * Whether `version` may replace `running` (rule 3): a version a release has, newer by the rule of
 * ADR 0137. Never the same one, never an older one.
 */
export function mayInstall(version: unknown, running: unknown): boolean {
  const offered = parseVersion(version);
  const mine = parseVersion(running);
  if (offered === null || mine === null) return false;
  return installFiles(version) !== null && isNewerVersion(offered, mine);
}
