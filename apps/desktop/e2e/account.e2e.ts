// Work on a real account, checked on the servers rather than on the screen alone: a message sent
// reaches the SMTP server, and a message read or archived is read or archived on the IMAP server.
// Against the Dovecot test server (needs Docker) and an SMTP server in this process.
import PostalMime from "postal-mime";
import { mail } from "../../../packages/adapter-imap/test/support/mail.ts";
import { addAccountOnFirstRun } from "./addAccount.ts";
import { expect, requireImapServer, test } from "./servers.ts";

requireImapServer();

// Sends and moves wait out their undo window (10 s, ADR 0041 and 0044) before they reach a server.
const SERVER_TIMEOUT = 45_000;

test("a new message is sent through the account's SMTP server", async ({ mailbox, start }) => {
  await mailbox.admin.append("INBOX", mail({ id: "send-0", subject: "Na dobry początek" }));
  const { window } = await start();
  await addAccountOnFirstRun(window, mailbox);
  await expect(window.getByRole("listbox", { name: "Messages" }).getByRole("option")).toHaveCount(
    1,
    { timeout: 60_000 },
  );

  await window.getByRole("button", { name: "New message" }).click();
  const to = window.getByRole("combobox", { name: "To" });
  await to.pressSequentially("ola@example.test");
  await window.getByRole("textbox", { name: "Subject" }).fill("Spotkanie w piątek");
  await window.getByRole("textbox", { name: "Message" }).click();
  await window.keyboard.type("Do zobaczenia o dziesiątej.");
  await window.getByRole("button", { name: /^Send/ }).click();

  await expect.poll(() => mailbox.sink.received.length, { timeout: SERVER_TIMEOUT }).toBe(1);
  const [sent] = mailbox.sink.received;
  expect(sent?.recipients).toEqual(["ola@example.test"]);
  expect(sent?.from).toBe(mailbox.address);
  const parsed = await PostalMime.parse(sent?.raw ?? Buffer.alloc(0));
  expect(parsed.subject).toBe("Spotkanie w piątek");
  expect(parsed.to?.map((a) => a.address)).toEqual(["ola@example.test"]);
  expect(parsed.text).toContain("Do zobaczenia o dziesiątej.");
});

test("reading and archiving reach the IMAP server", async ({ mailbox, start }) => {
  await mailbox.admin.append("INBOX", mail({ id: "flags-0", subject: "Do przeczytania" }));
  await mailbox.admin.append("INBOX", mail({ id: "flags-1", subject: "Do archiwum" }));
  const { window } = await start();
  await addAccountOnFirstRun(window, mailbox);
  const list = window.getByRole("listbox", { name: "Messages" });
  const toRead = list.getByRole("option", { name: /Do przeczytania/ });
  const toArchive = list.getByRole("option", { name: /Do archiwum/ });
  await expect(toRead).toHaveAccessibleName(/^Unread/, { timeout: 60_000 });

  // `u` on an unread row reads the whole thread.
  await toRead.click();
  await window.keyboard.press("u");
  await expect(toRead).not.toHaveAccessibleName(/^Unread/);
  await expect
    .poll(
      async () => {
        const inbox = await mailbox.admin.messages("INBOX");
        return inbox.find((m) => m.source.includes("Do przeczytania"))?.flags ?? [];
      },
      { timeout: SERVER_TIMEOUT },
    )
    .toContain("\\Seen");

  await toArchive.click();
  const thread = window.getByRole("region", { name: "Thread" });
  await expect(thread.getByRole("heading", { level: 2 })).toHaveText("Do archiwum");
  await thread.getByRole("button", { name: "Archive" }).click();
  // The account had no Archive folder; the app makes one (ADR 0044, rule 14).
  await expect
    .poll(
      async () => {
        const archived = await mailbox.admin.messages("Archive").catch(() => []);
        return archived.map((m) => m.source.includes("Do archiwum"));
      },
      { timeout: SERVER_TIMEOUT },
    )
    .toEqual([true]);
  const inbox = await mailbox.admin.messages("INBOX");
  expect(inbox.map((m) => m.source.includes("Do przeczytania"))).toEqual([true]);
});
