import { PostalMimeParser } from "@matters/adapter-mime";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { MimeParserPort, ParseContext } from "@matters/core";
import { syncAccount } from "@matters/core";
import { describe, expect, it } from "vitest";
import { ImapMailSync } from "../src/index.ts";
import { Admin } from "./support/admin.ts";
import { ACCOUNT } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

/** The last two labels of a host; an IP has none. */
const registrableDomain = (host: string) =>
  /^[\d.]+$/.test(host) ? undefined : host.split(".").slice(-2).join(".");

/** What the sync hands the parser for each message (ADR 0048). */
async function contextsSeen(withDomains: boolean): Promise<ParseContext[]> {
  const server = await startHoodiecrow([]);
  const admin = await Admin.connect(server.credentials);
  const seen: ParseContext[] = [];
  const inner = new PostalMimeParser();
  const parser: MimeParserPort = {
    parse: (raw, context) => {
      seen.push(context ?? {});
      return inner.parse(raw, context);
    },
  };
  try {
    await admin.append("INBOX", mail({ id: "one", subject: "one" }));
    const storage = createSqliteStorage(":memory:");
    const imap = await ImapMailSync.connect({
      host: server.credentials.host,
      port: server.credentials.port,
      security: "none",
      allowInsecure: true,
      auth: { user: server.credentials.user, pass: server.credentials.pass },
      parser,
      ...(withDomains ? { registrableDomain } : {}),
    });
    try {
      await syncAccount({ ...storage, sync: imap }, ACCOUNT);
    } finally {
      await imap.close();
    }
    return seen;
  } finally {
    await admin.close();
    await server.stop();
  }
}

describe("the sync gives the parser the account's trusted authserv-ids (ADR 0048)", () => {
  it("trusts the account's own domain and nothing else", async () => {
    const seen = await contextsSeen(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const context of seen) {
      // The account is milosz@example.com; the test server's host is an IP.
      expect(context.isTrustedAuthServ?.("mx.example.com")).toBe(true);
      expect(context.isTrustedAuthServ?.("mx.example.org")).toBe(false);
      expect(context.isTrustedAuthServ?.("mx.google.com")).toBe(false);
    }
  });

  it("trusts nothing when the connection was given no way to find a registrable domain", async () => {
    for (const context of await contextsSeen(false)) {
      expect(context.isTrustedAuthServ).toBeUndefined();
    }
  });
});
