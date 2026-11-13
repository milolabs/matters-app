// The end-to-end suite (ADR 0130): the built app in a real window, driven through Playwright's
// Electron support. Run it with `bun run test:e2e` (all specs, needs Docker) or
// `bun run test:e2e:demo` (the demo mailbox only). The app must be built first; both scripts do it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const ci = !!process.env.CI;
// One folder for everything a run leaves: the HTML report, and each test's video, trace and
// screenshots. It is git-ignored, and CI keeps it as an artifact.
export const OUTPUT = join(here, "../../../.e2e");

export default defineConfig({
  testDir: here,
  // `*.e2e.ts`, so vitest (which takes `*.test.ts` and `*.spec.ts`) never loads a spec.
  testMatch: "**/*.e2e.ts",
  outputDir: join(OUTPUT, "results"),
  // Each test starts its own app. The specs on a real account share one IMAP server, and two
  // windows at once would also compete for the screen of a CI runner: one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  // A first sync and a cold start of Electron on a shared runner take a while.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: join(OUTPUT, "report"), open: "never" }],
    ...(ci ? [["github"] as const] : []),
  ],
});
