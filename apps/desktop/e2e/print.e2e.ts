// Printing a thread and saving it as a PDF (ADR 0144) on the demo mailbox. Save as PDF… writes the
// file where the window test says (`MATTERS_TEST_SAVE_DIR`, a dev build's stand-in for the save
// dialog), and its text is read back with the app's own PDF reader. The system's print dialog
// cannot be driven, and nothing may reach a printer of this machine: `MATTERS_TEST_PRINT_LOG`
// writes the call down, with the window it was for, instead of making it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { extractFileText } from "../../../packages/adapter-filetext/src/index.ts";
import { expect, test } from "./fixtures.ts";

const SUBJECT = "Załączniki: wiadomość z grafiką";

async function openShop(window: Page): Promise<void> {
  const list = window.getByRole("listbox", { name: "Messages" });
  await list.getByRole("option").filter({ hasText: SUBJECT }).click();
  const thread = window.getByRole("region", { name: "Thread" });
  await expect(thread.getByRole("heading", { level: 2 })).toHaveText(SUBJECT);
  await expect(thread.locator("iframe[data-mail-frame][data-painted]")).toHaveCount(1);
}

/** The File menu's item with this label: whether it is on, and a click on it as macOS would. */
async function fileItem(app: ElectronApplication, label: string, click = false) {
  return app.evaluate(
    ({ Menu }, { label, click }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
      const item = file?.submenu?.items.find((i) => i.label === label);
      if (item && click) item.click();
      return item ? { enabled: item.enabled, accelerator: item.accelerator ?? null } : null;
    },
    { label, click },
  );
}

const windowIds = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id));

test("Save as PDF… writes the whole thread where the person chose, and no window stays", async ({
  start,
  dataDir,
}) => {
  const saved = join(dataDir, "saved");
  mkdirSync(saved);
  const { app, window } = await start({
    env: { MATTERS_SEED: "1", MATTERS_TEST_SAVE_DIR: saved },
  });
  await openShop(window);
  const before = await windowIds(app);

  const thread = window.getByRole("region", { name: "Thread" });
  await thread.getByRole("button", { name: "More actions" }).click();
  await window.getByRole("menuitem", { name: /Save as PDF/ }).click();

  await expect.poll(() => readdirSync(saved), { timeout: 30_000 }).toHaveLength(1);
  const [name] = readdirSync(saved);
  // The subject and the day of the letter; the colon is kept, no path separator could be.
  expect(name).toMatch(/^Załączniki: wiadomość z grafiką \d{4}-\d{2}-\d{2}\.pdf$/);
  const file = join(saved, name as string);
  await expect.poll(() => statSync(file).size).toBeGreaterThan(2_000);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeLessThan(5_000_000);
  // The PDF carries the subject as its title and nothing of the person: no Author.
  const raw = bytes.toString("latin1");
  expect(raw).not.toMatch(/\/Author\b/);

  const text = await extractFileText(file, "pdf");
  expect(text.state).toBe("ok");
  // Headers as text, the body as the reader shows it, the files by name and size.
  const words = text.text.replace(/\s+/g, " ");
  for (const expected of [
    SUBJECT,
    "Sklep Łąka",
    "zamowienia@sklep-laka.example",
    "Dziękujemy za zamówienie",
    "Faktura 2026-11-0412.pdf",
    "Regulamin sklepu.pdf",
  ]) {
    expect(words).toContain(expected);
  }

  // The hidden window is gone, and no notice of a failure is shown.
  await expect.poll(() => windowIds(app)).toEqual(before);
  await expect(window.locator("[data-print-problem]")).toHaveCount(0);
});

// The app menu is macOS's; elsewhere the reader's More menu is the way (ADR 0144, rule 1).
const mac = process.platform === "darwin";

test("Print… calls the system's print once, for the hidden window, which is gone after", async ({
  start,
  dataDir,
}) => {
  const log = join(dataDir, "print.log");
  const { app, window } = await start({
    env: { MATTERS_SEED: "1", MATTERS_TEST_PRINT_LOG: log },
  });
  await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();

  // One thread open: both items of the File menu are on, with ⌘P on Print….
  await openShop(window);
  if (mac) {
    await expect.poll(async () => (await fileItem(app, "Print…"))?.enabled).toBe(true);
    expect((await fileItem(app, "Save as PDF…"))?.enabled).toBe(true);
    expect((await fileItem(app, "Print…"))?.accelerator).toBe("CmdOrCtrl+P");
  }

  const before = await windowIds(app);
  if (mac) await fileItem(app, "Print…", true);
  else {
    const thread = window.getByRole("region", { name: "Thread" });
    await thread.getByRole("button", { name: "More actions" }).click();
    await window.getByRole("menuitem", { name: /Print/ }).click();
  }
  await expect.poll(() => existsSync(log), { timeout: 30_000 }).toBe(true);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls).toHaveLength(1);
  const { window: printed } = JSON.parse(calls[0] ?? "{}") as { window?: number };
  // Not the mail window: the print view's own, which no longer exists.
  expect(typeof printed).toBe("number");
  expect(before).not.toContain(printed);
  await expect.poll(() => windowIds(app)).toEqual(before);
  await expect(window.locator("[data-print-problem]")).toHaveCount(0);

  // Several rows chosen (ADR 0056): the reader shows the pile, and both items are off.
  const options = window.getByRole("listbox", { name: "Messages" }).getByRole("option");
  await options.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(window.locator("[data-thread-stack]")).toBeVisible();
  if (mac) {
    await expect.poll(async () => (await fileItem(app, "Print…"))?.enabled).toBe(false);
    expect((await fileItem(app, "Save as PDF…"))?.enabled).toBe(false);
  }
  // The pile has no More menu with Print… in it.
  await expect(window.getByRole("menuitem", { name: /Print/ })).toHaveCount(0);
});
