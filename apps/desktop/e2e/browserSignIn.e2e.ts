// Browser sign-in for Microsoft mail (ADR 0133) in a real window, without Docker. The
// authorization server is the stand-in of packages/testkit on this machine, and main plays the
// browser against it (`MATTERS_TEST_OAUTH_BROWSER`, a dev build's test hook that works only with a
// loopback authority). What these tests cannot do is sign in to Microsoft's mail servers: an
// account whose servers are Microsoft's would connect to them, so no test here gets past the
// handle. That part runs in apps/desktop/test/browserSignIn.test.ts against fake servers.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import {
  type StandInAuthServer,
  startStandInAuthServer,
} from "../../../packages/testkit/src/authServer.ts";
import { expect, test } from "./fixtures.ts";

const SHOTS = process.env.MATTERS_E2E_SHOTS;

let auth: StandInAuthServer;
test.beforeEach(async () => {
  auth = await startStandInAuthServer();
});
test.afterEach(async () => {
  await auth.stop();
});

/** The environment of a build that offers Microsoft's sign-in, against the stand-in. */
const offered = (browser: "wait" | "follow") => ({
  MATTERS_MICROSOFT_CLIENT_ID: auth.clientId,
  MATTERS_TEST_OAUTH_AUTHORITY: auth.authority,
  MATTERS_TEST_OAUTH_BROWSER: browser,
});

/**
 * A build without a registration, whatever this one was built with: an empty variable would fall
 * back to the id built in (rule 4), so the dev build's own seam says "none".
 */
const noRegistration = { MATTERS_TEST_NO_CLIENT_ID: "1" };

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // After the steps' fade-in, so the picture is what a person sees.
  // The busy mark's motion never ends, so only the animations that do are waited for.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/**
 * The first-run form with an address nobody publishes settings for, and Microsoft's servers
 * typed by hand under *Another mail server* (ADR 0135, rule 3): the lookup is not needed to reach
 * the step, and a Microsoft mailbox typed in by server name signs in to IMAP (ADR 0133).
 */
async function microsoftByHand(window: Page) {
  const form = window.getByRole("form", { name: "Add account" });
  await form.getByRole("textbox", { name: "Email address" }).fill("me@contoso.invalid");
  await form.getByRole("button", { name: /Continue/ }).click();
  await expect(
    form.getByRole("heading", { name: "We couldn't find the servers for contoso.invalid." }),
  ).toBeVisible({ timeout: 60_000 });
  await form.getByRole("radio", { name: /Another mail server/ }).check();
  await form.getByLabel("Incoming server (IMAP)").fill("outlook.office365.com");
  await form.getByLabel("Outgoing server (SMTP)").fill("smtp.office365.com");
  return form;
}

test("a Microsoft server asks for a sign-in in the browser, which can be cancelled", async ({
  start,
}) => {
  const { window } = await start({ env: offered("wait") });
  const form = await microsoftByHand(window);
  const signIn = form.getByRole("button", { name: /^Sign in with Microsoft/ });
  await expect(signIn).toBeVisible();
  await expect(form.getByLabel("Password for me@contoso.invalid")).toHaveCount(0);
  await expect(
    form.getByText(
      "Your browser opens at Microsoft's sign-in page for me@contoso.invalid. Matters never sees your password there.",
    ),
  ).toBeVisible();
  await signIn.scrollIntoViewIfNeeded();
  await shot(window, "setup-sign-in-idle");

  await signIn.click();
  await expect(form.getByRole("button", { name: "Waiting for your browser…" })).toBeDisabled();
  await expect(
    form.getByText(
      "Waiting for you to sign in to me@contoso.invalid in your browser. Matters comes back to the front when you're done.",
    ),
  ).toBeVisible();
  await shot(window, "setup-sign-in-waiting");

  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(signIn).toBeEnabled();
  // Cancelled by the person: nothing to explain.
  await expect(form.getByRole("alert")).toHaveCount(0);
});

test("what Microsoft said in the browser comes back as a sentence (rule 12)", async ({ start }) => {
  const { window } = await start({ env: offered("follow") });
  const form = await microsoftByHand(window);
  const signIn = form.getByRole("button", { name: /^Sign in with Microsoft/ });

  // Another account signed in than the one typed: both are named, nothing is kept.
  auth.signInAs = { email: "jan@contoso.example" };
  await signIn.click();
  await expect(form.getByRole("alert")).toContainText(
    "You signed in as jan@contoso.example, not me@contoso.invalid. Nothing was saved. Try again and choose me@contoso.invalid.",
  );
  expect(auth.requests.some((r) => r.params.grant_type === "authorization_code")).toBe(true);

  // An organisation that keeps its people from agreeing: Microsoft's words under the sentence.
  auth.authorizeError = {
    error: "access_denied",
    description: "AADSTS65001: The user or administrator has not consented to use the application.",
  };
  await signIn.click();
  const alert = form.getByRole("alert");
  await expect(alert).toContainText(
    "Your organisation has to approve Matters before you can sign in. Ask an administrator of your organisation to approve it, then try again.",
  );
  await expect(alert).toContainText("Microsoft said: “AADSTS65001");
  await shot(window, "setup-sign-in-admin-approval");
});

