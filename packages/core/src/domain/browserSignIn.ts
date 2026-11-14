/**
 * Sign-in in the person's own browser (OAuth 2.0 with PKCE, ADR 0133). The core knows only
 * these shapes; the flow itself lives in an adapter behind `BrowserSignInPort`, and the tokens
 * live in main's vault (rule 5).
 */

/**
 * The entries a browser sign-in is made with; a credential keeps which, so a renewal asks for the
 * same scopes (ADR 0133, rule 5).
 * - `microsoft`: Microsoft's mail servers over IMAP and SMTP, with the `outlook.office.com`
 *   scopes (ADR 0133).
 * - `microsoftGraph`: Microsoft Graph, with the Graph mail scopes (ADR 0136, rule 3). The same
 *   registration and client id; the screens say *Microsoft* for both.
 */
export type OAuthProvider = "microsoft" | "microsoftGraph";

const PROVIDERS: ReadonlySet<string> = new Set<OAuthProvider>(["microsoft", "microsoftGraph"]);

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && PROVIDERS.has(value);
}

/** What the token endpoint gave for one sign-in or one renewal. */
export interface OAuthTokens {
  readonly accessToken: string;
  /**
   * The refresh token. A renewal may leave it out, which means the one used stays valid; when
   * it sends one, it replaces the old (rule 7).
   */
  readonly refreshToken?: string;
  /** When the access token ends, from `expires_in`. */
  readonly expiresAtMs: number;
}

/** A sign-in that worked, with the address the provider says signed in. */
export interface BrowserSignInSuccess {
  readonly ok: true;
  readonly provider: OAuthProvider;
  readonly tokens: OAuthTokens & { readonly refreshToken: string };
  /** The account that signed in; the same as the one asked for, in any case (rule 3). */
  readonly address: string;
}

/**
 * Why a browser sign-in gave nothing (rule 12), as a closed set the screens say something
 * specific about. `providerText` is the provider's own sentence, cleaned like a server's
 * (`serverSentence`): for showing as a quote, never for logic or logs.
 *
 * - `notFinished`: the person cancelled, closed the tab, waited past the 5 minutes, or started
 *   another sign-in. Trying again is the next step.
 * - `adminApproval`: the organisation does not let its people agree to the app; an
 *   administrator has to approve it (`access_denied`, `consent_required`, AADSTS65001,
 *   AADSTS90094).
 * - `wrongAccount`: another account signed in than the one typed (rule 3). Nothing was kept.
 * - `unreachable`: the provider's token endpoint could not be reached.
 * - `notOffered`: this build has no client id for the provider (rule 4).
 * - `failed`: the provider said no for another reason.
 */
export type BrowserSignInFailure =
  | { readonly ok: false; readonly reason: "notFinished" }
  | { readonly ok: false; readonly reason: "adminApproval"; readonly providerText?: string }
  | {
      readonly ok: false;
      readonly reason: "wrongAccount";
      readonly signedIn: string;
      readonly asked: string;
    }
  | { readonly ok: false; readonly reason: "unreachable" }
  | { readonly ok: false; readonly reason: "notOffered" }
  | { readonly ok: false; readonly reason: "failed"; readonly providerText?: string };

export type BrowserSignInResult = BrowserSignInSuccess | BrowserSignInFailure;

/**
 * What a renewal at the token endpoint came to (rules 7, 8).
 * - `signInAgain`: the provider refused the refresh token (`invalid_grant`: withdrawn, a
 *   changed password, unused for too long). Only a new sign-in ends it.
 * - `unreachable`: the provider could not be reached; a later try can pass by itself.
 * - `other`: any other refusal or a bad answer.
 */
export type TokenRenewal =
  | { readonly ok: true; readonly tokens: OAuthTokens }
  | {
      readonly ok: false;
      readonly failure: "signInAgain" | "unreachable" | "other";
      /** For logs: never holds a token. */
      readonly reason: string;
    };

/**
 * The shape of the handle main gives for a held sign-in (ADR 0133, rule 6): a fixed prefix and
 * 128 random bits in hex. The backend takes nothing else where a handle goes, so an account's
 * own id can never be passed off as a sign-in to move.
 */
const SIGN_IN_HANDLE = /^signin-[0-9a-f]{32}$/;

export function isSignInHandle(value: unknown): value is string {
  return typeof value === "string" && SIGN_IN_HANDLE.test(value);
}
