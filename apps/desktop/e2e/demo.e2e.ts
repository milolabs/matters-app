// The main screens on the demo mailbox (`MATTERS_SEED=1`): about 430 threads written by the seed,
// no server and no Docker. Each test starts its own app on an empty data folder, which the seed fills.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type Running, test } from "./fixtures.ts";

const demo = { env: { MATTERS_SEED: "1" } };

test("a thread opens and reads", async ({ start }) => {
  const { window } = await start(demo);
  const list = window.getByRole("listbox", { name: "Messages" });
  await list.getByRole("option", { name: /PKP Intercity/ }).click();

  const thread = window.getByRole("region", { name: "Thread" });
  await expect(thread.getByRole("heading", { level: 2 })).toHaveText("Załączniki: trzy pliki");
  await expect(thread.getByText("Bilet, regulamin i faktura.")).toBeVisible();
  // Its three files are listed under the text.
  for (const file of ["Bilet.pdf", "Regulamin przewozu.pdf", "Faktura.pdf"]) {
    await expect(thread.getByText(file)).toBeVisible();
  }
});

test("the query bar finds a message by a word of its subject", async ({ start }) => {
  const { window } = await start(demo);
  const list = window.getByRole("listbox", { name: "Messages" });
  await expect(list.getByRole("option", { name: /PKP Intercity/ })).toBeVisible();

  const search = window.getByRole("combobox", { name: "Search mail" });
  await search.click();
  await search.pressSequentially("piksel");
  await search.press("Enter");

  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option").first()).toContainText("Zdjęcia: tylko piksel śledzący");
});

test("j and k walk the list", async ({ start }) => {
  const { window } = await start(demo);
  const thread = window.getByRole("region", { name: "Thread" });
  const options = window.getByRole("listbox", { name: "Messages" }).getByRole("option");
  await options.first().click();
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  const first = await thread.getByRole("heading", { level: 2 }).textContent();

  await window.keyboard.press("j");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(thread.getByRole("heading", { level: 2 })).not.toHaveText(first ?? "");

  await window.keyboard.press("k");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(thread.getByRole("heading", { level: 2 })).toHaveText(first ?? "");
});

test("settings open in a window of their own", async ({ start }) => {
  const { app, window } = await start(demo);
  await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
  const accounts = settings.getByRole("region", { name: "Accounts" });
  await expect(accounts.getByRole("heading", { name: "Accounts" })).toBeVisible();
  // The demo account, on its made-up server.
  await expect(accounts.getByText("imap.demo.invalid:143")).toBeVisible();

  await settings.getByRole("button", { name: "Storage" }).click();
  await expect(settings.getByRole("heading", { name: "Storage" })).toBeVisible();
});

test("the background limit takes a preset, no limit or a number of the person's own", async ({
  start,
}, testInfo) => {
  const { app, window } = await start(demo);
  await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  await settings.getByRole("button", { name: "Agents" }).click();
  const limit = settings.getByLabel("Background limit");
  await expect(limit.locator("option")).toHaveText([
    "Up to 5% of my week",
    "Up to 10% of my week",
    "Up to 25% of my week",
    "Up to 50% of my week",
    "No limit",
    "Custom…",
  ]);
  // The log of closings is kept, and no longer shown here (ADR 0131).
  await expect(settings.getByText("What the agent did")).toHaveCount(0);

  await limit.selectOption({ label: "No limit" });
  await expect(
    settings.getByText("Runs until the plan's limit, then waits for the reset."),
  ).toBeVisible();
  await expect(limit).toHaveValue("none");

  await limit.selectOption({ label: "Custom…" });
  const own = settings.getByLabel("Percent of my week, 1 to 99");
  await own.fill("40");
  await own.press("Enter");
  await settings.screenshot({ path: testInfo.outputPath("limit.png") });
  // What was stored, not what was typed: the page is read again from the backend.
  const readAgain = async () => {
    await settings.reload();
    await settings.getByRole("button", { name: "Agents" }).click();
  };
  await expect(async () => {
    await readAgain();
    await expect(limit).toHaveValue("custom", { timeout: 2_000 });
    await expect(own).toHaveValue("40", { timeout: 2_000 });
  }).toPass();

  // A number out of range is not sent: the stored share stays.
  await own.fill("250");
  await own.press("Enter");
  await readAgain();
  await expect(limit).toHaveValue("custom");
  await expect(own).toHaveValue("40");

  // A preset closes the field and is stored too.
  await limit.selectOption({ label: "Up to 25% of my week" });
  await expect(own).toHaveCount(0);
  await expect(async () => {
    await readAgain();
    await expect(limit).toHaveValue("25", { timeout: 2_000 });
  }).toPass();
});

