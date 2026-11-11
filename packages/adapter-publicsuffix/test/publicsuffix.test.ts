import { describe, expect, it } from "vitest";
import { registrableDomain } from "../src/index.ts";

describe("registrableDomain (ADR 0037)", () => {
  it("is the public suffix plus one label, for the host and its subdomains", () => {
    expect(registrableDomain("shop.example")).toBe("shop.example");
    expect(registrableDomain("mail.shop.example")).toBe("shop.example");
    expect(registrableDomain("a.b.c.shop.com")).toBe("shop.com");
    expect(registrableDomain("MAIL.Shop.Example")).toBe("shop.example");
  });

  it("knows multi-label suffixes", () => {
    expect(registrableDomain("shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("mail.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("sklep.com.pl")).toBe("sklep.com.pl");
  });

  it("has none for a public suffix alone, so no rule can name it", () => {
    expect(registrableDomain("co.uk")).toBeUndefined();
    expect(registrableDomain("com")).toBeUndefined();
    expect(registrableDomain("com.pl")).toBeUndefined();
  });

  it("has none for an IP address, an empty host or something that is not a host", () => {
    expect(registrableDomain("127.0.0.1")).toBeUndefined();
    expect(registrableDomain("[::1]")).toBeUndefined();
    expect(registrableDomain("")).toBeUndefined();
    expect(registrableDomain("localhost")).toBeUndefined();
  });

  it("does not treat hosting platforms' private suffixes as public suffixes", () => {
    expect(registrableDomain("someone.github.io")).toBe("github.io");
  });
});
