// The folder of the app during an install (ADR 0140, rule 4), with the names and the lock of
// `site/install.sh` (ADR 0139, rule 5), so the script and the app never install into one folder
// at once. Main takes the lock and puts the checked new app beside the old one; the swap itself is
// made by a small helper after the app has quit, because a running app cannot be replaced under
// itself: its helpers are started from the bundle while it runs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_NAMES } from "@matters/core";

export type LockTaken = "taken" | "held" | "failed";

/**
 * Takes the folder's lock: `mkdir` either makes it or fails, so there is no moment in which two
 * installs both have it. A lock that is there is another install's, or one that was killed; it is
 * never taken over (the script names it, and the person removes it).
 */
export function takeLock(folder: string): LockTaken {
  try {
    mkdirSync(join(folder, INSTALL_NAMES.lock));
    return "taken";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "failed";
  }
}

export function releaseLock(folder: string): void {
  try {
    rmdirSync(join(folder, INSTALL_NAMES.lock));
  } catch {
    // Not there, or not ours to remove any more.
  }
}

/**
 * With the lock held: what an install that was killed may have left. Its old app goes back when
 * there is none in place, as the script does; then the copies beside it go.
 */
export function clearLeftovers(folder: string): void {
  const app = join(folder, INSTALL_NAMES.app);
  const previous = join(folder, INSTALL_NAMES.previous);
  if (existsSync(previous) && !existsSync(app)) renameSync(previous, app);
  rmSync(join(folder, INSTALL_NAMES.installing), { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
}

/** The new app's place beside the old one. */
export const installingPath = (folder: string) => join(folder, INSTALL_NAMES.installing);

/**
 * The helper, run by `/bin/bash -c` with the app's pid and the folder; it is never written to a
 * file. It holds the lock main took. It waits for the app to quit (two minutes at most), then, once
 * no process from that bundle is left (ten seconds at most), moves the old app aside, puts the new one in its
 * place, removes the old one, and opens the app. When a step fails the old app is moved back and
 * opened. It finds its programs through the PATH it is given; main gives a fixed one.
 */
export const SWAP_SCRIPT = `
pid="$1"
dest="$2"
app="$dest/${INSTALL_NAMES.app}"
incoming="$dest/${INSTALL_NAMES.installing}"
previous="$dest/${INSTALL_NAMES.previous}"
lock="$dest/${INSTALL_NAMES.lock}"
finish() { rm -rf "$incoming"; rmdir "$lock" 2>/dev/null; }
running() { ps -axo comm= | grep -F "$app/Contents/" > /dev/null; }
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 600 ]; then finish; exit 3; fi
  sleep 0.2
done
# The app's own helpers may take a moment to end after it; a copy that still runs after ten
# seconds was started again by the person, and is left alone.
n=0
while running; do
  n=$((n + 1))
  if [ "$n" -gt 50 ]; then finish; exit 4; fi
  sleep 0.2
done
if [ ! -d "$incoming" ]; then finish; open "$app"; exit 5; fi
if [ -e "$app" ]; then
  if ! mv "$app" "$previous"; then finish; open "$app"; exit 6; fi
fi
if ! mv "$incoming" "$app"; then
  if [ ! -e "$app" ] && [ -e "$previous" ]; then
    if ! mv "$previous" "$app"; then rmdir "$lock" 2>/dev/null; exit 8; fi
  fi
  finish
  open "$app"
  exit 7
fi
rm -rf "$previous"
finish
open "$app"
`;

/** The fixed PATH of the helper and of every program an install runs: the system's own. */
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface SwapStart {
  readonly pid: number;
  readonly folder: string;
}

/**
 * Starts the helper, detached and with no output, so it outlives the app. False when it could
 * not be started; the install then stops and the new app beside the old one is removed.
 */
export function startSwap(
  at: SwapStart,
  run: typeof spawn = spawn,
  env: Record<string, string> = { PATH: SYSTEM_PATH },
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = run(
        "/bin/bash",
        ["-c", SWAP_SCRIPT, "matters-swap", String(at.pid), at.folder],
        { detached: true, stdio: "ignore", env, cwd: "/" },
      );
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
