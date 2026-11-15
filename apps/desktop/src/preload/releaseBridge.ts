// Newer versions (ADR 0137): every window may read what main knows, Settings › About may turn the
// check on or off, ask for one, say that it was shown, and open one of its links. Like the other
// bridges it exposes nothing: the page posts a request, the preload checks its shape and asks
// main, which validates again. A link crosses by name ("download"), never as a URL: main alone
// knows where it leads (rule 8). Main tells every window when the state changed (ADR 0115).
import { isReleaseOpen, readReleaseInfo } from "../main/releaseShapes.ts";

export const CHANNEL_RELEASE = "matters:release";
/** Main to every window: the state after a change. */
export const CHANNEL_RELEASE_CHANGED = "matters:release-changed";
/** Main to the settings window: show this section (the menu's item opens About, rule 11). */
export const CHANNEL_SETTINGS_SECTION = "matters:settings-section";

export type ReleaseAction = "get" | "enable" | "check" | "seen" | "open";
const ACTIONS: readonly string[] = [
  "get",
  "enable",
  "check",
  "seen",
  "open",
] satisfies ReleaseAction[];

export interface ReleaseBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface ReleaseMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The arguments main is asked with, or null for an ask that is not well formed. */
function argsOf(ask: Record<string, unknown>): unknown[] | null {
  switch (ask.action) {
    case "get":
    case "check":
    case "seen":
      return [ask.action];
    case "enable":
      return typeof ask.on === "boolean" ? [ask.action, ask.on] : null;
    case "open":
      return isReleaseOpen(ask.which) ? [ask.action, ask.which] : null;
    default:
      return null;
  }
}

/** A section name as it may cross: a short word. */
const isSectionId = (v: unknown): v is string => typeof v === "string" && /^[a-z]{1,20}$/.test(v);

export function createReleaseBridge(deps: ReleaseBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: ReleaseMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersRelease;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      const args =
        typeof ask.action === "string" && ACTIONS.includes(ask.action) ? argsOf(ask) : null;
      if (args === null) {
        deps.post({ mattersReleaseAnswer: { requestId, answer: null } });
        return;
      }
      deps
        .invoke(CHANNEL_RELEASE, ...args)
        .then(readReleaseInfo, () => null)
        .then((answer) => deps.post({ mattersReleaseAnswer: { requestId, answer } }));
    },
    /** Main's push on `CHANNEL_RELEASE_CHANGED`. */
    changed(data: unknown): void {
      const info = readReleaseInfo(data);
      if (info) deps.post({ mattersReleaseChanged: info });
    },
    /** Main's push on `CHANNEL_SETTINGS_SECTION`. */
    section(data: unknown): void {
      if (isSectionId(data)) deps.post({ mattersSettingsSection: data });
    },
  };
}
