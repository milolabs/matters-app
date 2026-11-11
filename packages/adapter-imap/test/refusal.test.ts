import { failureDetailOf } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  ImapAuthError,
  ImapTlsError,
  imapRefusal,
  refusedSignIn,
  safeError,
} from "../src/index.ts";

/** Synthetic answers in the shapes servers send them; none comes from a real mailbox. */
describe("imapRefusal (ADR 0114)", () => {
  const host = "imap.example.pl";

  it.each([
    [
      "AUTHENTICATIONFAILED",
      "A2 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)",
      "credentials",
    ],
    ["AUTHORIZATIONFAILED", "A2 NO [AUTHORIZATIONFAILED] No such authorization-ID", "notAllowed"],
    ["CONTACTADMIN", "A2 NO [CONTACTADMIN] Account suspended", "notAllowed"],
    ["EXPIRED", "A2 NO [EXPIRED] That password isn't valid any more", "expired"],
    ["PRIVACYREQUIRED", "A2 NO [PRIVACYREQUIRED] Connection is not private", "encryptionRequired"],
    ["UNAVAILABLE", "A2 NO [UNAVAILABLE] Temporary authentication failure", "unavailable"],
    ["LIMIT", "A2 NO [LIMIT] Too many users", "throttled"],
    [
      "ALERT",
      "A2 NO [ALERT] Application-specific password required: https://support.example/185833 (Failure)",
      "appPassword",
    ],
    ["WEBALERT", "A2 NO [WEBALERT https://accounts.example/c?x=1] Web login required.", "webLogin"],
    [undefined, "A2 NO [ALERT] Your account is not enabled for IMAP use.", "imapOff"],
    [undefined, "A2 NO Temporary failure, try again later", "unavailable"],
    [undefined, "A2 NO LOGIN failed.", "unknown"],
    [undefined, "A2 NO Login failed", "unknown"],
  ])("%s: %s -> %s", (code, text, refusal) => {
    expect(imapRefusal(host, code, text)).toBe(refusal);
  });

  it("reads the code from the text when imapflow did not set it", () => {
    expect(imapRefusal(host, undefined, "A2 NO [AUTHENTICATIONFAILED] Bad")).toBe("credentials");
  });

  it("calls any refusal on Microsoft's servers browser-only, but a temporary one temporary", () => {
    for (const ms of ["outlook.office365.com", "imap-mail.outlook.com"]) {
      expect(imapRefusal(ms, undefined, "A2 NO LOGIN failed.")).toBe("browserOnly");
      expect(imapRefusal(ms, "AUTHENTICATIONFAILED", "A2 NO AUTHENTICATE failed.")).toBe(
        "browserOnly",
      );
      expect(imapRefusal(ms, undefined, "A2 NO BasicAuthBlocked")).toBe("browserOnly");
      expect(imapRefusal(ms, "UNAVAILABLE", "A2 NO [UNAVAILABLE] Server busy")).toBe("unavailable");
    }
  });
});

describe("refusedSignIn", () => {
  const PASSWORD = "Pa55-very-secret";

  it("carries the reason and a clean quote, and keeps both out of the message", () => {
    const error = refusedSignIn(
      "imap.gmail.com",
      "anna@example.com",
      {
        code: "ALERT",
        text: `A2 NO [ALERT] Application-specific password required for ${PASSWORD}: https://support.example/185833 (Failure)`,
      },
      [PASSWORD],
    );
    expect(error).toBeInstanceOf(ImapAuthError);
    expect(error.kind).toBe("auth");
    expect(error.detail).toEqual({
      refusal: "appPassword",
      serverText: "Application-specific password required for ***: https://support.example/185833",
    });
    expect(error.message).toBe(
      "IMAP authentication failed for anna@example.com on imap.gmail.com (appPassword)",
    );
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    expect(error.stack ?? "").not.toContain("Application-specific");
    expect(failureDetailOf(error)).toEqual(error.detail);
  });

  it("is unknown with no quote when the server said nothing", () => {
    const error = refusedSignIn("imap.example.pl", "anna", {}, [PASSWORD]);
    expect(error.detail).toEqual({ refusal: "unknown" });
  });
});

describe("TLS problems", () => {
  it.each([
    ["CERT_HAS_EXPIRED", "certificate has expired", "expired"],
    [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "Hostname/IP does not match certificate's altnames",
      "nameMismatch",
    ],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate", "selfSigned"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number", "noEncryption"],
  ])("%s -> %s", (code, message, tls) => {
    const error = safeError(Object.assign(new Error(message), { code }), []);
    expect(error).toBeInstanceOf(ImapTlsError);
    expect(failureDetailOf(error)).toEqual({ tls });
  });

  it("says no STARTTLS is no encryption", () => {
    const error = safeError(
      Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true }),
      [],
    );
    expect(failureDetailOf(error)).toEqual({ tls: "noEncryption" });
  });

  it("gives no detail for an error that is not about TLS", () => {
    expect(failureDetailOf(safeError(new Error("something odd"), []))).toBeUndefined();
  });
});
