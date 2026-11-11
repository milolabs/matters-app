import type { FailureDetail, SignInRefusal, TlsProblem } from "@matters/core";
import { describe, expect, it } from "vitest";
import { BackendError } from "../src/renderer/client.ts";
import { explainFailure, failureEvidence, passwordHint } from "../src/renderer/explain.ts";

const at = { host: "imap.x.pl", port: 993, smtpHost: "smtp.x.pl" };
const refused = (refusal: SignInRefusal, detail: FailureDetail = {}) =>
  new BackendError("authFailed", "IMAP authentication failed", { ...detail, refusal });

describe("explainFailure for each reason a server gives (ADR 0114)", () => {
  it.each([
    [
      "credentials",
      "The server says the user name or password is wrong. Check both. With two-factor sign-in, most hosts want an app password here.",
    ],
    [
      "appPassword",
      "The server wants an app password, not your account password. Create one in your account's security settings, then enter it here.",
    ],
    [
      "webLogin",
      "The server wants you to sign in on its website once first, usually to confirm it's you. Do that in a browser, then try again here.",
    ],
    [
      "imapOff",
      "IMAP is turned off for this mailbox. Turn it on in your webmail's settings, then try again.",
    ],
    [
      "browserOnly",
      "This server takes only browser sign-in from mail apps, which Matters can't do yet. A password won't work there.",
    ],
    [
      "notAllowed",
      "The server knows you, but won't let this mailbox in this way. Ask whoever runs your mail to allow IMAP for it.",
    ],
    [
      "expired",
      "The server says your password has expired. Change it in your webmail, then enter the new one here.",
    ],
    [
      "encryptionRequired",
      "The server won't take a password over this connection. Choose TLS in the settings above, then try again.",
    ],
    [
      "unavailable",
      "The server couldn't check the password just now. That's on its side; try again in a few minutes.",
    ],
    [
      "throttled",
      "The server is turning sign-ins away for now, after too many tries. Wait a few minutes, then try again.",
    ],
    [
      "unknown",
      "The server refused the sign-in. Check the password. Many hosts want an app password, or IMAP turned on in their settings, and some use other servers for business accounts: see their help pages.",
    ],
  ] as const)("%s", (refusal, text) => {
    expect(explainFailure(refused(refusal), at)).toBe(text);
  });

  it("keeps the general sentence when the backend sent no reason", () => {
    expect(explainFailure(new BackendError("authFailed", "x"), at)).toMatch(/app password/);
  });

  it("names the host's own rule when it has one", () => {
    expect(explainFailure(refused("credentials"), { ...at, host: "imap.mail.yahoo.com" })).toBe(
      "The server says the user name or password is wrong. Yahoo Mail wants an app password here, not your Yahoo account password.",
    );
    expect(explainFailure(refused("credentials"), { ...at, host: "imap.wp.pl" })).toBe(
      "The server says the user name or password is wrong. WP Poczta also turns mail apps away until IMAP access is on in its webmail settings.",
    );
    expect(explainFailure(refused("appPassword"), { ...at, host: "imap.gmail.com" })).toBe(
      "Gmail wants an app password, not your Google Account password. Turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.",
    );
    expect(
      explainFailure(refused("browserOnly"), { ...at, host: "outlook.office365.com" }),
    ).toMatch(/^Microsoft takes only browser sign-in/);
  });

  it("says what was wrong with TLS first, for incoming and outgoing ports", () => {
    const tls = (problem: TlsProblem, code: "tlsFailed" | "outgoingFailed" = "tlsFailed") =>
      explainFailure(new BackendError(code, "raw node text", { tls: problem }), at);
    expect(tls("expired")).toBe(
      "Could not make a secure connection to imap.x.pl:993. Its certificate has expired, so Matters can't be sure it's the real server. Whoever runs it needs to renew it.",
    );
    expect(tls("nameMismatch")).toMatch(/certificate is for a different name/);
    expect(tls("selfSigned")).toMatch(/self-signed/);
    expect(tls("untrusted")).toMatch(/authority this Mac trusts/);
    expect(tls("noEncryption")).toMatch(/no encryption on this port. TLS is usually port 993/);
    expect(tls("noEncryption", "outgoingFailed")).toMatch(
      /^Receiving works, but the secure connection to smtp\.x\.pl failed\. .*port 465, STARTTLS port 587/,
    );
    expect(tls("other")).not.toContain("raw node text");
  });

  it("is specific about an outgoing refusal when the server said why", () => {
    const out = (refusal: SignInRefusal) =>
      explainFailure(new BackendError("outgoingAuthFailed", "x", { refusal }), at);
    expect(out("notAllowed")).toBe(
      "Receiving works, but smtp.x.pl doesn't allow sending with a password for this mailbox. Whoever runs your mail can turn that on. Or add the account without sending for now.",
    );
    expect(out("browserOnly")).toMatch(/takes only browser sign-in for sending/);
    expect(out("appPassword")).toMatch(
      /^Receiving works, but smtp\.x\.pl refused the same login\. The server wants an app password/,
    );
    expect(out("credentials")).toMatch(/Check the user name in the settings above/);
  });

  it("puts a human sentence first for an error nobody classified", () => {
    expect(explainFailure(new BackendError("internal", "EWEIRD 42"), at)).toBe(
      "Adding the account failed in a way Matters didn't expect. Check the server settings above, then try again.",
    );
  });
});

