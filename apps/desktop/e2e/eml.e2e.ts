// Save as .eml… (ADR 0145, rules 1 to 5) on the demo mailbox. The demo has no server: its few
// messages with files are answered by the demo's stand-in with a source it makes (the same bytes
// every time), and every other demo message is on no server, so it shows the phrase for that. The
// save dialog's stand-in is the PDF's (`MATTERS_TEST_SAVE_DIR`, a dev build's): the file goes there,
// and several letters go into that folder. A real fetch over IMAP is the Dovecot-backed contract
// (`bun run test:imap`); a real account was not used.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function open(window: Page, subject: string): Promise<void> {
  const list = window.getByRole("listbox", { name: "Messages" });
  await list.getByRole("option").filter({ hasText: subject }).first().click();
  const thread = window.getByRole("region", { name: "Thread" });
  await expect(thread.getByRole("heading", { level: 2 })).toHaveText(subject);
}

async function saveEml(window: Page): Promise<void> {
  const thread = window.getByRole("region", { name: "Thread" });
  await thread.getByRole("button", { name: "More actions" }).click();
  await window.getByRole("menuitem", { name: /Save as \.eml/ }).click();
}

async function fileItem(app: ElectronApplication, label: string) {
  return app.evaluate(({ Menu }, label) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
    return file?.submenu?.items.find((i) => i.label === label)?.enabled ?? null;
  }, label);
}

test("Save as .eml… writes the message as the server gives it, privately, and says nothing", async ({
  start,
  dataDir,
}) => {
  const saved = join(dataDir, "saved");
  mkdirSync(saved);
  const { app, window } = await start({ env: { MATTERS_SEED: "1", MATTERS_TEST_SAVE_DIR: saved } });
  const subject = "Załączniki: jeden plik";
  await open(window, subject);
  if (process.platform === "darwin") {
    await expect.poll(() => fileItem(app, "Save as .eml…")).toBe(true);
  }
  await saveEml(window);

  await expect.poll(() => readdirSync(saved), { timeout: 30_000 }).toHaveLength(1);
  const [name] = readdirSync(saved);
  expect(name).toMatch(/^Załączniki: jeden plik \d{4}-\d{2}-\d{2}\.eml$/);
  const file = join(saved, name as string);
  // Mine alone, never executable.
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const text = readFileSync(file, "latin1");
  expect(text.startsWith("From: ")).toBe(true);
  expect(text).toContain("Message-ID: <demo-9001@demo.invalid>");
  expect(text).toContain("Content-Transfer-Encoding: base64");
  expect(text.endsWith("--demo-9001--\r\n")).toBe(true);
  await expect(window.locator("[data-eml-problem]")).toHaveCount(0);
  await expect(window.locator("[data-eml-progress]")).toHaveCount(0);
});

test("a message on no server is not saved, and the window says why in one phrase", async ({
  start,
  dataDir,
}) => {
  const saved = join(dataDir, "saved");
  mkdirSync(saved);
  const { window } = await start({ env: { MATTERS_SEED: "1", MATTERS_TEST_SAVE_DIR: saved } });
  await open(window, "Zdjęcia: tylko piksel śledzący");
  await saveEml(window);
  await expect(window.locator("[data-eml-problem]")).toHaveText(
    "This message is no longer on the server, so it could not be saved as a file.",
  );
  expect(readdirSync(saved)).toEqual([]);
  // Another thread opened: the line goes.
  await open(window, "Załączniki: jeden plik");
  await expect(window.locator("[data-eml-problem]")).toHaveCount(0);
});

test("Stop ends a save part way and leaves nothing in the folder", async ({ start, dataDir }) => {
  const saved = join(dataDir, "saved");
  mkdirSync(saved);
  const { window } = await start({ env: { MATTERS_SEED: "1", MATTERS_TEST_SAVE_DIR: saved } });
  // 34 MB that arrive slowly, so the save can be watched and stopped.
  await open(window, "Załączniki: jeden duży plik");
  await saveEml(window);
  const progress = window.locator("[data-eml-progress]");
  await expect(progress).toContainText(/Saving the message/);
  await progress.getByRole("button", { name: "Stop" }).click();
  await expect(progress).toHaveCount(0);
  await expect(window.locator("[data-eml-problem]")).toHaveCount(0);
  // No file under the name, and no temporary file beside it.
  await expect.poll(() => readdirSync(saved)).toEqual([]);
});

test("several letters go into the folder, and the window says which were not saved", async ({
  start,
  dataDir,
}, testInfo) => {
  const saved = join(dataDir, "saved");
  mkdirSync(saved);
  const { window } = await start({ env: { MATTERS_SEED: "1", MATTERS_TEST_SAVE_DIR: saved } });
  // A thread of the generated mailbox with several letters, none of them on a server.
  const options = window.getByRole("listbox", { name: "Messages" }).getByRole("option");
  const thread = window.getByRole("region", { name: "Thread" });
  let letters = 0;
  for (let i = 0; i < 30 && letters < 2; i++) {
    await options.nth(i).click();
    await expect(thread.getByRole("heading", { level: 2 })).toBeVisible();
    letters = await thread.locator("[data-letter-key]").count();
  }
  expect(letters).toBeGreaterThanOrEqual(2);
  await saveEml(window);
  await expect(window.locator("[data-eml-problem]")).toHaveText(
    /^0 letters of (\d+) saved\. \1 letters not: no longer on the server\.$/,
  );
  await window.screenshot({ path: testInfo.outputPath("eml-problem.png") });
  expect(readdirSync(saved)).toEqual([]);
});