test("the agent writes in a new message as the person asks", async ({ start }) => {
  const { app, window } = await start(demo);
  const list = window.getByRole("listbox", { name: "Messages" });
  await expect(list.getByRole("option", { name: /PKP Intercity/ })).toBeVisible();
  // AI is off until the person turns it on, for the demo runtime here.
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  await settings.getByRole("button", { name: "Agents" }).click();
  await settings.getByRole("button", { name: "Check" }).click();
  // The first choice puts every kind of work on the demo assistant, the only one a demo run lists.
  const unset = settings
    .locator("select")
    .filter({ has: settings.locator("option", { hasText: "Choose…" }) });
  await unset.first().selectOption({ index: 1 });
  await expect(unset).toHaveCount(0);
  await settings.getByRole("button", { name: "Turn AI on" }).click();
  // "Shall I read your mail?": the person agrees for the demo account.
  await settings.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Turn AI off" })).toBeVisible();
  await settings.close();
  await list.getByRole("option", { name: /PKP Intercity/ }).click();
  await window.keyboard.press("c");

  const composer = window.locator("[data-composer]");
  await expect(composer).toBeVisible();
  const text = composer.getByRole("textbox", { name: "Message" });
  await text.click();

  // ⌘J opens the menu with the field in focus; a new message has nothing "from the conversation".
  // The window hears that AI is on a moment after Settings said so.
  await expect(composer.getByRole("button", { name: /Agent/ })).toBeVisible();
  await window.keyboard.press("ControlOrMeta+j");
  const menu = composer.getByRole("menu", { name: "The agent" });
  const field = menu.getByRole("textbox", { name: "Tell the agent what to write or change" });
  await expect(field).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Shorter" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Fill in the placeholders" })).toHaveCount(0);

  // Letters typed in the field are words, not the window's shortcuts ("c" opens no second composer).
  await field.pressSequentially("write an invitation to the code review");
  await expect(field).toHaveValue("write an invitation to the code review");
  await field.press("Enter");

  await expect(menu).toHaveCount(0);
  await expect(text).toContainText("About an invitation to the code review: on [date], at [time].");
  const note = composer.getByText("The agent wrote it as you asked.");
  await expect(note).toBeVisible();

  // Undo gives the text back as it was: empty.
  await composer.getByRole("button", { name: "Undo" }).click();
  await expect(text).not.toContainText("About an invitation");

  // Esc in the menu closes the menu, not the composer.
  await window.keyboard.press("ControlOrMeta+j");
  await expect(menu).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toBeVisible();
});

const darkScheme = (page: Page) =>
  page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
const openAppearance = async (running: Running) => {
  await expect(running.window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    running.app.waitForEvent("window"),
    running.window.getByRole("button", { name: "Settings" }).click(),
  ]);
  await settings.getByRole("button", { name: "Appearance" }).click();
  return settings.getByRole("region", { name: "Appearance" });
};
/** The ground a page paints and the `--bg` its root element has, as the page computes them. */
const ground = (page: Page) =>
  page.evaluate(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    body: getComputedStyle(document.body).backgroundColor,
  }));
