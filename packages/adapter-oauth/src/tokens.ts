/** What the token endpoint said to one request (RFC 6749, sections 5.1 and 5.2). */
export type TokenAnswer =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresAtMs: number;
      readonly idToken?: string;
    }
  /** No answer: the network, a timeout, or the server's own trouble (5xx). */
  | { readonly ok: false; readonly kind: "unreachable"; readonly reason: string }
  /** The server's refusal, with its `error`, description and (Microsoft) `error_codes`. */
  | {
      readonly ok: false;
      readonly kind: "refused";
      readonly error: string;
      readonly description?: string;
      readonly codes: readonly number[];
    }
  /** An answer that is not a token response. */
  | { readonly ok: false; readonly kind: "badAnswer"; readonly reason: string };

export const TOKEN_TIMEOUT_MS = 30_000;

/** An access token without `expires_in` is taken to last this long; the provider sends one. */
const DEFAULT_LIFETIME_S = 3600;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * One POST to the token endpoint, form-encoded, over the connection `fetch` makes (TLS for the
 * provider; a loopback stand-in only in tests, rule 13). No client secret: a desktop app is a
 * public client and proves itself with the PKCE verifier (rule 3). Never throws, and what it
 * returns holds no part of the request: the code, the verifier and the refresh token stay out
 * of every reason.
 */
export async function postToken(
  fetchFn: typeof fetch,
  url: string,
  params: Readonly<Record<string, string>>,
  now: () => number,
  signal?: AbortSignal,
): Promise<TokenAnswer> {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    body = await response.json().catch(() => undefined);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return {
      ok: false,
      kind: "unreachable",
      reason:
        name === "TimeoutError"
          ? "The token endpoint did not answer in time"
          : name === "AbortError"
            ? "The request was cancelled"
            : "The token endpoint could not be reached",
    };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      kind: "unreachable",
      reason: `The token endpoint answered ${response.status}`,
    };
  }
  if (!isRecord(body)) {
    return {
      ok: false,
      kind: "badAnswer",
      reason: `The token endpoint answered ${response.status} without JSON`,
    };
  }
  if (!response.ok || typeof body.error === "string") {
    const codes = Array.isArray(body.error_codes)
      ? body.error_codes.filter((c): c is number => typeof c === "number")
      : [];
    return {
      ok: false,
      kind: "refused",
      error: typeof body.error === "string" ? body.error : `http_${response.status}`,
      ...(typeof body.error_description === "string"
        ? { description: body.error_description }
        : {}),
      codes,
    };
  }
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    return { ok: false, kind: "badAnswer", reason: "The token endpoint sent no access token" };
  }
  const expiresIn = Number(body.expires_in);
  const lifetimeS = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_LIFETIME_S;
  return {
    ok: true,
    accessToken,
    expiresAtMs: now() + lifetimeS * 1000,
    ...(typeof body.refresh_token === "string" && body.refresh_token !== ""
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}),
  };
}

/**
 * The addresses an id token says signed in: `email` and `preferred_username` (for a work
 * account the second is the sign-in name, which may differ from the mailbox address).
 *
 * The signature is not checked, on purpose: the token came straight from the provider's token
 * endpoint over TLS in answer to our own request with our verifier (OpenID Connect Core,
 * section 3.1.3.7, point 6 allows this), so nothing between could have written it. It only
 * serves to refuse a sign-in made with another account than the one typed (rule 3); it grants
 * nothing.
 */
export function addressesOf(idToken: string | undefined): readonly string[] {
  if (idToken === undefined) return [];
  const payload = idToken.split(".")[1];
  if (payload === undefined) return [];
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return [];
  }
  if (!isRecord(claims)) return [];
  const found: string[] = [];
  for (const claim of [claims.email, claims.preferred_username]) {
    if (typeof claim === "string" && claim.includes("@") && !found.includes(claim)) {
      found.push(claim.trim());
    }
  }
  return found;
}

/** Whether `address` is one of `signedIn`, in any case (rule 3). */
export function sameAccount(address: string, signedIn: readonly string[]): boolean {
  const asked = address.trim().toLowerCase();
  return signedIn.some((a) => a.toLowerCase() === asked);
}
