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

  it("calls a bare refusal of a token on Microsoft's servers not allowed (ADR 0133, rule 10)", () => {
    for (const ms of ["smtp.office365.com", "smtp-mail.outlook.com"]) {
      expect(smtpRefusal(ms, 535, "535 5.7.3 Authentication unsuccessful", "token")).toBe(
        "notAllowed",
      );
      expect(
        smtpRefusal(
          ms,
          535,
          "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
          "token",
        ),
      ).toBe("notAllowed");
      expect(smtpRefusal(ms, 535, "535 5.7.139 basic authentication is disabled.", "token")).toBe(
        "notAllowed",
      );
      expect(smtpRefusal(ms, 454, "454 4.7.0 Temporary failure", "token")).toBe("unavailable");
      expect(
        smtpRefusal(ms, 535, "535 5.7.8 Error: too many failed attempts, try later", "token"),
      ).toBe("throttled");
    }
    expect(smtpRefusal(host, 535, "535 5.7.8 Authentication credentials invalid", "token")).toBe(
      "credentials",
    );
  });

  it("passes the login kind through smtpFailureDetail", () => {
    expect(
      smtpFailureDetail(
        "auth",
        "smtp.office365.com",
        "me@outlook.example",
        { responseCode: 535, response: "535 5.7.3 Authentication unsuccessful" },
        ["tok"],
        "token",
      )?.refusal,
    ).toBe("notAllowed");
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