/** Every window's own colour before its page paints (ADR 0134, rule 9). */
const windowGrounds = (running: Running) =>
  running.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.getBackgroundColor().toLowerCase()),
  );

test("the appearance is chosen in Settings, reaches the mail window and survives a restart", async ({
  start,
  dataDir,
}) => {
  const file = join(dataDir, "userData", "appearance.json");

  const first = await start(demo);
  const section = await openAppearance(first);
  const useDefault = section.getByRole("button", { name: "Use default" });
  await expect(section.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(useDefault).toBeDisabled();

  // Light first, so Dark is a change whatever the system of the machine running this is.
  await section.getByRole("radio", { name: "Light" }).check();
  await expect.poll(() => darkScheme(first.window)).toBe(false);
  await section.getByRole("radio", { name: "Dark" }).check();
  await expect.poll(() => darkScheme(first.window)).toBe(true);
  await expect(useDefault).toBeEnabled();
  await first.close();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mode: "dark" });

  // The next start opens dark: the page and the window's own ground (ADR 0134, rule 9).
  const second = await start(demo);
  expect(await darkScheme(second.window)).toBe(true);
  expect(await windowGrounds(second)).toEqual(["#1e1e20"]);
  const again = await openAppearance(second);
  await expect(again.getByRole("radio", { name: "Dark" })).toBeChecked();

  // Use default: back to the system, in the file too.
  await again.getByRole("button", { name: "Use default" }).click();
  await expect(again.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(again.getByRole("button", { name: "Use default" })).toBeDisabled();
  const system = await second.app.evaluate(({ nativeTheme }) => ({
    source: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors,
  }));
  expect(system.source).toBe("system");
  await expect.poll(() => darkScheme(second.window)).toBe(system.dark);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mode: "system" });
});

test("Reset Appearance in the View menu reaches an open Settings window", async ({ start }) => {
  test.skip(process.platform !== "darwin", "the app menu is built on macOS only");
  const running = await start(demo);
  await expect(running.window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    running.app.waitForEvent("window"),
    running.window.getByRole("button", { name: "Settings" }).click(),
  ]);
  await settings.getByRole("button", { name: "Appearance" }).click();
  const section = settings.getByRole("region", { name: "Appearance" });
  await section.getByRole("radio", { name: "Dark" }).check();
  await section.getByRole("radio", { name: /^Night/ }).check();
  // Main has it (the menu below does not wait for the page's ask).
  await expect(section.getByText("Night has dark colours only")).toBeVisible();

  // The menu item a person would choose, clicked as the menu does it.
  await running.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("reset-appearance");
    if (!item?.enabled) throw new Error("Reset Appearance is not in the menu, or is off");
    item.click();
  });
  await expect(section.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(section.getByRole("radio", { name: /^Matters/ })).toBeChecked();
  await expect(section.getByRole("button", { name: "Use default" })).toBeDisabled();
  expect(await running.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
  const item = await running.app.evaluate(({ Menu }) => {
    const reset = Menu.getApplicationMenu()?.getMenuItemById("reset-appearance");
    return { enabled: reset?.enabled, keys: reset?.accelerator };
  });
  expect(item).toEqual({ enabled: false, keys: "CmdOrCtrl+Alt+Shift+0" });
});

