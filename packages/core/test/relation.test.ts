import { describe, expect, it } from "vitest";
import { companiesWrittenTo, companyOf } from "../src/index.ts";

describe("companyOf (ADR 0066, rule 3)", () => {
  it("cuts a domain to the registrable-enough part", () => {
    expect(companyOf("anna@northwind.example")).toBe("northwind.example");
    expect(companyOf("Anna@Mail.Northwind.Example")).toBe("northwind.example");
    expect(companyOf("anna@shop.northwind.com.pl")).toBe("northwind.com.pl");
    expect(companyOf("anna@northwind.co.uk")).toBe("northwind.co.uk");
  });

  it("is empty for a shared mail domain, an address without a domain, and a bare host", () => {
    for (const address of [
      "someone@gmail.com",
      "x@mail.gmail.com",
      "x@wp.pl",
      "x@icloud.com",
      "no-at-sign",
      "x@localhost",
      "x@",
    ]) {
      expect(companyOf(address), address).toBe("");
    }
  });
});

describe("companiesWrittenTo", () => {
  it("sums the addresses of a company, takes the newest time, and skips shared domains", () => {
    const got = companiesWrittenTo(
      new Map([
        ["anna@northwind.example", { sent: 2, lastMs: 100 }],
        ["tax@mail.northwind.example", { sent: 3, lastMs: 300 }],
        ["friend@gmail.com", { sent: 9, lastMs: 900 }],
        ["bob@elsewhere.example", { sent: 1, lastMs: 50 }],
      ]),
    );
    expect([...got]).toEqual([
      ["northwind.example", { sent: 5, lastMs: 300 }],
      ["elsewhere.example", { sent: 1, lastMs: 50 }],
    ]);
  });
});
