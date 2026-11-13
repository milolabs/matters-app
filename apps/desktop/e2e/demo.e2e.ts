// The main screens on the demo mailbox (`MATTERS_SEED=1`): about 430 threads written by the seed,
// no server and no Docker. Each test starts its own app on an empty data folder, which the seed fills.
import { expect, test } from "./fixtures.ts";

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
