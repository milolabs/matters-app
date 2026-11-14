import type { BrowserSignInFailure, TokenRenewal } from "@matters/core";
import { serverSentence } from "@matters/core";

/**
 * Microsoft's codes (`AADSTS<n>`) that mean the organisation does not let the person agree to
 * the app (ADR 0133, rule 12): 65001, no consent given; 90094, an administrator must grant it.
 */
const ADMIN_CODES: ReadonlySet<number> = new Set([65001, 90094]);
/** The person declined on the consent page: a sign-in not finished, not an organisation's no. */
const DECLINED_CODES: ReadonlySet<number> = new Set([65004]);
/** OAuth `error` values that mean an administrator has to approve the app. */
const ADMIN_ERRORS: ReadonlySet<string> = new Set(["access_denied", "consent_required"]);
/** A refresh refused for good: only a new sign-in ends it (rule 8). */
const ENDED_ERRORS: ReadonlySet<string> = new Set(["invalid_grant", "interaction_required"]);

/** The codes in a description ("AADSTS65001: ...") and in `error_codes`. */
function codesOf(description: string | undefined, codes: readonly number[] = []): Set<number> {
  const found = new Set(codes);
  for (const m of (description ?? "").matchAll(/\bAADSTS(\d+)\b/g)) found.add(Number(m[1]));
  return found;
}

/** More of a description than this is never read. */
const MAX_DESCRIPTION = 4000;

/**
 * The provider's description, fit to show as a quote (ADR 0114, rule 3): Microsoft's trace and
 * correlation ids and timestamp are cut, and `serverSentence` does the rest (links with a query,
 * addresses, control characters, length).
 */
export function providerSentence(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  // The description comes from outside: bounded first, and cut with a pattern that cannot be
  // made slow.
  const text = description.slice(0, MAX_DESCRIPTION);
  const at = text.search(/(?:Trace ID|Correlation ID|Timestamp):/i);
  return serverSentence((at < 0 ? text : text.slice(0, at)).trimEnd(), { secrets: [] });
}

/**
 * What an `error` from the authorization endpoint (on the redirect) or from the code exchange
 * means for the person (rule 12). A person who cancels gets `notFinished`; an organisation that
 * does not let its people agree gets `adminApproval`, with Microsoft's own sentence.
 */
export function signInFailureOf(
  error: string,
  description: string | undefined,
  codes: readonly number[] = [],
): BrowserSignInFailure {
  const found = codesOf(description, codes);
  const providerText = providerSentence(description);
  const withText = providerText === undefined ? {} : { providerText };
  if ([...found].some((c) => DECLINED_CODES.has(c))) return { ok: false, reason: "notFinished" };
  if (ADMIN_ERRORS.has(error) || [...found].some((c) => ADMIN_CODES.has(c))) {
    return { ok: false, reason: "adminApproval", ...withText };
  }
  return { ok: false, reason: "failed", ...withText };
}

/** What a refused or failed refresh means (rules 7, 8). The reason holds no token. */
export function renewalFailureOf(
  answer:
    | { readonly kind: "unreachable"; readonly reason: string }
    | { readonly kind: "badAnswer"; readonly reason: string }
    | { readonly kind: "refused"; readonly error: string; readonly codes: readonly number[] },
): Extract<TokenRenewal, { ok: false }> {
  switch (answer.kind) {
    case "unreachable":
      return { ok: false, failure: "unreachable", reason: answer.reason };
    case "badAnswer":
      return { ok: false, failure: "other", reason: answer.reason };
    case "refused": {
      const codes = answer.codes.length > 0 ? ` (${answer.codes.join(", ")})` : "";
      // The `error` value is a code from a short list; anything else is not written to logs.
      const error = /^[a-z_]{1,40}$/.test(answer.error) ? answer.error : "error";
      return {
        ok: false,
        failure: ENDED_ERRORS.has(answer.error) ? "signInAgain" : "other",
        reason: `The token endpoint refused the renewal: ${error}${codes}`,
      };
    }
  }
}
