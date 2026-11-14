// Setup finds who runs the mail and the person can say (ADR 0135), and a Microsoft mailbox found
// that way is added over Microsoft Graph (ADR 0136), in a real window, without Microsoft. DNS is
// answered from a table (`MATTERS_TEST_DNS`), the sign-in is the stand-in authorization server
// played through by main (`MATTERS_TEST_OAUTH_*`), and Graph is the stand-in Graph service
// (`MATTERS_TEST_GRAPH_BASE`): all of it on this machine, and only in a dev build (ADR 0130).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  type StandInAuthServer,
  startStandInAuthServer,
} from "../../../packages/testkit/src/authServer.ts";
import {
  type StandInGraphServer,
  startStandInGraphServer,
} from "../../../packages/testkit/src/graphServer.ts";
import { expect, test } from "./fixtures.ts";

const SHOTS = process.env.MATTERS_E2E_SHOTS;
const ADDRESS = "jan@firma.example";

let auth: StandInAuthServer;
let graph: StandInGraphServer;
test.beforeEach(async () => {
  auth = await startStandInAuthServer();
  auth.signInAs = { email: ADDRESS };
  // Graph takes what the stand-in sign-in issued, as it takes Microsoft's tokens.
  graph = await startStandInGraphServer({
    accepts: (token) => auth.accessTokens.includes(token),
  });
});
test.afterEach(async () => {
  await graph.stop();
  await auth.stop();
});

/**
 * firma.example's mail exchanger is Microsoft's; hint.example only sends through Google;
 * slow.example has nothing, after a while.
 */
const DNS = JSON.stringify({
  "firma.example": { mx: ["firma-example.mail.protection.outlook.com"] },
  "hint.example": { txt: ["v=spf1 include:_spf.google.com ~all"] },
  "slow.example": { delayMs: 3_000 },
});

