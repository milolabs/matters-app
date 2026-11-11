import { describe, expect, it } from "vitest";
import { smtpFailureDetail, smtpRefusal } from "../src/index.ts";

/** Synthetic answers in the shapes servers send them; none comes from a real mailbox. */
describe("smtpRefusal (ADR 0114)", () => {
  const host = "smtp.example.pl";

  it.each([
    [535, "535 5.7.8 Authentication credentials invalid", "credentials"],
    [535, "535 Authentication failed", "credentials"],
    [
      534,
      "534-5.7.9 Application-specific password required. Learn more at\n534 5.7.9  https://support.example/185833",
      "appPassword",
    ],
    [
      534,
      "534-5.7.14 <https://accounts.example/signin/continue?plt=TOKEN> Please log in via your web browser and\n534-5.7.14 then try again.",
      "webLogin",
    ],
    [
      535,
      "535 5.7.139 Authentication unsuccessful, basic authentication is disabled.",
      "browserOnly",
    ],
    [
      535,
      "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
      "notAllowed",
    ],
    [530, "530 5.7.0 Must issue a STARTTLS command first", "encryptionRequired"],
    [
      538,
      "538 5.7.11 Encryption required for requested authentication mechanism",
      "encryptionRequired",
    ],
    [454, "454 4.7.0 Temporary authentication failure", "unavailable"],
    [535, "535 5.7.8 Error: authentication failed: Your password has expired", "expired"],
    [534, "534 5.7.9 Authentication mechanism is too weak", "unknown"],
    [undefined, "", "unknown"],
  ] as const)("%s %s -> %s", (code, response, refusal) => {
    expect(smtpRefusal(host, code, response)).toBe(refusal);
  });

  it("calls a refusal on Microsoft's servers browser-only", () => {
    expect(smtpRefusal("smtp.office365.com", 535, "535 5.7.3 Authentication unsuccessful")).toBe(
      "browserOnly",
    );
    expect(smtpRefusal("smtp-mail.outlook.com", 454, "454 4.7.0 Temporary failure")).toBe(
      "unavailable",
    );
  });
});

describe("smtpFailureDetail", () => {
  const PASSWORD = "Pa55-very-secret";

  it("gives the reason and a quote without a secret or a token", () => {
    const detail = smtpFailureDetail(
      "auth",
      "smtp.gmail.com",
      "anna@example.com",
      {
        code: "EAUTH",
        responseCode: 534,
        response: `534-5.7.9 Application-specific password required for ${PASSWORD}. See\n534 5.7.9 <https://support.example/answer?x=TOKEN>`,
      },
      [PASSWORD],
    );
    expect(detail).toEqual({
      refusal: "appPassword",
      serverText: "Application-specific password required for ***. See",
    });
  });

  it("names the TLS problem from the system error nodemailer replaced", () => {
    expect(
      smtpFailureDetail(
        "tls",
        "smtp.example.pl",
        "anna",
        {
          code: "ETLS",
          originalCode: "CERT_HAS_EXPIRED",
          message: "Error initiating TLS - certificate has expired",
        },
        [],
      ),
    ).toEqual({ tls: "expired" });
  });

  it("says nothing for an unreachable server", () => {
    expect(
      smtpFailureDetail("unreachable", "smtp.example.pl", "anna", { code: "ECONNECTION" }, []),
    ).toBeUndefined();
  });
});
