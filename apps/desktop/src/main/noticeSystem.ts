// What main can say about the system's banners, for Settings › Notifications (ADR 0108). Electron
// 45 cannot read whether macOS allows them, so this says only what is known: the platform, and
// whether the app runs as its own bundle (ADR 0107) or as the stock Electron runtime, which macOS
// shows no banners for. It reads the running bundle's Info.plist, never a system preference file.
import type { NoticeSystem } from "@matters/contracts";

/** The bundle id `bun run bundle:macos` gives (tools/bundle-macos.ts, ADR 0107). */
export const MATTERS_BUNDLE_ID = "app.getmatters.Matters";
/** The stock runtime's bundle id: `electron apps/desktop`. */
export const ELECTRON_BUNDLE_ID = "com.github.Electron";

/**
 * The Notifications pane of System Settings, at Matters. The pane's extension
 * (`com.apple.Notifications-Settings.extension`) allows the `x-apple.systempreferences` scheme on
 * macOS 13 and later; `id` names the app to show. Fixed: the page never names a URL.
 */
export const NOTIFICATION_SETTINGS_URL = `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${MATTERS_BUNDLE_ID}`;

/** The `.app` folder an executable runs from, or null when it is not inside one. */
export function bundleOf(execPath: string): string | null {
  const at = execPath.lastIndexOf(".app/Contents/MacOS/");
  return at < 0 ? null : execPath.slice(0, at + ".app".length);
}

/** The CFBundleIdentifier of an XML Info.plist; null when it has none. */
export function bundleIdOf(plist: string): string | null {
  const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]{1,200})<\/string>/.exec(plist);
  return match?.[1]?.trim() || null;
}

/**
 * How the app runs, by the bundle id of the running bundle: its own (`own`), the stock runtime
 * (`runtime`), or something this cannot tell (`unknown`). Only macOS has bundles that matter here.
 */
export function noticeSystem(
  platform: string,
  execPath: string,
  readPlist: (path: string) => string | null,
): NoticeSystem {
  if (platform !== "darwin")
    return { platform: platform === "win32" ? "windows" : "other", app: "unknown" };
  const bundle = bundleOf(execPath);
  const plist = bundle === null ? null : readPlist(`${bundle}/Contents/Info.plist`);
  const id = plist === null ? null : bundleIdOf(plist);
  const app = id === MATTERS_BUNDLE_ID ? "own" : id === ELECTRON_BUNDLE_ID ? "runtime" : "unknown";
  return { platform: "macos", app };
}
