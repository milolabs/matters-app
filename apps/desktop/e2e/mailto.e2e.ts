// `mailto:` links (ADR 0143) on the demo mailbox: a link opens a new message with its fields and
// nothing is sent; links in a row open one after the other; a link that starts the app waits for
// the mail; a mail link in a message opens here; Settings › About says what this build can do.
//
// A link is delivered as macOS delivers it to a running app, as the `open-url` event of Electron's
// `app`, emitted in main through Playwright: the handler the app registers is the one that runs,
// and the app has no test hook for it. The default mail app is never asked for on this machine: a
// build that is not packaged has no client, and the test of the button uses the stand-in of
// `MATTERS_TEST_DEFAULT_MAIL=1`, which only remembers the press.
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const demo = { env: { MATTERS_SEED: "1" } };

async function deliver(app: ElectronApplication, href: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit("open-url", { preventDefault() {} }, url);
  }, href);
}

async function mailShown(window: Page): Promise<void> {
  await expect(
    window.getByRole("listbox", { name: "Messages" }).getByRole("option").first(),
  ).toBeVisible();
}

const composerOf = (window: Page) => window.locator("[data-composer]");

test("a mailto: link opens a new message with its fields, and nothing is sent", async ({
  start,
}, testInfo) => {
  const { app, window } = await start(demo);
  await mailShown(window);

  await deliver(
    app,
    "mailto:ola@example.test,not-an-address,jan@example.test" +
      "?cc=anna@example.test&bcc=kopia@example.test" +
      "&subject=Spotkanie%0D%0ABcc:%20spy@example.net" +
      "&body=Dzie%C5%84%20dobry%2C%0A%0A%21%5B%5D%28https%3A%2F%2Ftracker.example%2Fp.gif%29" +
      "&attach=%2Fetc%2Fhosts&from=boss@example.net",
  );

  const composer = composerOf(window);
  await expect(composer).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath("mailto-composer.png") });
  // The composer shows the last address of a field as text still being typed, as it does for
  // every message it opens filled in; the ones before it are chips.
  await expect(composer.getByTitle("ola@example.test", { exact: true })).toBeVisible();
  await expect(composer.getByRole("combobox", { name: "To" })).toHaveValue("jan@example.test");
  await expect(composer.getByRole("combobox", { name: "Cc", exact: true })).toHaveValue(
    "anna@example.test",
  );
  await expect(composer.getByRole("combobox", { name: "Bcc" })).toHaveValue("kopia@example.test");
  await expect(composer.getByText("not-an-address")).toHaveCount(0);
  await expect(composer.getByText("spy@example.net")).toHaveCount(0);
  await expect(composer.getByText("boss@example.net")).toHaveCount(0);
  await expect(composer.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Spotkanie Bcc: spy@example.net",
  );
  const text = composer.getByRole("textbox", { name: "Message" });
  await expect(text).toContainText("Dzień dobry,");
  await expect(text).toContainText("tracker.example/p.gif");
  // No file came with it, no image is shown, and the text is where the person writes next.
  await expect(composer.getByText("hosts")).toHaveCount(0);
  await expect(composer.locator("img")).toHaveCount(0);
  await expect(text).toBeFocused();
  // Nothing is sent: no send waits in the tray, and closing an untouched message leaves nothing.
  await expect(window.locator("[data-tray]")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);
  await expect(window.locator("[data-tray]")).toHaveCount(0);
});

test("links in a row open one message after the other", async ({ start }) => {
  const { app, window } = await start(demo);
  await mailShown(window);
  for (const n of [1, 2, 3]) await deliver(app, `mailto:ola@example.test?subject=Link%20${n}`);

  const composer = composerOf(window);
  const subject = composer.getByRole("textbox", { name: "Subject" });
  // Closing one opens the next at once, so the composer may never be seen gone between them.
  for (const n of [1, 2, 3]) {
    await expect(subject).toHaveValue(`Link ${n}`);
    await window.keyboard.press("Escape");
  }
  await expect(composer).toHaveCount(0);
  // A link without an address starts in To.
  await deliver(app, "mailto:?subject=Bez%20adresu");
  await expect(subject).toHaveValue("Bez adresu");
  await expect(composer.getByRole("combobox", { name: "To" })).toBeFocused();
});

test("a link that starts the app opens its message once the mail is shown", async ({ start }) => {
  const { window } = await start({
    ...demo,
    args: ["mailto:ola@example.test?subject=Od%20pocz%C4%85tku"],
  });
  await mailShown(window);
  const composer = composerOf(window);
  await expect(composer.getByRole("textbox", { name: "Subject" })).toHaveValue("Od początku");
  await expect(composer.getByRole("combobox", { name: "To" })).toHaveValue("ola@example.test");
});

test("a mail link in a message opens a new message here", async ({ start }) => {
  const { window } = await start(demo);
  await mailShown(window);
  // What a click on a link in a message hands to main after the reader's checks (ADR 0048).
  await window.evaluate((href) => {
    const page = globalThis as unknown as { postMessage(message: unknown, origin: string): void };
    page.postMessage({ mattersOpenLink: href }, "*");
  }, "mailto:x@example.org?attach=/etc/hosts&subject=a%0d%0aBcc:%20spy@example.net");
  const composer = composerOf(window);
  await expect(composer.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "a Bcc: spy@example.net",
  );
  await expect(composer.getByRole("combobox", { name: "To" })).toHaveValue("x@example.org");
  // No Cc or Bcc came with it, so they stay folded away.
  await expect(composer.getByText("Cc / Bcc")).toBeVisible();
});

async function openAbout(app: ElectronApplication, window: Page): Promise<Page> {
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  await settings
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "About" })
    .click();
  return settings;
}

test("Settings › About says a dev build cannot be the default mail app", async ({
  start,
}, testInfo) => {
  const { app, window } = await start(demo);
  await mailShown(window);
  const settings = await openAbout(app, window);
  const row = settings.locator("[data-default-mail]");
  await expect(row.getByRole("heading", { name: "Default mail app" })).toBeVisible();
  await expect(row.getByText("This build cannot be the default mail app.")).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(0);
  await settings.screenshot({ path: testInfo.outputPath("default-mail-dev.png") });
});

test("the button asks for the default only when pressed, and the row then says how to change it", async ({
  start,
}, testInfo) => {
  const { app, window } = await start({ env: { ...demo.env, MATTERS_TEST_DEFAULT_MAIL: "1" } });
  await mailShown(window);
  const settings = await openAbout(app, window);
  const row = settings.locator("[data-default-mail]");
  const button = row.getByRole("button", { name: "Make Matters the default mail app" });
  await expect(button).toBeVisible();
  await expect(row.getByText("macOS may ask you to confirm.", { exact: false })).toBeVisible();
  await settings.screenshot({ path: testInfo.outputPath("default-mail-offered.png") });
  await button.click();
  await expect(row.getByText("Matters is the default mail app.")).toBeVisible();
  await expect(row.getByText("General › Default email reader", { exact: false })).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(0);
  await settings.screenshot({ path: testInfo.outputPath("default-mail-default.png") });
});
