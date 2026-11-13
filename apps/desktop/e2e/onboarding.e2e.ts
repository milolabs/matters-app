// The first start: an empty data folder, the setup screen, an account typed in, its first sync, and
// the mail still there when the app starts again. Against the Dovecot test server (needs Docker).
import { mail } from "../../../packages/adapter-imap/test/support/mail.ts";
import { addAccountOnFirstRun } from "./addAccount.ts";
import { expect, requireImapServer, test } from "./servers.ts";

requireImapServer();

const SUBJECTS = ["Plan na czwartek", "Faktura za listopad", "Zdjęcia z wyjazdu"];
// What the account's line at the foot of the list says once a sync has finished.
const SYNCED = /Up to date|Synced \d\d:\d\d/;

test("a first start adds an account, syncs it, and keeps it for the next start", async ({
  mailbox,
  start,
}) => {
  for (const [i, subject] of SUBJECTS.entries()) {
    await mailbox.admin.append("INBOX", mail({ id: `onboarding-${i}`, subject }));
  }

  const first = await start();
  await addAccountOnFirstRun(first.window, mailbox);
  const list = first.window.getByRole("listbox", { name: "Messages" });
  for (const subject of SUBJECTS) {
    await expect(list.getByRole("option", { name: new RegExp(subject) })).toBeVisible({
      timeout: 60_000,
    });
  }
  await expect(list.getByRole("option")).toHaveCount(SUBJECTS.length);
  const account = (window: typeof first.window) =>
    window.getByRole("button", { name: new RegExp(`^Accounts: .*${mailbox.address}`) });
  await expect(account(first.window)).toHaveAccessibleName(SYNCED, { timeout: 60_000 });
  await first.close();

  // The same data folder again: straight to the mail, no setup screen, and the password comes
  // back from the keychain, so the account syncs again.
  const second = await start();
  const again = second.window.getByRole("listbox", { name: "Messages" });
  await expect(again.getByRole("option")).toHaveCount(SUBJECTS.length);
  for (const subject of SUBJECTS) {
    await expect(again.getByRole("option", { name: new RegExp(subject) })).toBeVisible();
  }
  await expect(second.window.getByRole("form", { name: "Add account" })).toHaveCount(0);
  await expect(account(second.window)).toHaveAccessibleName(SYNCED, { timeout: 60_000 });

  // And the restarted app still fetches: a message that reaches the server now reaches the list.
  await mailbox.admin.append("INBOX", mail({ id: "onboarding-late", subject: "Po restarcie" }));
  await expect(again.getByRole("option", { name: /Po restarcie/ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(again.getByRole("option")).toHaveCount(SUBJECTS.length + 1);
});