test("a built-in theme reaches both windows, and one with one set fixes the mode", async ({
  start,
  dataDir,
}) => {
  const running = await start(demo);
  const section = await openAppearance(running);
  const settings = section.page();
  const both = async () => [await ground(running.window), await ground(settings)];

  await section.getByRole("radio", { name: "Light" }).check();
  await section.getByRole("radio", { name: /^Paper/ }).check();
  const paperLight = { bg: "#fbf9f4", body: "rgb(251, 249, 244)" };
  await expect.poll(both).toEqual([paperLight, paperLight]);
  expect(await windowGrounds(running)).toEqual(["#fbf9f4", "#fbf9f4"]);

  // Both sets: the mode stays free, and the dark set follows it.
  await section.getByRole("radio", { name: "Dark" }).check();
  const paperDark = { bg: "#1f1d1a", body: "rgb(31, 29, 26)" };
  await expect.poll(both).toEqual([paperDark, paperDark]);

  // Dark only (rule 7): the app is dark whatever the mode says, and Mode says why.
  await section.getByRole("radio", { name: "Light" }).check();
  await section.getByRole("radio", { name: /^Night/ }).check();
  const night = { bg: "#141416", body: "rgb(20, 20, 22)" };
  await expect.poll(both).toEqual([night, night]);
  expect(await darkScheme(running.window)).toBe(true);
  expect(await darkScheme(settings)).toBe(true);
  await expect(section.getByRole("radio", { name: "Light" })).toBeDisabled();
  await expect(section.getByRole("radio", { name: "Light" })).toBeChecked();
  await expect(section.getByText("Night has dark colours only")).toBeVisible();
  expect(await windowGrounds(running)).toEqual(["#141416", "#141416"]);
  await running.close();
  expect(JSON.parse(readFileSync(join(dataDir, "userData", "appearance.json"), "utf8"))).toEqual({
    mode: "light",
    theme: "night",
  });

  // A restart starts in the theme: the window's own colour, and the root's values from the
  // preload, as soon as the harness can look (before the app's UI may be up).
  const again = await start(demo);
  const early = await again.window.evaluate(() => ({
    bg: document.documentElement.style.getPropertyValue("--bg"),
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    ui: document.querySelector('[role="listbox"]') !== null,
  }));
  expect(early).toMatchObject({ bg: "#141416", dark: true });
  expect(await windowGrounds(again)).toEqual(["#141416"]);
  await expect.poll(() => ground(again.window)).toEqual(night);
  // The way back clears the theme too: Use default is mode System and no theme.
  const back = await openAppearance(again);
  await expect(back.getByRole("radio", { name: /^Night/ })).toBeChecked();
  await back.getByRole("button", { name: "Use default" }).click();
  await expect(back.getByRole("radio", { name: /^Matters/ })).toBeChecked();
  await expect(back.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(back.getByRole("radio", { name: "System" })).toBeEnabled();
  await expect(back.getByRole("button", { name: "Use default" })).toBeDisabled();
  expect(
    await again.window.evaluate(() => document.documentElement.style.getPropertyValue("--bg")),
  ).toBe("");
  expect(JSON.parse(readFileSync(join(dataDir, "userData", "appearance.json"), "utf8"))).toEqual({
    mode: "system",
  });
});

test("own themes in the data folder are checked and put on, a broken chosen one falls back, and no file is offered", async ({
  start,
  dataDir,
}, testInfo) => {
  // Appearance offers no way to add a file (ADR 0134, rule 12): a theme is described there. A file
  // put into `themes/` by hand is still read and checked, so the test places them before start.
  const userData = join(dataDir, "userData");
  const themes = join(userData, "themes");
  mkdirSync(themes, { recursive: true });
  const moss = "own-0123456789ab";
  const mossFile = join(themes, `${moss}.json`);
  writeFileSync(
    mossFile,
    JSON.stringify({ name: "Moss", dark: { bg: "#18201a", chrome: "#1d261f", fill: "#243026" } }),
  );
  // Pale ink on a pale ground, and a colour that is not a colour: neither passes, neither is listed.
  writeFileSync(
    join(themes, "own-0123456789ac.json"),
    JSON.stringify({ name: "Faint", light: { ink: "#cccccc" } }),
  );
  writeFileSync(
    join(themes, "own-0123456789ad.json"),
    JSON.stringify({ name: "Sneaky", dark: { bg: "url(https://x.test/a)" } }),
  );
  writeFileSync(join(userData, "appearance.json"), JSON.stringify({ mode: "system", theme: moss }));

  const running = await start(demo);
  const section = await openAppearance(running);
  await expect(section.getByRole("radio", { name: /^Moss/ })).toBeChecked();
  await expect(section.getByRole("radio", { name: /^Faint/ })).toHaveCount(0);
  await expect(section.getByRole("radio", { name: /^Sneaky/ })).toHaveCount(0);
  await expect
    .poll(() => ground(running.window))
    .toEqual({ bg: "#18201a", body: "rgb(24, 32, 26)" });
  await expect(section.getByRole("button", { name: "Remove the theme Moss" })).toBeVisible();
  // No file import, and no word of the format a person should not have to know.
  await expect(section.locator('input[type="file"]')).toHaveCount(0);
  await expect(section.getByRole("button", { name: /file/i })).toHaveCount(0);
  await expect(section).not.toContainText(/JSON|file|hex/i);
  await running.close();

  // The file is damaged while the app is closed: the next start is in the default, and says why.
  writeFileSync(mossFile, '{"name": "Moss", "dark": {"bg": ');
  const again = await start(demo);
  expect(await windowGrounds(again)).not.toContain("#18201a");
  expect(
    await again.window.evaluate(() => document.documentElement.style.getPropertyValue("--bg")),
  ).toBe("");
  const back = await openAppearance(again);
  await expect(back.getByRole("status")).toContainText(
    "The theme you chose was refused: The theme is not JSON.",
  );
  await expect(back.getByRole("status")).toContainText("Matters started in the default.");
  await expect(back.getByRole("radio", { name: /^Matters/ })).toBeChecked();
  await expect(back.getByRole("radio", { name: /^Moss/ })).toHaveCount(0);
  // Something was chosen, so Use default has something to undo.
  await expect(back.getByRole("button", { name: "Use default" })).toBeEnabled();
  await back.getByRole("button", { name: "Use default" }).click();
  await expect(back.getByRole("status")).toHaveCount(0);
  await expect(back.getByRole("button", { name: "Use default" })).toBeDisabled();
  // The section as a person meets it: the default theme, no own theme, AI off.
  await back.page().screenshot({ path: testInfo.outputPath("appearance.png") });
});

test("the reset keys reach main from any window and clear mode and theme", async ({ start }) => {
  const running = await start(demo);
  const section = await openAppearance(running);
  const press = (title: string) =>
    running.app.evaluate(
      ({ BrowserWindow }, { title, mac }) => {
        // Through the window's input, as a key press is: Playwright's own keys bypass main.
        const target = BrowserWindow.getAllWindows().find((w) => w.getTitle() === title);
        const modifiers = [mac ? "meta" : "control", "alt", "shift"] as const;
        target?.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "0",
          modifiers: [...modifiers],
        });
        target?.webContents.sendInputEvent({
          type: "keyUp",
          keyCode: "0",
          modifiers: [...modifiers],
        });
      },
      { title, mac: process.platform === "darwin" },
    );
  for (const title of ["Matters", "Settings"]) {
    await section.getByRole("radio", { name: "Dark" }).check();
    await section.getByRole("radio", { name: /^Paper/ }).check();
    await expect.poll(() => ground(running.window)).toMatchObject({ bg: "#1f1d1a" });
    await press(title);
    await expect(section.getByRole("radio", { name: "System" })).toBeChecked();
    await expect(section.getByRole("radio", { name: /^Matters/ })).toBeChecked();
    await expect(section.getByRole("button", { name: "Use default" })).toBeDisabled();
    expect(
      await running.window.evaluate(() => document.documentElement.style.getPropertyValue("--bg")),
    ).toBe("");
  }
});

