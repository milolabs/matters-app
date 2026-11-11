import { describe, expect, it } from "vitest";
import {
  type DiscoveredServers,
  isGmailHost,
  isICloudHost,
  suggestedSmtpUsername,
  suggestedUsername,
} from "../src/index.ts";

const servers = (
  host: string,
  usernameTemplate: string,
  smtpTemplate?: string,
): DiscoveredServers => ({
  source: "ispdb",
  imap: { host, port: 993, security: "tls", usernameTemplate, auth: ["password"] },
  ...(smtpTemplate === undefined
    ? {}
    : {
        smtp: {
          host: "smtp.example.pl",
          port: 587,
          security: "starttls" as const,
          usernameTemplate: smtpTemplate,
          auth: ["password" as const],
        },
      }),
});

describe("suggestedSmtpUsername", () => {
  const address = "jan.nowak@example.pl";

  it("keeps a provider's own outgoing login when it differs from the incoming one", () => {
    expect(
      suggestedSmtpUsername(
        servers("imap.example.pl", "%EMAILLOCALPART%", "%EMAILADDRESS%"),
        address,
      ),
    ).toBe(address);
  });

  it("is empty when both logins are the same, or there is no outgoing server", () => {
    expect(
      suggestedSmtpUsername(
        servers("imap.example.pl", "%EMAILADDRESS%", "%EMAILADDRESS%"),
        address,
      ),
    ).toBe("");
    expect(suggestedSmtpUsername(servers("imap.example.pl", "%EMAILADDRESS%"), address)).toBe("");
  });

  it("is empty for iCloud, whose one login is already the full address", () => {
    expect(
      suggestedSmtpUsername(
        servers("imap.mail.me.com", "%EMAILLOCALPART%", "%EMAILADDRESS%"),
        "jan.nowak@icloud.com",
      ),
    ).toBe("");
  });
});

describe("suggestedUsername", () => {
  it("gives iCloud the full address, which its outgoing server requires", () => {
    expect(
      suggestedUsername(servers("imap.mail.me.com", "%EMAILLOCALPART%"), "jan.nowak@icloud.com"),
    ).toBe("jan.nowak@icloud.com");
  });

  it("follows the published template everywhere else", () => {
    expect(
      suggestedUsername(servers("imap.example.pl", "%EMAILLOCALPART%"), "jan.nowak@example.pl"),
    ).toBe("jan.nowak");
    expect(
      suggestedUsername(servers("imap.example.pl", "%EMAILADDRESS%"), "jan.nowak@example.pl"),
    ).toBe("jan.nowak@example.pl");
  });
});

describe("isICloudHost", () => {
  it("recognises the host however it was typed, and nothing that merely resembles it", () => {
    expect(isICloudHost(" IMAP.mail.me.com ")).toBe(true);
    expect(isICloudHost("imap.mail.me.com.example.org")).toBe(false);
    expect(isICloudHost("imap.example.pl")).toBe(false);
  });
});

describe("isGmailHost", () => {
  it("recognises the host however it was typed, and nothing that merely resembles it", () => {
    expect(isGmailHost(" IMAP.gmail.com ")).toBe(true);
    expect(isGmailHost("imap.googlemail.com")).toBe(true);
    expect(isGmailHost("imap.gmail.com.example.org")).toBe(false);
    expect(isGmailHost("imap.example.pl")).toBe(false);
  });
});
