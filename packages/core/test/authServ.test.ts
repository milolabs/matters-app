import { describe, expect, it } from "vitest";
import { isTrustedAuthServ } from "../src/index.ts";

/** A small stand-in for the Public Suffix List: the last two labels, three under `co.uk`. */
const registrableDomain = (host: string): string | undefined => {
  const labels = host.split(".");
  const keep = host.endsWith(".co.uk") ? 3 : 2;
  return labels.length < keep ? undefined : labels.slice(-keep).join(".");
};

const trusted = (id: string, imapHost: string, address: string) =>
  isTrustedAuthServ({ id, imapHost, address, registrableDomain });

describe("isTrustedAuthServ (ADR 0048)", () => {
  it("trusts an id under the registrable domain of the IMAP host", () => {
    expect(trusted("mx.example.com", "imap.example.com", "me@elsewhere.test")).toBe(true);
    expect(trusted("example.com", "mail.example.com", "me@elsewhere.test")).toBe(true);
    expect(trusted("mx3.eu.example.com", "imap.example.com", "me@elsewhere.test")).toBe(true);
  });

  it("trusts an id under the registrable domain of the account's address", () => {
    expect(trusted("mx.example.org", "imap.host.test", "me@example.org")).toBe(true);
    expect(trusted("mx.example.org", "imap.host.test", "me@mail.example.org")).toBe(true);
  });

  it("trusts nothing on Microsoft's servers, whose real header has no id to recognise", () => {
    expect(trusted("mx.corp.example", "outlook.office365.com", "me@corp.example")).toBe(false);
    expect(trusted("mx.office365.com", "outlook.office365.com", "me@corp.example")).toBe(false);
    expect(trusted("mx.outlook.com", "imap-mail.outlook.com", "me@outlook.com")).toBe(false);
  });

  it("does not trust another domain, a look-alike or a sibling under a shared suffix", () => {
    expect(trusted("mx.example.net", "imap.example.com", "me@example.org")).toBe(false);
    expect(trusted("mx.example.com.evil.test", "imap.example.com", "me@example.com")).toBe(false);
    expect(trusted("mx.notexample.com", "imap.example.com", "me@example.com")).toBe(false);
    expect(trusted("mx.other.co.uk", "imap.shop.co.uk", "me@shop.co.uk")).toBe(false);
  });

  it("trusts nothing with no registrable domain, an empty id, or no account", () => {
    expect(trusted("", "imap.example.com", "me@example.com")).toBe(false);
    expect(trusted("com", "imap.example.com", "me@example.com")).toBe(false);
    expect(trusted("mx.example.com", "", "")).toBe(false);
    expect(trusted("mx.example.com", "", "no-at-sign")).toBe(false);
  });

  it("compares in lower case and ignores a trailing dot", () => {
    expect(trusted("MX.Example.COM.", "IMAP.example.com.", "me@x.test")).toBe(true);
  });

  describe("providers whose id sits under another domain than their IMAP host", () => {
    it("trusts Google's id for Gmail and Google Workspace, whatever the address", () => {
      expect(trusted("mx.google.com", "imap.gmail.com", "me@gmail.com")).toBe(true);
      expect(trusted("mx.google.com", "imap.gmail.com", "me@company.test")).toBe(true);
    });

    it("trusts iCloud's ids for imap.mail.me.com", () => {
      expect(trusted("dmarc.icloud.com", "imap.mail.me.com", "me@icloud.com")).toBe(true);
      expect(trusted("dkim-verifier.icloud.com", "imap.mail.me.com", "me@me.com")).toBe(true);
    });

    it("trusts Fastmail's servers for imap.fastmail.com", () => {
      expect(trusted("mx1.messagingengine.com", "imap.fastmail.com", "me@company.test")).toBe(true);
    });

    it("applies an entry only to its own IMAP host", () => {
      expect(trusted("mx.google.com", "imap.example.com", "me@example.com")).toBe(false);
      expect(trusted("mx.google.com", "imap.fastmail.com", "me@fastmail.com")).toBe(false);
      expect(trusted("mx1.messagingengine.com", "imap.gmail.com", "me@gmail.com")).toBe(false);
    });

    it("does not let a property named like a table key reach the table", () => {
      expect(trusted("mx.google.com", "imap.constructor", "me@constructor")).toBe(false);
      expect(trusted("mx.google.com", "imap.__proto__", "me@x.test")).toBe(false);
    });
  });
});
