// The first-run screen, answered the way a person answers it: the address, then the servers by
// hand (nothing publishes settings for example.test), the password, and no AI.
import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";
import type { Mailbox } from "./servers.ts";

export async function addAccountOnFirstRun(window: Page, mailbox: Mailbox): Promise<void> {
  const form = window.getByRole("form", { name: "Add account" });
  await expect(form.getByRole("heading", { name: "Let's bring your mail here." })).toBeVisible();
  await form.getByRole("textbox", { name: "Email address" }).fill(mailbox.address);
  await form.getByRole("button", { name: /Continue/ }).click();

  // The lookup asks DNS and the web about example.test and finds nothing; that can take a while.
  await expect(
    form.getByRole("heading", { name: "We couldn't find the servers for example.test." }),
  ).toBeVisible({ timeout: 60_000 });
  await form.getByLabel("Incoming server (IMAP)").fill(mailbox.host);
  await form.getByLabel("Port").first().fill(String(mailbox.imapPort));
  await expect(form.getByLabel("Encryption").first()).toHaveValue("tls");
  await form.getByLabel("Outgoing server (SMTP)").fill(mailbox.host);
  await form.getByLabel("Port").nth(1).fill(String(mailbox.smtpPort));
  await expect(form.getByLabel("Encryption").nth(1)).toHaveValue("tls");
  await expect(form.getByLabel("User name", { exact: true })).toHaveValue(mailbox.address);
  await form.getByLabel(`Password for ${mailbox.address}`).fill(mailbox.password);
  await form.getByRole("button", { name: /Connect/ }).click();

  await expect(form.getByRole("heading", { name: "You're in." })).toBeVisible({ timeout: 60_000 });
  await expect(form.getByText(`Sending works through ${mailbox.host}`)).toBeVisible();
  await form.getByRole("button", { name: /Continue/ }).click();
  await expect(form.getByRole("heading", { name: "Who should work on your mail?" })).toBeVisible();
  await form.getByRole("button", { name: "Use without AI" }).click();
  await expect(form).toBeHidden();
}