const env = () => ({
  MATTERS_MICROSOFT_CLIENT_ID: auth.clientId,
  MATTERS_TEST_OAUTH_AUTHORITY: auth.authority,
  MATTERS_TEST_OAUTH_BROWSER: "follow",
  MATTERS_TEST_GRAPH_BASE: graph.baseUrl,
  MATTERS_TEST_DNS: DNS,
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // After the fade-ins; the busy mark's motion never ends, so only animations that do are waited.
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

function mime(id: string, subject: string): string {
  return [
    "From: Anna Nowak <anna@northwind.example>",
    `To: ${ADDRESS}`,
    `Subject: ${subject}`,
    "Date: Tue, 03 Nov 2026 10:00:00 +0000",
    `Message-ID: <${id}@northwind.example>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${subject}`,
    "",
  ].join("\r\n");
}

async function lookUp(window: Page, address: string) {
  const form = window.getByRole("form", { name: "Add account" });
  await form.getByRole("textbox", { name: "Email address" }).fill(address);
  await form.getByRole("button", { name: /Continue/ }).click();
  return form;
}

test("a domain found as Microsoft goes through Sign in with Microsoft to a synced mailbox", async ({
  start,
}) => {
  graph.addMessage("inbox", mime("m1", "Quarterly numbers for Matters"));
  graph.addMessage("inbox", mime("m2", "Lunch on Friday"), { isRead: true });
  const { app, window } = await start({ env: env() });
  const form = await lookUp(window, ADDRESS);

  // The line names the provider, not a server (ADR 0135, rule 5); no server fields, no password.
  await expect(form.getByText("Found Microsoft 365 for firma.example")).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByRole("heading", { name: "Now sign in with Microsoft." })).toBeVisible();
  await expect(form.getByLabel("Incoming server (IMAP)")).toHaveCount(0);
  await expect(form.getByLabel(`Password for ${ADDRESS}`)).toHaveCount(0);
  const signIn = form.getByRole("button", { name: /^Sign in with Microsoft/ });
  await expect(signIn).toBeVisible();
  await shot(window, "setup-found-microsoft");

  await signIn.click();
  await expect(form.getByRole("heading", { name: "You're in." })).toBeVisible({ timeout: 60_000 });
  await expect(form.getByText("Signed in to Microsoft, ")).toBeVisible();
  await expect(form.getByText("Sending works through Microsoft")).toBeVisible();
  await expect(form.getByText("Sign-in encrypted with your Mac's keychain")).toBeVisible();
  // The sign-in asked for Graph's scopes (ADR 0136, rule 3).
  const authorize = auth.requests.find((r) => r.path.endsWith("/authorize"));
  expect(authorize?.params.scope).toContain("Mail.ReadWrite");
  await shot(window, "setup-graph-done");

  await form.getByRole("button", { name: /Continue/ }).click();
  await form.getByRole("button", { name: "Use without AI" }).click();
  const list = window.getByRole("listbox", { name: "Messages" });
  await expect(list.getByRole("option", { name: /Quarterly numbers for Matters/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(list.getByRole("option", { name: /Lunch on Friday/ })).toBeVisible();
  // Everything came over Graph: the stand-in was asked for the inbox's delta and the MIME.
  expect(graph.requestsTo("/messages/delta").length).toBeGreaterThan(0);
  expect(graph.requestsTo("/$value").length).toBeGreaterThanOrEqual(2);

  // Settings › Accounts: no servers, Sign in again in place of Change password.
  const [settings] = await Promise.all([
    app.waitForEvent("window"),
    window.getByRole("button", { name: "Settings" }).click(),
  ]);
  const accounts = settings.getByRole("region", { name: "Accounts" });
  await expect(accounts.getByText("Microsoft · signs in through your browser")).toBeVisible();
  await expect(accounts.getByRole("button", { name: /^Sign in again/ })).toBeVisible();
  await expect(accounts.getByRole("button", { name: /Change password/ })).toHaveCount(0);
  // No server and no port in the row: not a real one, and not the empty ones of a Graph account
  // (":0"). The time of the last sync has a colon and digits too ("Synced 21:05").
  await expect(accounts.getByText(/:993(?!\d)|:0(?!\d)/)).toHaveCount(0);
  await shot(settings, "accounts-graph-row");
});

test("Not right? shows who could run the mail, and Another mail server opens the server fields", async ({
  start,
}) => {
  const { window } = await start({ env: env() });
  const form = await lookUp(window, ADDRESS);
  await expect(form.getByText("Found Microsoft 365 for firma.example")).toBeVisible({
    timeout: 30_000,
  });
  const notRight = form.getByRole("button", { name: "Not right?" });
  await notRight.focus();
  await window.keyboard.press("Enter");
  const list = form.getByRole("radiogroup", { name: "Who runs your mail" });
  await expect(list).toBeVisible();
  const radios = list.getByRole("radio");
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toHaveAccessibleName(/^Microsoft 365 or Outlook\.com/);
  await expect(radios.nth(1)).toHaveAccessibleName(/^Google/);
  await expect(radios.nth(2)).toHaveAccessibleName(/^Another mail server/);
  // What was found is the one taken.
  await expect(radios.nth(0)).toBeChecked();
  await expect(form.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
  await shot(window, "setup-who-runs-list");

  // By keyboard: Another mail server opens the fields as before.
  await radios.nth(2).focus();
  await window.keyboard.press("Space");
  await expect(radios.nth(2)).toBeChecked();
  await expect(form.getByLabel("Incoming server (IMAP)")).toBeVisible();
  await expect(form.getByLabel("Outgoing server (SMTP)")).toBeVisible();
  await expect(form.getByRole("button", { name: /^Sign in with Microsoft/ })).toHaveCount(0);
  await shot(window, "setup-another-server");

  // Choosing Microsoft again brings back the sign-in without servers; the choice holds when the
  // same address is looked up again.
  await radios.nth(0).click();
  // A provider takes the list's place: the line says what was chosen.
  await expect(form.getByRole("radiogroup", { name: "Who runs your mail" })).toHaveCount(0);
  await expect(form.getByText("Using Microsoft 365 for firma.example")).toBeVisible();
  await expect(form.getByLabel("Incoming server (IMAP)")).toHaveCount(0);
  await form.getByRole("button", { name: "Change" }).click();
  await form.getByRole("button", { name: /Continue/ }).click();
  await expect(form.getByText("Using Microsoft 365 for firma.example")).toBeVisible({
    timeout: 30_000,
  });
});

test("a hint puts its provider first; nothing found shows the list at once", async ({ start }) => {
  const { window } = await start({ env: env() });
  const form = await lookUp(window, "jan@hint.example");
  await expect(
    form.getByRole("heading", { name: "We couldn't find the servers for hint.example." }),
  ).toBeVisible({ timeout: 30_000 });
  const radios = form.getByRole("radiogroup", { name: "Who runs your mail" }).getByRole("radio");
  await expect(radios.nth(0)).toHaveAccessibleName(/^Google/);
  await expect(radios.nth(1)).toHaveAccessibleName(/^Microsoft 365 or Outlook\.com/);
  // A hint decides nothing: no choice is taken, and nothing to connect yet.
  for (const i of [0, 1, 2]) await expect(radios.nth(i)).not.toBeChecked();
  await expect(form.getByRole("button", { name: /Connect|Sign in with/ })).toHaveCount(0);
  await expect(form.getByLabel("Incoming server (IMAP)")).toHaveCount(0);
  await shot(window, "setup-nothing-found-hint");
});

test("a lookup left with Change says nothing about the address typed after it", async ({
  start,
}) => {
  const { window } = await start({ env: env() });
  const form = await lookUp(window, "jan@slow.example");
  await expect(form.getByRole("status")).toContainText("Looking up slow.example");
  await form.getByRole("button", { name: "Change" }).click();
  await lookUp(window, ADDRESS);
  await expect(form.getByText("Found Microsoft 365 for firma.example")).toBeVisible({
    timeout: 30_000,
  });
  // The first lookup ends after this one; what it found (nothing) is not shown.
  await window.waitForTimeout(3_500);
  await expect(form.getByText("Found Microsoft 365 for firma.example")).toBeVisible();
  await expect(form.getByRole("heading", { name: /We couldn't find the servers/ })).toHaveCount(0);
});

test("a chosen provider whose settings cannot be looked up leaves nothing else to connect", async ({
  start,
}) => {
  const { window } = await start({ env: env() });
  const form = await lookUp(window, ADDRESS);
  await expect(form.getByText("Found Microsoft 365 for firma.example")).toBeVisible({
    timeout: 30_000,
  });
  await form.getByRole("button", { name: "Not right?" }).click();
  const radios = form.getByRole("radiogroup", { name: "Who runs your mail" }).getByRole("radio");
  // The window tests' DNS table asks no settings database, so Google's are not found.
  await radios.nth(1).click();
  await expect(form.getByRole("alert")).toContainText(
    "Google's settings couldn't be looked up just now.",
  );
  await expect(form.getByRole("button", { name: /^Sign in with Microsoft/ })).toHaveCount(0);
  for (const i of [0, 1, 2]) await expect(radios.nth(i)).not.toBeChecked();
});
