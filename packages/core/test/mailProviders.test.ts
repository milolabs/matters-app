import { describe, expect, it } from "vitest";
import {
  choosableProviders,
  isMailProviderId,
  MAIL_PROVIDERS,
  mailProvider,
  providerFromSigns,
  spfIncludes,
} from "../src/index.ts";

const none = { exchangers: [], autodiscover: [], txt: [] };

describe("who runs the mail, from DNS signs (ADR 0135)", () => {
  it("decides by the mail exchanger's name, the most preferred first", () => {
    expect(
      providerFromSigns({ ...none, exchangers: ["firma-pl.mail.protection.outlook.com."] }),
    ).toEqual({ id: "microsoft", decides: true, by: "mx" });
    expect(
      providerFromSigns({ ...none, exchangers: ["hotmail-com.olc.protection.outlook.com"] }),
    ).toEqual({ id: "microsoft", decides: true, by: "mx" });
    expect(
      providerFromSigns({ ...none, exchangers: ["mx.gateway.example", "ASPMX.L.GOOGLE.COM"] }),
    ).toEqual({ id: "google", decides: true, by: "mx" });
    expect(providerFromSigns({ ...none, exchangers: ["smtp.googlemail.com"] })?.id).toBe("google");
    // A name that only looks alike is no sign.
    expect(providerFromSigns({ ...none, exchangers: ["mail.notgoogle.com"] })).toBeUndefined();
    expect(
      providerFromSigns({ ...none, exchangers: ["protection.outlook.com.evil.example"] }),
    ).toBeUndefined();
  });

  it("decides by the autodiscover CNAME when the exchanger is a gateway", () => {
    expect(
      providerFromSigns({
        exchangers: ["mx1.gateway.example"],
        autodiscover: ["autodiscover.outlook.com"],
        txt: ["v=spf1 include:_spf.google.com -all"],
      }),
    ).toEqual({ id: "microsoft", decides: true, by: "autodiscover" });
    expect(
      providerFromSigns({ ...none, autodiscover: ["autodiscover.notoutlook.com"] }),
    ).toBeUndefined();
  });

  it("takes SPF as a hint only, and only when it names one provider", () => {
    expect(
      providerFromSigns({
        ...none,
        txt: ["v=spf1 ip4:192.0.2.1 ~include:spf.protection.outlook.com -all"],
      }),
    ).toEqual({ id: "microsoft", decides: false, by: "spf" });
    expect(
      providerFromSigns({
        ...none,
        txt: ["v=spf1 include:spf.protection.outlook.com include:_spf.google.com ~all"],
      }),
    ).toBeUndefined();
    // Not an SPF record, or no include of a known provider.
    expect(providerFromSigns({ ...none, txt: ["include:_spf.google.com"] })).toBeUndefined();
    expect(providerFromSigns(none)).toBeUndefined();
  });

  it("reads the includes of SPF records only", () => {
    expect(
      spfIncludes([
        "google-site-verification=abc",
        "V=SPF1 include:A.example. -include:b.example redirect=c.example",
      ]),
    ).toEqual(["a.example", "b.example"]);
  });

  it("keeps a short table that holds no server settings, and says what can be chosen by hand", () => {
    expect(choosableProviders().map((p) => p.id)).toEqual(["microsoft", "google"]);
    expect(mailProvider("microsoft")?.transport).toBe("graph");
    expect(mailProvider("google")?.settingsDomain).toBe("gmail.com");
    expect(isMailProviderId("google")).toBe(true);
    expect(isMailProviderId("yahoo")).toBe(false);
    for (const rule of MAIL_PROVIDERS) {
      expect(Object.keys(rule).sort()).not.toContain("imap");
      expect(rule.signs.mx.every((s) => s.startsWith("."))).toBe(true);
    }
  });
});