test("without a client id, a Microsoft server still takes no password, as before", async ({
  start,
}) => {
  const { window } = await start({ env: noRegistration });
  const form = await microsoftByHand(window);
  await expect(form.getByRole("button", { name: /Sign in with Microsoft/ })).toHaveCount(0);
  await expect(form.getByLabel("Password for me@contoso.invalid")).toBeVisible();
  await expect(
    form.getByText(
      "Microsoft takes only browser sign-in from mail apps, which Matters can't do yet. A password won't work there.",
    ),
  ).toBeVisible();
});

/**
 * Microsoft's own address, looked up as a person's would be: through DNS and the settings
 * databases on the internet. Offline the lookup finds nothing, and the test says so and skips.
 */
async function microsoftLookedUp(window: Page) {
  const form = window.getByRole("form", { name: "Add account" });
  await form.getByRole("textbox", { name: "Email address" }).fill("me@outlook.com");
  await form.getByRole("button", { name: /Continue/ }).click();
  const notFound = form.getByRole("heading", { name: /We couldn't find the servers/ });
  const settled = form
    .getByRole("heading", { name: /Microsoft|outlook\.com/ })
    .or(notFound)
    .first();
  await expect(settled).toBeVisible({ timeout: 60_000 });
  test.skip(await notFound.isVisible(), "the server lookup found nothing (offline?)");
  return form;
}

test("a Microsoft address in setup shows the sign-in step when a client id is set", async ({
  start,
}) => {
  const { window } = await start({ env: offered("wait") });
  const form = await microsoftLookedUp(window);
  await expect(form.getByRole("heading", { name: "Now sign in with Microsoft." })).toBeVisible();
  await expect(form.getByRole("button", { name: /^Sign in with Microsoft/ })).toBeVisible();
  await expect(form.getByLabel("Password for me@outlook.com")).toHaveCount(0);
  await shot(window, "setup-sign-in-found");
});

test("a Microsoft address in setup shows the old blocked screen without a client id", async ({
  start,
}) => {
  const { window } = await start({ env: noRegistration });
  const form = await microsoftLookedUp(window);
  await expect(
    form.getByRole("heading", {
      name: "outlook.com is on Microsoft's mail, which needs browser sign-in.",
    }),
  ).toBeVisible();
  await expect(
    form.getByText(
      "Matters can't do that yet, and Microsoft doesn't take passwords from mail apps there. Try another address for now, or enter the servers if your admin gave you a different way in.",
    ),
  ).toBeVisible();
  await expect(form.getByRole("button", { name: "Use another address" })).toBeVisible();
  await expect(form.getByRole("button", { name: /Sign in with Microsoft/ })).toHaveCount(0);
});

test("an account on Microsoft's servers has Sign in again in Settings › Accounts", async ({
  start,
  dataDir,
}) => {
  // The demo mailbox, its account moved to Microsoft's servers between two starts. It has no
  // saved sign-in, so nothing ever connects to them.
  const first = await start({ env: { MATTERS_SEED: "1" } });
  await expect(first.window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  await first.close();
  const db = new DatabaseSync(join(dataDir, "matters.db"));
  db.exec(`UPDATE accounts SET imap_host = 'outlook.office365.com', imap_port = 993,
    imap_security = 'tls', smtp_host = 'smtp.office365.com', smtp_port = 587,
    smtp_security = 'starttls'`);
  db.close();

  const { app, window } = await start({ env: { MATTERS_SEED: "1", ...offered("wait") } });
  await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  const accounts = settings.getByRole("region", { name: "Accounts" });
  await expect(accounts.getByText("outlook.office365.com:993")).toBeVisible();
  const again = accounts.getByRole("button", { name: /^Sign in again/ });
  await expect(again).toBeVisible();
  await expect(accounts.getByRole("button", { name: /Change password/ })).toHaveCount(0);
  await shot(settings, "accounts-sign-in-again-row");

  // The same key as Change password, in the same place.
  await accounts.getByText("outlook.office365.com:993").click();
  await settings.keyboard.press("p");
  const form = accounts.getByRole("form", { name: /^Sign in again to / });
  await expect(form.getByRole("button", { name: "Sign in with Microsoft" })).toBeVisible();
  await shot(settings, "accounts-sign-in-again-form");
  await form.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(form.getByRole("button", { name: "Waiting for your browser…" })).toBeDisabled();
  await shot(settings, "accounts-sign-in-again-waiting");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Sign in with Microsoft" })).toBeEnabled();
  await expect(form.getByRole("alert")).toHaveCount(0);
  // Escape closes it, as it closes the password form.
  await settings.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});