/** AI on for the demo assistant, every kind of work on it, as a person turns it on in Agents. */
const turnAiOn = async (settings: Page) => {
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await settings.getByRole("button", { name: "Check" }).click();
  const unset = settings
    .locator("select")
    .filter({ has: settings.locator("option", { hasText: "Choose…" }) });
  await unset.first().selectOption({ index: 1 });
  await expect(unset).toHaveCount(0);
  await settings.getByRole("button", { name: "Turn AI on" }).click();
  await settings.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Turn AI off" })).toBeVisible();
};

test("a theme is made from a description, checked, and asked for once more when it fails", async ({
  start,
}, testInfo) => {
  const running = await start(demo);
  await expect(running.window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    running.app.waitForEvent("window"),
    running.window.getByRole("button", { name: "Settings" }).click(),
  ]);
  // Without AI the section works, and the field says what is missing and where.
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  const section = settings.getByRole("region", { name: "Appearance" });
  const field = section.getByRole("textbox", { name: "Describe a theme" });
  await expect(field).toBeDisabled();
  await expect(section.getByRole("button", { name: "Make theme" })).toBeDisabled();
  await expect(section.locator("[data-theme-maker-line]")).toContainText(
    "AI is off. Turn it on in Settings › Agents",
  );
  await expect(section.getByRole("radio", { name: /^Paper/ })).toBeVisible();

  // Agents lists the fifth kind with the others, on the runtime writing has.
  await turnAiOn(settings);
  const row = settings.locator('[data-kind="appearance"]');
  await expect(row).toContainText("Appearance");
  await expect(row).toContainText("No mail goes with it.");
  await expect(row.getByLabel("Appearance, assistant")).toHaveValue("claude-code");
  await expect(row.getByLabel("Appearance, model")).toHaveValue("sonnet");

  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(section.locator("[data-theme-maker-line]")).toContainText(
    "Made by Demo assistant, Sonnet, your plan.",
  );
  // The way to Agents from the line, and back.
  await section.getByRole("button", { name: "Change in Agents" }).click();
  await expect(settings.getByRole("region", { name: "Agents" })).toBeVisible();
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();

  // A valid answer: listed under the agent's name, on at once, in both windows.
  await field.fill("a calm forest at night");
  await section.getByRole("button", { name: "Make theme" }).click();
  await expect(section.getByRole("radio", { name: /^Forest/ })).toBeChecked();
  await expect(section.getByRole("status").filter({ hasText: "Forest was added" })).toBeVisible();
  await expect(field).toHaveValue("");
  const forest = { bg: "#132019", body: "rgb(19, 32, 25)" };
  await expect.poll(() => ground(running.window)).toEqual(forest);
  await expect.poll(() => ground(settings)).toEqual(forest);
  expect(await windowGrounds(running)).toEqual(["#132019", "#132019"]);
  // A theme is on, so the field offers to start from it.
  await expect(section.getByRole("checkbox", { name: /Start from Forest/ })).toBeVisible();

  // Fails the contrast check twice: the problems, in the words of the check, and no theme.
  await field.fill("an unreadable swamp");
  await field.press("ControlOrMeta+Enter");
  const alert = section.getByRole("alert");
  await expect(alert).toContainText("The agent's theme was not added, after a second try");
  await expect(alert).toContainText(
    /In dark, the text \(ink\) on the ground \(bg\) is 1\.\d\d:1; it needs 4\.5:1/,
  );
  await expect(section.getByRole("radio", { name: /^Unreadable/ })).toHaveCount(0);
  await expect(section.getByRole("radio", { name: /^Forest/ })).toBeChecked();
  // What was asked stays in the field for another try.
  await expect(field).toHaveValue("an unreadable swamp");

  // Fails once, then passes on the one retry with what failed.
  await field.fill("a faint meadow");
  await section.getByRole("button", { name: "Make theme" }).click();
  await expect(section.getByRole("radio", { name: /^Meadow/ })).toBeChecked();
  await expect(section.getByRole("status").filter({ hasText: "Meadow was added" })).toContainText(
    "asked once more",
  );
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Remove the theme Meadow" })).toBeVisible();
  await section.locator("[data-theme-maker]").scrollIntoViewIfNeeded();
  await settings.screenshot({ path: testInfo.outputPath("theme-maker.png") });
});
