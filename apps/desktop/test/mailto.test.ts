import { describe, expect, it } from "vitest";
import { linkForSystem, safeMailto } from "../src/main/mailto.ts";

describe("safeMailto (ADR 0048, RFC 6068 section 4)", () => {
  it("keeps the address, the subject and the body", () => {
    expect(safeMailto("mailto:x@example.org?subject=hi&body=hello%20there")).toBe(
      "mailto:x@example.org?subject=hi&body=hello%20there",
    );
    expect(safeMailto("mailto:x@example.org")).toBe("mailto:x@example.org");
    expect(safeMailto("MAILTO:X@Example.org?SUBJECT=Hi")).toBe("mailto:X@Example.org?subject=Hi");
  });

  it("drops attach, attachment, bcc, cc and every unknown field", () => {
    expect(
      safeMailto("mailto:x@example.org?attach=/etc/hosts&bcc=spy@example.net&subject=hi&body=b"),
    ).toBe("mailto:x@example.org?subject=hi&body=b");
    expect(safeMailto("mailto:x@example.org?attachment=file:///etc/passwd")).toBe(
      "mailto:x@example.org",
    );
    expect(safeMailto("mailto:x@example.org?cc=z@example.net&in-reply-to=%3Cx%3E&x=1")).toBe(
      "mailto:x@example.org",
    );
    expect(safeMailto("mailto:x@example.org?keywords=a&to=y@example.org")).toBe(
      "mailto:x@example.org",
    );
  });

  it("drops a field however its name is spelled", () => {
    expect(safeMailto("mailto:x@example.org?ATTACH=/etc/hosts")).toBe("mailto:x@example.org");
    expect(safeMailto("mailto:x@example.org?%61ttach=/etc/hosts")).toBe("mailto:x@example.org");
    expect(safeMailto("mailto:x@example.org?%41TTACH=/etc/hosts&%62cc=a@b.example")).toBe(
      "mailto:x@example.org",
    );
    expect(safeMailto("mailto:x@example.org?%73ubject=hi&%42ODY=text")).toBe(
      "mailto:x@example.org?subject=hi&body=text",
    );
    // A name that only starts like a safe one.
    expect(safeMailto("mailto:x@example.org?subjectx=hi&xbody=hi&subject%00=hi")).toBe(
      "mailto:x@example.org",
    );
  });

  it("keeps several addresses, and the first of a repeated field", () => {
    expect(safeMailto("mailto:a@example.org,b@example.org?subject=one&subject=two")).toBe(
      "mailto:a@example.org,b@example.org?subject=one",
    );
    expect(safeMailto("mailto:a@example.org%2Cb@example.org")).toBe("mailto:");
  });

  it("does not let an encoded address smuggle a field or a header", () => {
    expect(safeMailto("mailto:a@example.org%3Fbcc=spy@example.net")).toBe("mailto:");
    expect(safeMailto("mailto:a@example.org%0d%0aBcc:%20spy@example.net")).toBe("mailto:");
    expect(safeMailto("mailto:a@example.org%20b@example.net")).toBe("mailto:");
  });

  it("removes line breaks from a subject, and keeps them in a body", () => {
    expect(safeMailto("mailto:x@example.org?subject=a%0d%0aBcc:%20spy@example.net")).toBe(
      "mailto:x@example.org?subject=a%20Bcc%3A%20spy@example.net",
    );
    expect(safeMailto("mailto:x@example.org?body=line1%0D%0Aline2")).toBe(
      "mailto:x@example.org?body=line1%0D%0Aline2",
    );
  });

  it("takes the field list from the query only, and drops the fragment", () => {
    expect(safeMailto("mailto:x@example.org?subject=hi#attach=/etc/hosts")).toBe(
      "mailto:x@example.org?subject=hi",
    );
    expect(safeMailto("mailto:?to=y@example.org&cc=z@example.net&subject=s")).toBe(
      "mailto:?subject=s",
    );
  });

  it("survives malformed input", () => {
    for (const bad of [
      "mailto:",
      "mailto:?",
      "mailto:??&&==",
      "mailto:%",
      "mailto:%zz@example.org",
      "mailto:x@example.org?subject=%E0%A4%A",
      "mailto:x@example.org?body",
      "mailto:x@example.org?=subject",
      "mailto:x@example.org?subject=%",
      `mailto:${"a".repeat(100_000)}@example.org?subject=${"%41".repeat(50_000)}`,
    ]) {
      expect(() => safeMailto(bad)).not.toThrow();
      expect(safeMailto(bad)).toMatch(/^mailto:/);
    }
    expect(safeMailto("mailto:x@example.org?subject=%E0%A4%A")).toBe("mailto:x@example.org");
    expect(safeMailto("mailto:%zz@example.org")).toBe("mailto:");
  });

  it("never leaves an attach or a bcc field in what it returns", () => {
    const hostile = [
      "mailto:x@example.org?attach=a&subject=%26attach%3Db",
      "mailto:x@example.org?subject=hi&&attach=a",
      "mailto:x@example.org?subject=hi%26attach%3D/etc/hosts",
      "mailto:x@example.org?body=%0Aattach%3D/etc/hosts",
    ];
    for (const href of hostile) {
      const out = safeMailto(href);
      const fields = (out.split("?")[1] ?? "").split("&").map((f) => f.split("=")[0]);
      expect(fields.every((f) => f === "subject" || f === "body" || f === "")).toBe(true);
    }
  });
});

describe("linkForSystem", () => {
  it("passes web addresses unchanged and rebuilds mail addresses", () => {
    expect(linkForSystem("https://example.org/a?attach=1")).toBe("https://example.org/a?attach=1");
    expect(linkForSystem("HTTP://example.org")).toBe("HTTP://example.org");
    expect(linkForSystem("mailto:x@example.org?attach=1&subject=s")).toBe(
      "mailto:x@example.org?subject=s",
    );
  });

  it("lets nothing else out", () => {
    for (const href of ["file:///etc/hosts", "javascript:alert(1)", "smb://h/s", "tel:1", ""]) {
      expect(linkForSystem(href)).toBeNull();
    }
  });
});
