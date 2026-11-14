import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A PKCE code verifier (RFC 7636, section 4.1): 32 random bytes as base64url, 43 characters
 * from the unreserved set. It never leaves main but in the one token request over TLS.
 */
export function createVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 challenge of a verifier (RFC 7636, section 4.2). */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A random `state` for one sign-in: 128 bits, base64url. */
export function createState(): string {
  return randomBytes(16).toString("base64url");
}

/** Whether `got` is `expected`, without telling by timing how much of it matched. */
export function sameSecret(got: string | null, expected: string): boolean {
  if (got === null) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
