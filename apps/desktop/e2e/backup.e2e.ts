// Back Up… and Restore from a Backup… (ADR 0145, rules 6 to 10) on the demo mailbox: a backup,
// a change after it, the restore made ready, the restart, the old state back and the database
// from before the restore listed in Storage. A dev build's stand-ins name the files instead of the
// dialogs (`MATTERS_TEST_BACKUP_PATH`, `MATTERS_TEST_RESTORE_PATH`), and Restart to Restore quits
// without starting the app again (`MATTERS_TEST_NO_RELAUNCH`): the test starts it, as macOS would.
// Everything is in the test's own folder; no real data is read.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function openSettings(app: ElectronApplication, window: Page): Promise<Page> {
  await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  return settings;
}

async function storage(settings: Page) {
  await settings.getByRole("button", { name: "Storage" }).click();
  return settings.getByRole("region", { name: "Backups" });
}

async function agentLimit(settings: Page) {
  await settings.getByRole("button", { name: "Agents" }).click();
  return settings.getByLabel("Background limit");
}

test("back up, change, restore, restart: the old state is back and the one before is kept", async ({
  start,
  dataDir,
}) => {
  const out = join(dataDir, "out");
  mkdirSync(out);
  const file = join(out, "Matters backup.db");
  const env = {
    MATTERS_SEED: "1",
    MATTERS_TEST_BACKUP_PATH: file,
    MATTERS_TEST_RESTORE_PATH: file,
    MATTERS_TEST_NO_RELAUNCH: "1",
  };
  const first = await start({ env });
  let settings = await openSettings(first.app, first.window);

  // What a backup holds and does not is said before one is written.
  let backups = await storage(settings);
  await expect(backups).toContainText("does not hold passwords, sign-ins or API keys");
  await expect(backups.locator("[data-backup-unencrypted]")).toHaveText(
    /not encrypted: anyone who can read it can read your mail/,
  );
  await backups.getByRole("button", { name: "Back Up…" }).click();
  await expect(backups.locator("[data-backup-notice]")).toContainText(
    "Backed up to “Matters backup.db”",
    {
      timeout: 60_000,
    },
  );
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(out)).toEqual(["Matters backup.db"]);

  // A change after the backup: a setting kept in the database.
  let limit = await agentLimit(settings);
  const before = await limit.inputValue();
  const changed = before === "none" ? "Up to 50% of my week" : "No limit";
  await limit.selectOption({ label: changed });
  await expect(limit).not.toHaveValue(before);

  backups = await storage(settings);
  await backups.getByRole("button", { name: "Restore from a Backup…" }).click();
  const pending = backups.locator("[data-restore-pending]");
  await expect(pending).toContainText("A restore waits for the next start", { timeout: 60_000 });
  await expect(pending).toContainText(/The backup holds [\d,]+ messages of 1 account/);
  // Nothing changed yet.
  limit = await agentLimit(settings);
  await expect(limit).not.toHaveValue(before);
  backups = await storage(settings);
  await Promise.all([
    first.app.waitForEvent("close"),
    pending.getByRole("button", { name: "Restart to Restore" }).click(),
  ]);
  await first.close();

  const second = await start({ env });
  settings = await openSettings(second.app, second.window);
  limit = await agentLimit(settings);
  await expect(limit).toHaveValue(before);
  backups = await storage(settings);
  await expect(backups.locator("[data-restore-pending]")).toHaveCount(0);
  const aside = backups.locator("[data-set-aside]");
  await expect(aside).toHaveCount(1);
  await expect(aside).toContainText(/Set aside .* \d/);

  // Removing it asks first, and then it is gone.
  await aside.getByRole("button", { name: "Remove…" }).click();
  await backups.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(backups.locator("[data-set-aside]")).toHaveCount(0);
});

test("a file that is not a backup is refused in one phrase, and nothing waits", async ({
  start,
  dataDir,
}) => {
  const file = join(dataDir, "notes.db");
  writeFileSync(file, "These are my notes, not a database of anything.");
  const { app, window } = await start({
    env: { MATTERS_SEED: "1", MATTERS_TEST_RESTORE_PATH: file },
  });
  const settings = await openSettings(app, window);
  const backups = await storage(settings);
  await backups.getByRole("button", { name: "Restore from a Backup…" }).click();
  await expect(backups.locator("[data-backup-failure]")).toHaveText(
    "This file is not a backup of Matters: it is not a database.",
  );
  await expect(backups.locator("[data-restore-pending]")).toHaveCount(0);
});

test("Storage shows Backups in the app's own controls", async ({ start }, testInfo) => {
  const { app, window } = await start({ env: { MATTERS_SEED: "1" } });
  const settings = await openSettings(app, window);
  const backups = await storage(settings);
  await backups.scrollIntoViewIfNeeded();
  await backups.screenshot({ path: testInfo.outputPath("backups.png") });
  await expect(backups.getByRole("button", { name: "Back Up…" })).toBeEnabled();
});
