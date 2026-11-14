import { ManualClock, type StandInAuthServer, startStandInAuthServer } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  addressesOf,
  BrowserOAuth,
  type BrowserOAuthOptions,
  providerSentence,
  signInFailureOf,
} from "../src/index.ts";

const servers: StandInAuthServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function setup(over: Partial<BrowserOAuthOptions> = {}) {
  const server = await startStandInAuthServer();
  servers.push(server);
  const clock = new ManualClock();
  const opened: string[] = [];
  const oauth = new BrowserOAuth({
    clientIds: { microsoft: server.clientId },
    authority: server.authority,
    now: () => 1_000_000,
    schedule: (run, ms) => clock.setTimeout(run, ms),
    openBrowser: async (url) => {
      opened.push(url);
      await server.browse(url);
    },
    ...over,
  });
  return { server, oauth, clock, opened };
}

const ask = { provider: "microsoft", address: "Me@Outlook.example" } as const;

describe("BrowserOAuth.signIn against a stand-in server (ADR 0133, rules 1 to 3)", () => {
  it("opens the browser, trades the code with the verifier, and returns the tokens", async () => {
    const t = await setup();
    const result = await t.oauth.signIn(ask);
    expect(result).toMatchObject({
      ok: true,
      provider: "microsoft",
      address: "me@outlook.example",
      tokens: { expiresAtMs: 1_000_000 + 3600_000 },
    });
    if (!result.ok) throw new Error("no sign-in");
    expect(result.tokens.accessToken).toBe(t.server.accessTokens[0]);
    expect(t.server.validRefreshTokens.has(result.tokens.refreshToken)).toBe(true);

    const authorize = new URL(t.opened[0] ?? "");
    expect(authorize.searchParams.get("login_hint")).toBe("Me@Outlook.example");
    const exchange = t.server.requests.find((r) => r.params.grant_type === "authorization_code");
    expect(exchange?.params).toMatchObject({
      client_id: t.server.clientId,
      redirect_uri: authorize.searchParams.get("redirect_uri"),
    });
    expect(exchange?.params.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange?.params.client_secret).toBeUndefined();
  });

  it("keeps nothing when another account signed in, and says which (rule 3)", async () => {
    const t = await setup();
    t.server.signInAs = { email: "someone@else.example" };
    expect(await t.oauth.signIn(ask)).toEqual({
      ok: false,
      reason: "wrongAccount",
      signedIn: "someone@else.example",
      asked: "Me@Outlook.example",
    });
  });

  it("takes a work account whose sign-in name is the address typed", async () => {
    const t = await setup();
    t.server.signInAs = {
      email: "jan@contoso.example",
      preferredUsername: "me@outlook.example",
    };
    expect(await t.oauth.signIn(ask)).toMatchObject({ ok: true });
  });

  it("is not offered without a client id (rule 4)", async () => {
    const t = await setup({ clientIds: {} });
    expect(t.oauth.offers("microsoft")).toBe(false);
    expect(await t.oauth.signIn(ask)).toEqual({ ok: false, reason: "notOffered" });
    expect(t.opened).toEqual([]);
  });

  it("refuses an authority that is not a loopback address (rule 13)", () => {
    expect(
      () =>
        new BrowserOAuth({
          clientIds: { microsoft: "x" },
          authority: "https://login.example.com/common",
          openBrowser: async () => {},
        }),
    ).toThrow(/loopback/);
  });

  it("calls a closed tab not finished after 5 minutes", async () => {
    const t = await setup();
    t.server.signInAs = null;
    const result = t.oauth.signIn(ask);
    await new Promise((r) => setTimeout(r, 20));
    await t.clock.advance(5 * 60_000);
    expect(await result).toEqual({ ok: false, reason: "notFinished" });
  });

  it("ends when the person cancels", async () => {
    const t = await setup();
    t.server.signInAs = null;
    const controller = new AbortController();
    const result = t.oauth.signIn({ ...ask, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await result).toEqual({ ok: false, reason: "notFinished" });
  });

  it("runs one sign-in at a time: a second one ends the first", async () => {
    const t = await setup();
    t.server.signInAs = null;
    const first = t.oauth.signIn(ask);
    await new Promise((r) => setTimeout(r, 20));
    const firstRedirect = new URL(t.opened[0] ?? "").searchParams.get("redirect_uri") ?? "";
    t.server.signInAs = { email: "me@outlook.example" };
    const second = t.oauth.signIn(ask);
    expect(await first).toEqual({ ok: false, reason: "notFinished" });
    expect(await second).toMatchObject({ ok: true });
    // The first one's port no longer answers.
    const port = new URL(firstRedirect).port;
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("says the organisation must approve when Microsoft says so in the browser (rule 12)", async () => {
    const t = await setup();
    t.server.authorizeError = {
      error: "access_denied",
      description:
        "AADSTS65001: The user or administrator has not consented to use the application.\r\nTrace ID: 1234\r\nCorrelation ID: 5678\r\nTimestamp: 2026-11-14",
    };
    expect(await t.oauth.signIn(ask)).toEqual({
      ok: false,
      reason: "adminApproval",
      providerText:
        "AADSTS65001: The user or administrator has not consented to use the application.",
    });
  });

  it("maps a refused code exchange and an unreachable token endpoint", async () => {
    const t = await setup();
    t.server.tokenErrors.push({
      status: 400,
      error: "invalid_grant",
      description: "AADSTS90094: An administrator must grant permission.",
      codes: [90094],
    });
    expect(await t.oauth.signIn(ask)).toMatchObject({ ok: false, reason: "adminApproval" });

    t.server.tokenErrors.push({ status: 503, error: "temporarily_unavailable" });
    expect(await t.oauth.signIn(ask)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("refuses a sign-in that gave no refresh token", async () => {
    const t = await setup();
    t.server.issueRefreshTokens = false;
    expect(await t.oauth.signIn(ask)).toEqual({ ok: false, reason: "failed" });
  });

  it("reports a browser that could not be opened", async () => {
    const t = await setup({
      openBrowser: async () => {
        throw new Error("no browser");
      },
    });
    expect(await t.oauth.signIn(ask)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("BrowserOAuth.renew (rules 7, 8)", () => {
  async function signedIn() {
    const t = await setup();
    const result = await t.oauth.signIn(ask);
    if (!result.ok) throw new Error("no sign-in");
    return { ...t, refreshToken: result.tokens.refreshToken };
  }

  it("trades the refresh token for a new access token and a rotated refresh token", async () => {
    const t = await signedIn();
    const renewal = await t.oauth.renew("microsoft", t.refreshToken);
    if (!renewal.ok) throw new Error(renewal.reason);
    expect(renewal.tokens.accessToken).toBe(t.server.accessTokens.at(-1));
    expect(renewal.tokens.refreshToken).not.toBe(t.refreshToken);
    expect(renewal.tokens.expiresAtMs).toBe(1_000_000 + 3600_000);
    const request = t.server.requests.at(-1)?.params;
    expect(request).toMatchObject({ grant_type: "refresh_token", client_id: t.server.clientId });
    expect(request?.scope).toContain("offline_access");
  });

  it("asks Graph's scopes for Graph's entry, at sign-in and at renewal (ADR 0136, rule 3)", async () => {
    // Each entry is offered by its own id; main gives both the one registration's id.
    const g = await setup();
    expect(g.oauth.offers("microsoftGraph")).toBe(false);
    const both = new BrowserOAuth({
      clientIds: { microsoft: g.server.clientId, microsoftGraph: g.server.clientId },
      authority: g.server.authority,
      now: () => 1_000_000,
      schedule: (run, ms) => g.clock.setTimeout(run, ms),
      openBrowser: (url) => g.server.browse(url),
    });
    const result = await both.signIn({ ...ask, provider: "microsoftGraph" });
    if (!result.ok) throw new Error("no sign-in");
    expect(result.provider).toBe("microsoftGraph");
    const graphScope = [
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
      "offline_access",
      "openid",
      "profile",
      "email",
    ].join(" ");
    expect(g.server.requests.at(-1)?.params.scope).toBe(graphScope);
    await both.renew("microsoftGraph", result.tokens.refreshToken);
    expect(g.server.requests.at(-1)?.params).toMatchObject({
      grant_type: "refresh_token",
      scope: graphScope,
    });
    expect(graphScope).not.toContain("outlook.office.com");
  });

  it("leaves the refresh token out when the server keeps the old one", async () => {
    const t = await signedIn();
    t.server.rotateRefreshTokens = false;
    const renewal = await t.oauth.renew("microsoft", t.refreshToken);
    expect(renewal.ok).toBe(true);
    expect(renewal.ok && "refreshToken" in renewal.tokens).toBe(false);
  });

  it("calls a refused refresh token a sign-in to do again, without the token", async () => {
    const t = await signedIn();
    t.server.validRefreshTokens.clear();
    const renewal = await t.oauth.renew("microsoft", t.refreshToken);
    expect(renewal).toMatchObject({ ok: false, failure: "signInAgain" });
    expect(JSON.stringify(renewal)).not.toContain(t.refreshToken);

    t.server.tokenErrors.push({ status: 400, error: "interaction_required" });
    expect(await t.oauth.renew("microsoft", t.refreshToken)).toMatchObject({
      failure: "signInAgain",
    });
    t.server.tokenErrors.push({ status: 400, error: "invalid_client" });
    expect(await t.oauth.renew("microsoft", t.refreshToken)).toMatchObject({ failure: "other" });
  });

  it("calls a server that cannot be reached unreachable", async () => {
    const t = await signedIn();
    t.server.tokenErrors.push({ status: 500, error: "server_error" });
    expect(await t.oauth.renew("microsoft", t.refreshToken)).toMatchObject({
      ok: false,
      failure: "unreachable",
    });
    await t.server.stop();
    servers.splice(servers.indexOf(t.server), 1);
    const renewal = await t.oauth.renew("microsoft", t.refreshToken);
    expect(renewal).toMatchObject({ ok: false, failure: "unreachable" });
    expect(JSON.stringify(renewal)).not.toContain(t.refreshToken);
  });
});

describe("error mapping (rule 12)", () => {
  it.each([
    ["access_denied", undefined, "adminApproval"],
    ["consent_required", undefined, "adminApproval"],
    ["invalid_grant", "AADSTS65001: no consent", "adminApproval"],
    ["invalid_request", "AADSTS90094: admin must grant", "adminApproval"],
    ["access_denied", "AADSTS65004: User declined to consent", "notFinished"],
    ["server_error", "Something broke", "failed"],
    ["invalid_request", undefined, "failed"],
  ] as const)("%s (%s) is %s", (error, description, reason) => {
    expect(signInFailureOf(error, description).reason).toBe(reason);
  });

  it("keeps Microsoft's sentence without its trace ids, links or addresses", () => {
    expect(
      providerSentence(
        "AADSTS65001: Ask jan@contoso.example, see https://login.example/x?token=1.\r\nTrace ID: abc",
      ),
    ).toBe("AADSTS65001: Ask …, see");
  });
});

describe("addressesOf", () => {
  const idToken = (claims: object) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;

  it("reads email and preferred_username from the payload", () => {
    expect(
      addressesOf(idToken({ email: "a@x.example", preferred_username: "b@x.example" })),
    ).toEqual(["a@x.example", "b@x.example"]);
    expect(addressesOf(idToken({ preferred_username: "b@x.example", name: "B" }))).toEqual([
      "b@x.example",
    ]);
  });

  it("finds nothing in a token that is not one", () => {
    expect(addressesOf(undefined)).toEqual([]);
    expect(addressesOf("garbage")).toEqual([]);
    expect(addressesOf("x.%%%.y")).toEqual([]);
    expect(addressesOf(idToken({ preferred_username: "no-at-sign" }))).toEqual([]);
  });
});
