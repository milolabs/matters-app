import { describe, expect, it } from "vitest";
import { Admin } from "./support/admin.ts";
import { Mailbox } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

describe("the automated flag through a real sync (ADR 0052, rule 4)", () => {
  it("is stored with the message: true for a list or a program, false for a person", async () => {
    const server = await startHoodiecrow([]);
    const admin = await Admin.connect(server.credentials);
    const box = new Mailbox(server.credentials, 20);
    try {
      const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n));
      await admin.append("INBOX", mail({ id: "person", subject: "person", date: at(1) }));
      await admin.append(
        "INBOX",
        mail({
          id: "list",
          subject: "list",
          date: at(2),
          headers: ["List-Unsubscribe: <mailto:leave@example.pl>"],
        }),
      );
      await admin.append(
        "INBOX",
        mail({
          id: "bounce",
          subject: "bounce",
          date: at(3),
          headers: ["Auto-Submitted: auto-generated"],
        }),
      );
      await admin.append(
        "INBOX",
        mail({ id: "bulk", subject: "bulk", date: at(4), headers: ["Precedence: bulk"] }),
      );
      await box.sync();
      const stored = new Map((await box.messages()).map((m) => [m.subject, m.automated]));
      expect(Object.fromEntries(stored)).toEqual({
        person: false,
        list: true,
        bounce: true,
        bulk: true,
      });
    } finally {
      box.close();
      await admin.close();
      await server.stop();
    }
  });
});
