import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the stand-in was given, with its parameters (query or form). */
export interface AuthServerRequest {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/** What the token endpoint answers instead of tokens, once. */
export interface ScriptedTokenError {
  readonly status: number;
  readonly error: string;
  readonly description?: string;
  readonly codes?: readonly number[];
}

export interface StandInAuthServer {
  /** Pass this as the adapter's authority override: `http://127.0.0.1:<port>/common`. */
  readonly authority: string;
  readonly clientId: string;
  /**
   * Who signs in when the "browser" opens the authorization page: the id token's `email` and
   * `preferred_username`. Null: the person closes the tab (nothing comes back).
   */
  signInAs: { email?: string; preferredUsername?: string } | null;
  /** The authorization endpoint redirects with this error instead of a code. */
  authorizeError: { error: string; description?: string } | null;
  /** The token endpoint answers these, first in first out, before anything else. */
  readonly tokenErrors: ScriptedTokenError[];
  /** `expires_in` of the access tokens it issues. */
  accessTokenTtlS: number;
  /** Whether a refresh replaces the refresh token (and the old one stops working). */
  rotateRefreshTokens: boolean;
  /** Whether a token response carries a refresh token at all. */
  issueRefreshTokens: boolean;
  /** Every request, in order. */
  readonly requests: AuthServerRequest[];
  /** Access tokens issued, in order. */
  readonly accessTokens: string[];
  /** Refresh tokens that still work. */
  readonly validRefreshTokens: Set<string>;
  /** Holds the token endpoint's answers until `release()`; counts those waiting. */
  hold(): void;
  release(): void;
  waiting(): number;
  /**
   * Plays the browser: opens the authorization URL, and follows its redirect to the loopback
   * address the way a browser would. Use as the adapter's `openBrowser`.
   */
  browse(url: string): Promise<void>;
  stop(): Promise<void>;
}

const AUTHORIZE = "/common/oauth2/v2.0/authorize";
const TOKEN = "/common/oauth2/v2.0/token";

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const token = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;

/**
 * A stand-in for Microsoft's identity platform v2.0 (ADR 0133, rule 13) on the loopback
 * address: the authorization endpoint, which "signs in" at once as `signInAs` and redirects with
 * a code, and the token endpoint, which checks the client id, the code, the redirect and the
 * PKCE verifier (S256) and rotates refresh tokens. Its id tokens are unsigned; the adapter does
 * not check signatures (it trusts the TLS connection to the real endpoint).
 */
export async function startStandInAuthServer(
  options: { readonly clientId?: string } = {},
): Promise<StandInAuthServer> {
  const clientId = options.clientId ?? "00000000-test-client";
  const codes = new Map<
    string,
    { redirectUri: string; challenge: string; email?: string; preferredUsername?: string }
  >();
  const held: (() => void)[] = [];
  let holding = false;

  const self: StandInAuthServer = {
    authority: "",
    clientId,
    signInAs: { email: "me@outlook.example" },
    authorizeError: null,
    tokenErrors: [],
    accessTokenTtlS: 3600,
    rotateRefreshTokens: true,
    issueRefreshTokens: true,
    requests: [],
    accessTokens: [],
    validRefreshTokens: new Set(),
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const run of held.splice(0)) run();
    },
    waiting: () => held.length,
    browse: async (url) => {
      const page = await fetch(url, { redirect: "manual" });
      const location = page.headers.get("location");
      // Nothing to follow: the person closed the tab.
      if (location !== null) await fetch(location).then((r) => r.text());
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const issue = (claims: { email?: string; preferredUsername?: string }) => {
    const accessToken = token("at");
    self.accessTokens.push(accessToken);
    const refreshToken = token("rt");
    if (self.issueRefreshTokens) self.validRefreshTokens.add(refreshToken);
    const idToken = [
      b64url(JSON.stringify({ alg: "none", typ: "JWT" })),
      b64url(
        JSON.stringify({
          aud: clientId,
          ...(claims.email === undefined ? {} : { email: claims.email }),
          ...(claims.preferredUsername === undefined
            ? {}
            : { preferred_username: claims.preferredUsername }),
        }),
      ),
      "",
    ].join(".");
    return {
      token_type: "Bearer",
      expires_in: self.accessTokenTtlS,
      access_token: accessToken,
      ...(self.issueRefreshTokens ? { refresh_token: refreshToken } : {}),
      id_token: idToken,
    };
  };

  const onAuthorize = (params: Record<string, string>, response: ServerResponse) => {
    const redirect = params.redirect_uri ?? "";
    if (params.client_id !== clientId || !redirect.startsWith("http://localhost:")) {
      response.writeHead(400).end("bad request");
      return;
    }
    if (self.signInAs === null && self.authorizeError === null) {
      response.writeHead(200, { "content-type": "text/html" }).end("<p>Sign in</p>");
      return;
    }
    const back = new URL(redirect);
    back.searchParams.set("state", params.state ?? "");
    if (self.authorizeError !== null) {
      back.searchParams.set("error", self.authorizeError.error);
      if (self.authorizeError.description !== undefined) {
        back.searchParams.set("error_description", self.authorizeError.description);
      }
    } else {
      const code = token("code");
      codes.set(code, {
        redirectUri: redirect,
        challenge: params.code_challenge ?? "",
        ...self.signInAs,
      });
      back.searchParams.set("code", code);
    }
    response.writeHead(302, { location: back.toString() }).end();
  };

  const onToken = (params: Record<string, string>, response: ServerResponse) => {
    const scripted = self.tokenErrors.shift();
    if (scripted !== undefined) {
      json(response, scripted.status, {
        error: scripted.error,
        ...(scripted.description === undefined ? {} : { error_description: scripted.description }),
        error_codes: scripted.codes ?? [],
      });
      return;
    }
    const refuse = (description: string) =>
      json(response, 400, { error: "invalid_grant", error_description: description });
    if (params.client_id !== clientId) {
      json(response, 400, { error: "invalid_client" });
      return;
    }
    if (params.client_secret !== undefined) {
      json(response, 400, { error: "invalid_request", error_description: "Public client" });
      return;
    }
    if (params.grant_type === "authorization_code") {
      const grant = codes.get(params.code ?? "");
      codes.delete(params.code ?? "");
      if (grant === undefined) return refuse("Unknown or used code");
      if (grant.redirectUri !== params.redirect_uri) return refuse("Redirect does not match");
      const challenge = createHash("sha256")
        .update(params.code_verifier ?? "")
        .digest("base64url");
      if (challenge !== grant.challenge) return refuse("PKCE verification failed");
      json(response, 200, issue(grant));
      return;
    }
    if (params.grant_type === "refresh_token") {
      const old = params.refresh_token ?? "";
      if (!self.validRefreshTokens.has(old))
        return refuse("AADSTS70008: The refresh token has expired");
      const accessToken = token("at");
      self.accessTokens.push(accessToken);
      const body: Record<string, unknown> = {
        token_type: "Bearer",
        expires_in: self.accessTokenTtlS,
        access_token: accessToken,
      };
      if (self.rotateRefreshTokens) {
        const next = token("rt");
        self.validRefreshTokens.delete(old);
        self.validRefreshTokens.add(next);
        body.refresh_token = next;
      }
      json(response, 200, body);
      return;
    }
    json(response, 400, { error: "unsupported_grant_type" });
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const params: Record<string, string> = {};
      const source =
        request.method === "POST"
          ? new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
          : url.searchParams;
      for (const [key, value] of source) params[key] = value;
      self.requests.push({ path: url.pathname, params });
      const run = () => {
        if (request.method === "GET" && url.pathname === AUTHORIZE) onAuthorize(params, response);
        else if (request.method === "POST" && url.pathname === TOKEN) onToken(params, response);
        else response.writeHead(404).end();
      };
      if (holding && url.pathname === TOKEN) held.push(run);
      else run();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  (self as { authority: string }).authority = `http://127.0.0.1:${port}/common`;
  return self;
}