describe("failureEvidence", () => {
  it("quotes the server, or shows the raw error under a general sentence", () => {
    expect(
      failureEvidence(
        refused("appPassword", { serverText: "Application-specific password required" }),
      ),
    ).toBe("The server said: “Application-specific password required”");
    expect(failureEvidence(refused("credentials"))).toBeUndefined();
    expect(failureEvidence(new BackendError("tlsFailed", "certificate has expired"))).toBe(
      "Details: certificate has expired",
    );
    expect(failureEvidence(new BackendError("internal", "EWEIRD 42"))).toBe("Details: EWEIRD 42");
    expect(failureEvidence(new BackendError("accountExists", "x"))).toBeUndefined();
    expect(failureEvidence(new Error("x"))).toBeUndefined();
  });
});

describe("passwordHint, before anything is tried", () => {
  it("keeps the Gmail and iCloud wording", () => {
    expect(passwordHint("imap.gmail.com")).toBe(
      "Gmail needs an app password, not your Google Account password. Turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.",
    );
    expect(passwordHint("imap.mail.me.com")).toBe(
      "iCloud needs an app-specific password, not your Apple Account password. Create one at account.apple.com, under Sign-In and Security.",
    );
  });

  it("names app passwords and the IMAP switch for the hosts that need them", () => {
    expect(passwordHint("imap.mail.yahoo.com")).toBe(
      "Yahoo Mail needs an app password, not your Yahoo account password. Create one in your Yahoo account's security settings.",
    );
    expect(passwordHint("imap.aol.com")).toMatch(/^AOL Mail needs an app password/);
    expect(passwordHint("imap.fastmail.com")).toBe(
      "Fastmail needs an app password, not your Fastmail password. Create one in Fastmail's settings.",
    );
    for (const [host, name] of [
      ["imap.wp.pl", "WP Poczta"],
      ["poczta.o2.pl", "o2 Poczta"],
      ["imap.poczta.onet.pl", "Onet Poczta"],
      ["poczta.interia.pl", "Poczta Interia"],
      ["imap.gmx.net", "GMX"],
      ["imap.web.de", "WEB.DE"],
    ] as const) {
      expect(passwordHint(host)).toBe(
        `${name} lets mail apps in only once that's switched on. Turn on IMAP access in its webmail settings first, then enter your usual password here.`,
      );
    }
  });

  it("says the general line for any other host", () => {
    expect(passwordHint("imap.example.pl")).toBe(
      "Your mailbox password. With two-factor sign-in, most hosts want an app password here.",
    );
  });
});
