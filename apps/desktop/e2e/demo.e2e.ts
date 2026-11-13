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
