// What every spec starts from: a data folder of its own, and a way to start the built app in it.
// Each start is filmed and traced; when it ends (or the test does) the video, the trace and a last
// screenshot are attached to the test, so a failure on CI can be watched, not guessed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";

export { expect } from "@playwright/test";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What the app is started with for the keychain. macOS: Chromium's mock keychain, so the login
 * keychain never asks for permission in the middle of a run (Playwright's loader sets the same
 * switch; it is named here so the suite does not depend on that). Linux: `keyring.cjs`, loaded
 * before the app, which puts the Secret Service back after Playwright's loader chose the
 * plain-text store.
 */
function keychainArgs(): string[] {
  if (process.platform === "darwin") return ["--use-mock-keychain"];
  if (process.platform === "linux") return ["-r", join(appDir, "e2e/keyring.cjs")];
  return [];
}

/**
 * The environment of the runner, without anything that would change what the app does: no smoke
 * mode, no demo mail, no pre-configured account, no permission for plaintext servers. A spec adds
 * back what it means to use.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "ELECTRON_RUN_AS_NODE" || key.startsWith("MATTERS_")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export interface Running {
  readonly app: ElectronApplication;
  /** The mail window. */
  readonly window: Page;
  /** Quits the app and attaches what was recorded; a second call does nothing. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Added to the app's environment, e.g. `{ MATTERS_SEED: "1" }`. */
  readonly env?: Record<string, string>;
}

interface Fixtures {
  /** A fresh folder for the database and userData, removed after the test. */
  dataDir: string;
  /** Starts the built app on `dataDir`. Can be called again after `close()`: a restart. */
  start: (options?: StartOptions) => Promise<Running>;
}

async function record(running: ElectronApplication, window: Page, n: number, info: TestInfo) {
  const name = `start-${n}`;
  const shot = info.outputPath(`${name}.png`);
  await window
    .screenshot({ path: shot })
    .then(() => info.attach(`${name} screenshot`, { path: shot, contentType: "image/png" }))
    .catch(() => {});
  const trace = info.outputPath(`${name}-trace.zip`);
  await running
    .context()
    .tracing.stop({ path: trace })
    .then(() => info.attach(`${name} trace`, { path: trace, contentType: "application/zip" }))
    .catch(() => {});
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a fixture needs from this pattern
  dataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "matters-e2e-"));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  start: async ({ dataDir }, use, info) => {
    const open: Running[] = [];
    let starts = 0;
    await use(async (options = {}) => {
      const n = ++starts;
      // No `executablePath`: Playwright then starts the `electron` package's binary with its own
      // loader, which holds the app until Playwright is attached, so no window is missed.
      const app = await _electron.launch({
        args: [...keychainArgs(), appDir],
        env: {
          ...cleanEnv(),
          MATTERS_DB_PATH: join(dataDir, "matters.db"),
          MATTERS_USER_DATA: join(dataDir, "userData"),
          ...options.env,
        },
        recordVideo: { dir: info.outputPath(`start-${n}-video`) },
      });
      // What the app writes is kept with the test, for reading after a failure.
      const log: string[] = [];
      app.process().stdout?.on("data", (d: Buffer) => log.push(d.toString()));
      app.process().stderr?.on("data", (d: Buffer) => log.push(d.toString()));
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      const window = await app.firstWindow();
      let closed = false;
      const running: Running = {
        app,
        window,
        async close() {
          if (closed) return;
          closed = true;
          await record(app, window, n, info);
          const video = window.video();
          await app.close().catch(() => {});
          const path = await video?.path().catch(() => undefined);
          if (path) await info.attach(`start-${n} video`, { path, contentType: "video/webm" });
          await info.attach(`start-${n} app output`, {
            body: log.join(""),
            contentType: "text/plain",
          });
        },
      };
      open.push(running);
      return running;
    });
    for (const running of open) await running.close();
  },
});
