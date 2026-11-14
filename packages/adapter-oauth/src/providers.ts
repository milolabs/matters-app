import type { OAuthProvider } from "@matters/core";

/**
 * What Matters needs to know of one provider's sign-in. The facts are the provider's own pages
 * as of 2026-11 (ADR 0133, Context) and live here only; the client id does not, since a fork or
 * an organisation brings its own (rule 4).
 */
export interface ProviderEntry {
  readonly id: OAuthProvider;
  /** Base of the endpoints: the tenant segment included. */
  readonly authority: string;
  readonly authorizePath: string;
  readonly tokenPath: string;
  /** Asked for at sign-in and at every renewal (rule 3). */
  readonly scopes: readonly string[];
  /** Further parameters of the authorization request (rule 1). */
  readonly authorizeParams: Readonly<Record<string, string>>;
}

/**
 * Microsoft's identity platform, v2.0 endpoints. `common` takes work and school accounts of any
 * organisation and personal Microsoft accounts (rule 4). The two Exchange scopes belong to one
 * resource, so one access token serves IMAP and SMTP (rule 9); `offline_access` gives a refresh
 * token; `openid profile email` an id token that says who signed in (rule 3).
 */
export const MICROSOFT: ProviderEntry = {
  id: "microsoft",
  authority: "https://login.microsoftonline.com/common",
  authorizePath: "/oauth2/v2.0/authorize",
  tokenPath: "/oauth2/v2.0/token",
  scopes: [
    "https://outlook.office.com/IMAP.AccessAsUser.All",
    "https://outlook.office.com/SMTP.Send",
    "offline_access",
    "openid",
    "profile",
    "email",
  ],
  authorizeParams: { prompt: "select_account" },
};

/**
 * Microsoft Graph (ADR 0136, rule 3): the same authority, registration and client id as
 * `MICROSOFT`, with Graph's two delegated mail permissions and no `outlook.office.com` scope, so
 * the token is Graph's (scopes of two resources cannot be mixed in one token). A credential keeps
 * which entry it was made with, so a renewal asks for these scopes again.
 */
export const MICROSOFT_GRAPH: ProviderEntry = {
  ...MICROSOFT,
  id: "microsoftGraph",
  scopes: [
    "https://graph.microsoft.com/Mail.ReadWrite",
    "https://graph.microsoft.com/Mail.Send",
    "offline_access",
    "openid",
    "profile",
    "email",
  ],
};

export const PROVIDERS: Readonly<Record<OAuthProvider, ProviderEntry>> = {
  microsoft: MICROSOFT,
  microsoftGraph: MICROSOFT_GRAPH,
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The authority to use in place of the provider's: only a plain http address on this machine
 * (rule 13), which is what a stand-in server in a test has. Anything else throws, so no setting
 * can send a sign-in, its code or its tokens to another server.
 */
export function loopbackAuthority(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The authorization server must be a loopback http address");
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("The authorization server must be a loopback http address");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}
