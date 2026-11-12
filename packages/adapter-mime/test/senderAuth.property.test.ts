// Property tests (ADR 0125): the reader of `Authentication-Results` is given made-up headers by the
// thousand, and what must hold for every one of them is checked. The cases written by hand are in
// senderAuth.test.ts; these look for the header nobody thought of.
import { registrableDomain } from "@matters/adapter-publicsuffix";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authservId, firstTrustedHeader, readSenderAuth } from "../src/index.ts";

const label = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
const VERDICTS = ["pass", "fail", "unknown"];

/** Pieces a real header is made of, mixed with anything at all. */
const piece = fc.oneof(
  fc.constantFrom(
    "dmarc",
    "dkim",
    "spf",
    "pass",
    "fail",
    "none",
    "header.from",
    "header.d",
    "=",
    ";",
    " ",
    "\t",
    "\r\n",
    "(",
    ")",
    '"',
    "\\",
    ".",
    "shop.example",
    "mx.example",
  ),
  fc.string({ maxLength: 8 }),
);
const header = fc.array(piece, { maxLength: 40 }).map((pieces) => pieces.join(""));

describe("Authentication-Results, for any header (ADR 0048)", () => {
  it("always gives a verdict, and never throws", () => {
    fc.assert(
      fc.property(header, fc.option(fc.string(), { nil: undefined }), (value, from) => {
        expect(VERDICTS).toContain(readSenderAuth(value, from, registrableDomain));
        const id = authservId(value);
        expect(id === undefined || id.length > 0).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("reads nothing when no server is trusted", () => {
    fc.assert(
      fc.property(fc.array(header, { maxLength: 5 }), (values) => {
        expect(firstTrustedHeader(values, undefined)).toBeUndefined();
        expect(firstTrustedHeader(values, () => false)).toBeUndefined();
      }),
    );
  });

  it("picks only a header that starts with the trusted server's name", () => {
    const trusted = "mx.trusted.example";
    fc.assert(
      fc.property(fc.array(header, { maxLength: 5 }), header, (others, rest) => {
        // A sender can add headers that mention the trusted name anywhere but at the start.
        const forged = others.map((value) => `evil.example; dmarc=pass ${trusted} ${value}`);
        const real = `${trusted}; ${rest}`;
        expect(firstTrustedHeader(forged, (id) => id === trusted)).toBeUndefined();
        const picked = firstTrustedHeader([...forged, real], (id) => id === trusted);
        expect(picked === undefined || authservId(picked) === trusted).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("never passes a message on a DMARC pass for another domain", () => {
    fc.assert(
      fc.property(label, label, label, header, (mine, theirs, user, noise) => {
        fc.pre(mine !== theirs);
        const from = `${user}@${mine}.example`;
        // The pass is for their domain; whatever else the header says after it, DMARC answered.
        const value = `mx.example; dmarc=pass header.from=${theirs}.example; x=(${noise.replace(/[()\\]/g, "")})`;
        expect(readSenderAuth(value, from, registrableDomain)).not.toBe("pass");
      }),
      { numRuns: 1000 },
    );
  });

  it("passes an aligned DMARC pass whatever the case or the subdomain", () => {
    fc.assert(
      fc.property(label, label, label, fc.boolean(), (domain, sub, user, upper) => {
        const from = `${user}@${sub}.${domain}.example`;
        const value = `mx.example; dmarc=pass header.from=${domain}.example`;
        expect(readSenderAuth(upper ? value.toUpperCase() : value, from, registrableDomain)).toBe(
          "pass",
        );
      }),
    );
  });
});
