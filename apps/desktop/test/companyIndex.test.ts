import { describe, expect, it } from "vitest";
import { CompanyIndex } from "../src/backend/companyIndex.ts";

describe("CompanyIndex (ADR 0070, rule 1)", () => {
  const filled = (cap = 10) => {
    const index = new CompanyIndex<string>(cap);
    index.add("cara@northwind.example", "newest");
    index.add("tax@mail.northwind.example", "middle");
    index.add("anna@northwind.example", "oldest");
    index.add("eve@notnorthwind.example", "lookalike");
    return index;
  };

  it("files a domain with its subdomains, newest first, and no lookalike", () => {
    expect(filled().get("northwind.example")).toEqual(["newest", "middle", "oldest"]);
    expect(filled().get("mail.northwind.example")).toEqual(["middle"]);
  });

  it("matches one address exactly when it is given one", () => {
    expect(filled().get("anna@northwind.example")).toEqual(["oldest"]);
    expect(filled().get("a_na@northwind.example")).toEqual([]);
  });

  it("asks in any case and with spaces around, and has nothing for an empty target", () => {
    expect(filled().get(" Anna@Northwind.Example ")).toEqual(["oldest"]);
    expect(filled().get("")).toEqual([]);
  });

  it("keeps the newest up to its cap", () => {
    expect(filled(2).get("northwind.example")).toEqual(["newest", "middle"]);
  });

  it("files one item once under a company, whoever else there it also went to", () => {
    const index = new CompanyIndex<string>(10);
    index.add("anna@northwind.example", "both");
    index.add("cara@northwind.example", "both");
    expect(index.get("northwind.example")).toEqual(["both"]);
    expect(index.get("cara@northwind.example")).toEqual(["both"]);
  });

  it("files nothing for what is not an address", () => {
    const index = new CompanyIndex<string>(10);
    index.add("", "a");
    index.add("@northwind.example", "b");
    index.add("anna@", "c");
    index.add("anna", "d");
    expect(index.get("northwind.example")).toEqual([]);
    expect(index.get("anna")).toEqual([]);
  });
});
