import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  challengeOf,
  createState,
  createVerifier,
  loopbackAuthority,
  MICROSOFT,
} from "../src/index.ts";

describe("PKCE and state", () => {
  it("makes a verifier of 43 unreserved characters, new each time", () => {
    const a = createVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(a);
  });

  it("derives the S256 challenge as RFC 7636 says", () => {
    // The example of RFC 7636, appendix B.
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const v = createVerifier();
    expect(challengeOf(v)).toBe(createHash("sha256").update(v).digest("base64url"));
  });

  it("makes a random state of 128 bits", () => {
    const s = createState();
    expect(Buffer.from(s, "base64url")).toHaveLength(16);
    expect(createState()).not.toBe(s);
  });
});

describe("authorizeUrl (ADR 0133, rule 1)", () => {
  const url = new URL(
    authorizeUrl(MICROSOFT, MICROSOFT.authority, {
      clientId: "client-1",
      redirectUri: "http://localhost:50123/",
      state: "st",
      challenge: "ch",
      loginHint: "me@outlook.com",
    }),
  );

  it("goes to Microsoft's v2.0 authorization endpoint for any organisation", () => {
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
  });

  it("asks for a code with PKCE, the state, the hint and an account picker", () => {
    const p = Object.fromEntries(url.searchParams);
    expect(p).toEqual({
      client_id: "client-1",
      response_type: "code",
      redirect_uri: "http://localhost:50123/",
      response_mode: "query",
      scope:
        "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid profile email",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      login_hint: "me@outlook.com",
      prompt: "select_account",
    });
  });
});

describe("loopbackAuthority (ADR 0133, rule 13)", () => {
  it("takes a plain http address on this machine", () => {
    expect(loopbackAuthority("http://127.0.0.1:4000/common")).toBe("http://127.0.0.1:4000/common");
    expect(loopbackAuthority("http://localhost:4000/common/")).toBe("http://localhost:4000/common");
    expect(loopbackAuthority("http://[::1]:4000/x")).toBe("http://[::1]:4000/x");
  });

  it.each([
    "https://login.microsoftonline.com/common",
    "https://127.0.0.1:4000/common",
    "http://example.com/common",
    "http://127.0.0.2/common",
    "http://localhost.example.com/common",
    "http://user:pw@127.0.0.1/common",
    "http://127.0.0.1/common?x=1",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => loopbackAuthority(url)).toThrow(/loopback/);
  });
});
