import { describe, expect, it } from "vitest";
import {
  failureDetailOf,
  HOST_RULES,
  hostRule,
  needsBrowserSignIn,
  refusalFromWording,
  SERVER_TEXT_MAX,
  serverSentence,
  takesPassword,
  tlsProblemOf,
} from "../src/index.ts";

describe("refusalFromWording (ADR 0114)", () => {
  it.each([
    [
      "[ALERT] Application-specific password required: https://support.example/185833",
      "appPassword",
    ],
    ["Please use an app password to sign in", "appPassword"],
    ["[WEBALERT https://accounts.example/x?token=1] Web login required.", "webLogin"],
    ["5.7.14 Please log in via your web browser and then try again", "webLogin"],
    ["BasicAuthBlocked", "browserOnly"],
    ["Authentication unsuccessful, basic authentication is disabled.", "browserOnly"],
    [
      "5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant",
      "notAllowed",
    ],
    ["User is authenticated but not connected.", "notAllowed"],
    ["Your account is not enabled for IMAP use.", "imapOff"],
    ["IMAP access is disabled for this account", "imapOff"],
    ["Please enable IMAP in your settings", "imapOff"],
    ["Your password has expired", "expired"],
    ["Too many login attempts, try later", "throttled"],
    ["Too many simultaneous connections", "throttled"],
  ])("%s -> %s", (text, refusal) => {
    expect(refusalFromWording(text)).toBe(refusal);
  });

  it("names nothing for a generic answer", () => {
    expect(refusalFromWording("Invalid credentials (Failure)")).toBeUndefined();
    expect(refusalFromWording("LOGIN failed.")).toBeUndefined();
  });
});

describe("tlsProblemOf", () => {
  it.each([
    ["CERT_HAS_EXPIRED", "certificate has expired", "expired"],
    [undefined, "Error initiating TLS - certificate has expired", "expired"],
    [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "Hostname/IP does not match certificate's altnames",
      "nameMismatch",
    ],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate", "selfSigned"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain", "selfSigned"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate", "untrusted"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "ssl3_get_record:wrong version number", "noEncryption"],
    [undefined, "Server does not support STARTTLS", "noEncryption"],
    ["ECONNRESET", "Client network socket disconnected before secure TLS connection", "other"],
  ] as const)("%s / %s -> %s", (code, message, problem) => {
    expect(tlsProblemOf(code, message)).toBe(problem);
  });
});

describe("serverSentence", () => {
  const keep = { secrets: ["hunter2"], user: "anna@example.pl" };

  it("cuts the IMAP tag, status and response code", () => {
    expect(serverSentence("A2 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)", keep)).toBe(
      "Invalid credentials",
    );
  });

  it("joins a multi-line SMTP answer without its codes", () => {
    expect(
      serverSentence(
        "535-5.7.8 Username and Password not accepted. For more information, go to\n535 5.7.8  https://support.example/mail/answer/14257 x1",
        keep,
      ),
    ).toBe(
      "Username and Password not accepted. For more information, go to https://support.example/mail/answer/14257 x1",
    );
  });

  it("drops links with a query, which may carry a sign-in token", () => {
    expect(
      serverSentence(
        "534-5.7.14 <https://accounts.example/signin/continue?sarp=1&plt=SECRETTOKEN> Please log in via your web browser",
        keep,
      ),
    ).toBe("Please log in via your web browser");
  });

  it("never keeps a secret, another address or a control character", () => {
    const said = serverSentence(
      "NO hunter2 rejected for anna@example.pl, ask admin@corp.example\u0007‮ now",
      keep,
    );
    expect(said).toBe("*** rejected for anna@example.pl, ask … now");
  });

  it("caps the length and gives nothing for an empty answer", () => {
    const said = serverSentence(`NO ${"word ".repeat(100)}`, keep) ?? "";
    expect(said.length).toBe(SERVER_TEXT_MAX);
    expect(said.endsWith("…")).toBe(true);
    expect(serverSentence("A1 NO [AUTHENTICATIONFAILED] ", keep)).toBeUndefined();
  });
});

describe("failureDetailOf", () => {
  it("keeps only known values", () => {
    expect(failureDetailOf({ detail: { refusal: "appPassword", serverText: "x" } })).toEqual({
      refusal: "appPassword",
      serverText: "x",
    });
    expect(failureDetailOf({ detail: { refusal: "rm -rf", tls: "nope" } })).toBeUndefined();
    expect(failureDetailOf(new Error("x"))).toBeUndefined();
    expect(failureDetailOf(null)).toBeUndefined();
  });
});

describe("host rules", () => {
  it("are found by exact server name, in any case", () => {
    expect(hostRule(" IMAP.mail.yahoo.com ")?.signIn).toBe("appPassword");
    expect(hostRule("imap.wp.pl")?.signIn).toBe("turnOnImap");
    expect(hostRule("imap.wp.pl.example.org")).toBeUndefined();
    expect(hostRule("imap.example.pl")).toBeUndefined();
  });

  it("name every host once", () => {
    const hosts = HOST_RULES.flatMap((r) => r.hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const host of hosts) expect(host).toBe(host.toLowerCase());
  });

  it("send Microsoft's servers to browser sign-in, whatever the settings list", () => {
    const microsoft = {
      imap: { host: "outlook.office365.com", auth: ["password", "oauth2"] },
      smtp: { host: "smtp.office365.com" },
    };
    expect(needsBrowserSignIn(microsoft)).toBe(true);
    expect(takesPassword(microsoft)).toBe(false);
    expect(takesPassword({ imap: { host: "imap-mail.outlook.com", auth: ["password"] } })).toBe(
      false,
    );
    expect(takesPassword({ imap: { host: "imap.gmail.com", auth: ["password", "oauth2"] } })).toBe(
      true,
    );
    expect(takesPassword({ imap: { host: "imap.example.pl", auth: ["oauth2"] } })).toBe(false);
  });
});
