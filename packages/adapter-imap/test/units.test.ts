import { describe, expect, it } from "vitest";
import { gmailLabelId, providerIdOf, roleOfFolder } from "../src/index.ts";

const base = {
  folderId: "INBOX",
  uidValidity: "7",
  uid: 3,
  messageId: "<a@example.pl>",
  dateMs: 1_700_000_000_000,
  size: 1234,
};

describe("providerIdOf", () => {
  it("prefers the Gmail id, then the OBJECTID email id, then a fingerprint, then the location", () => {
    expect(providerIdOf({ ...base, emailId: "1278", emailIdKind: "gmail" })).toBe("gm:1278");
    expect(providerIdOf({ ...base, emailId: "M7", emailIdKind: "objectId" })).toBe("eid:M7");
    expect(providerIdOf({ ...base, emailId: undefined, emailIdKind: "none" })).toMatch(
      /^fp:[0-9a-f]{64}$/,
    );
    expect(
      providerIdOf({ ...base, emailId: undefined, emailIdKind: "none", messageId: undefined }),
    ).toBe("loc:INBOX:7:3");
  });

  it("fingerprints the same message identically in any folder and tells different ones apart", () => {
    const a = providerIdOf({ ...base, emailId: undefined, emailIdKind: "none" });
    const moved = providerIdOf({
      ...base,
      folderId: "Archive",
      uidValidity: "9",
      uid: 40,
      emailId: undefined,
      emailIdKind: "none",
    });
    const other = providerIdOf({ ...base, size: 1235, emailId: undefined, emailIdKind: "none" });
    expect(moved).toBe(a);
    expect(other).not.toBe(a);
  });

  it("ignores an email id that comes without a known extension", () => {
    expect(providerIdOf({ ...base, emailId: "x", emailIdKind: "none" })).toMatch(/^fp:/);
  });
});

describe("roleOfFolder", () => {
  it("uses SPECIAL-USE before the name", () => {
    expect(roleOfFolder("Moje", "Moje", "\\Sent")).toBe("sent");
    expect(roleOfFolder("Kosz", "Kosz", "\\Archive")).toBe("archive");
    expect(roleOfFolder("[Gmail]/All Mail", "All Mail", "\\All")).toBe("archive");
    expect(roleOfFolder("Junk", "Junk", "\\Junk")).toBe("spam");
  });

  it("falls back to English and Polish names", () => {
    const roles: [string, string][] = [
      ["INBOX", "inbox"],
      ["Sent Items", "sent"],
      ["Wysłane", "sent"],
      ["Elementy wysłane", "sent"],
      ["Kosz", "trash"],
      ["Śmieci", "trash"],
      ["Elementy usunięte", "trash"],
      ["Wersje robocze", "drafts"],
      ["Drafts", "drafts"],
      ["Spam", "spam"],
      ["Junk E-mail", "spam"],
      ["Projekty", "other"],
    ];
    for (const [name, role] of roles) {
      expect([name, roleOfFolder(`INBOX/${name}`, name, undefined)]).toEqual([name, role]);
    }
  });
});

describe("gmailLabelId", () => {
  it("turns system labels into plain names and keeps user labels", () => {
    expect(gmailLabelId("\\Inbox")).toBe("inbox");
    expect(gmailLabelId("\\Important")).toBe("important");
    expect(gmailLabelId("Faktury 2026")).toBe("Faktury 2026");
  });
});
