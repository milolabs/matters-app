import { describe, expect, it } from "vitest";
import type { ThingFeedback } from "../src/index.ts";
import {
  caseKeyOf,
  companiesWrittenTo,
  companyOf,
  isDeclinedProposal,
  isSharedMailAddress,
  outcomeOf,
  sameParty,
  sharesTopic,
} from "../src/index.ts";

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

  it("knows a shared free-mail address", () => {
    expect(isSharedMailAddress("x@gmail.com")).toBe(true);
    expect(isSharedMailAddress("x@o2.pl")).toBe(true);
    expect(isSharedMailAddress("x@northwind.example")).toBe(false);
    expect(isSharedMailAddress("nobody")).toBe(false);
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

describe("sameParty", () => {
  it("is one company at a business domain and one address at a shared one", () => {
    expect(sameParty("a@northwind.example", "b@mail.northwind.example")).toBe(true);
    expect(sameParty("a@northwind.example", "b@elsewhere.example")).toBe(false);
    expect(sameParty("a@gmail.com", "b@gmail.com")).toBe(false);
    expect(sameParty("A@gmail.com", "a@gmail.com")).toBe(true);
    expect(sameParty("", "")).toBe(false);
  });
});

describe("sharesTopic (ADR 0066, rule 3)", () => {
  it("is true when two words are shared, as in the matter's name and a subject of the person's mail", () => {
    expect(
      sharesTopic("Rozliczenie IP Box 2026", [], ["Re: interpretacja indywidualna ip box"]),
    ).toBe(true);
  });

  it("is true for one long word, and folds Polish letters", () => {
    expect(sharesTopic("Przeprowadzka biura", [], ["Re: Przeprowadzka"])).toBe(true);
    expect(sharesTopic("Księgowość", [], ["ksiegowosc za maj"])).toBe(true);
  });

  it("is true for two distinct words that are not next to each other", () => {
    expect(sharesTopic("Umowa najmu lokalu Mokotów", [], ["lokalu: najmu, pytanie"])).toBe(true);
  });

  it("is false for one short word, for years alone, and for stopwords alone", () => {
    expect(sharesTopic("Rozliczenie IP Box 2026", [], ["Pytanie o IP"])).toBe(false);
    expect(sharesTopic("Oferta 2026", [], ["Podatek 2026"])).toBe(false);
    expect(sharesTopic("To i na do", [], ["to i na do"])).toBe(false);
    expect(sharesTopic("Oferta", [], ["Re: the and for"])).toBe(false);
  });

  it("uses the anchors too, and needs a case name or anchors and subjects", () => {
    expect(sharesTopic(undefined, ["FV/17/2026"], ["Re: FV/17/2026 do zapłaty"])).toBe(true);
    expect(sharesTopic(undefined, undefined, ["anything at all"])).toBe(false);
    expect(sharesTopic("Rozliczenie IP Box", [], [])).toBe(false);
    expect(sharesTopic("", [], ["Rozliczenie IP Box"])).toBe(false);
  });

  it("does not take two subjects together for one", () => {
    // "ip" is in one subject and "box" in the other: neither subject shares two words.
    expect(sharesTopic("Rozliczenie IP Box", [], ["Pytanie o ip", "Paczka box"])).toBe(false);
  });
});

describe("isDeclinedProposal (ADR 0066, rule 7)", () => {
  const decline: ThingFeedback = {
    threadId: "t1",
    lastMessageKey: 5,
    senderAddress: "sales@northwind.example",
    kind: "closed",
    atMs: Date.UTC(2026, 2, 10),
    outcome: "declined",
    caseKey: caseKeyOf("Oferta księgowości"),
    amountValue: 1090,
  };
  const offer = {
    senderAddress: "other@mail.northwind.example",
    caseName: "OFERTA KSIĘGOWOŚCI",
    amount: { value: 1090 },
    dateMs: Date.UTC(2026, 8, 1),
  };

  it("hides the same offer from the same company in the same year, whoever wrote it", () => {
    expect(isDeclinedProposal([decline], offer)).toBe(true);
  });

  it("opens again in a new year", () => {
    expect(isDeclinedProposal([decline], { ...offer, dateMs: Date.UTC(2027, 0, 5) })).toBe(false);
  });

  it("opens again when the matter has another name or the amount changed", () => {
    expect(isDeclinedProposal([decline], { ...offer, caseName: "Oferta ubezpieczenia" })).toBe(
      false,
    );
    expect(isDeclinedProposal([decline], { ...offer, amount: { value: 1290 } })).toBe(false);
  });

  it("holds when either amount is missing", () => {
    const { amount: _, ...noAmount } = offer;
    expect(isDeclinedProposal([decline], noAmount)).toBe(true);
    const { amountValue: __, ...declinedNoAmount } = decline;
    expect(isDeclinedProposal([declinedNoAmount], offer)).toBe(true);
  });

  it("holds for another company only if it is the same one", () => {
    expect(isDeclinedProposal([decline], { ...offer, senderAddress: "x@elsewhere.example" })).toBe(
      false,
    );
  });

  it("is not made by any closing but a decline, and needs a name for the matter", () => {
    for (const outcome of ["done", "taken", "notRelevant", undefined] as const) {
      const other: ThingFeedback =
        outcome === undefined
          ? (({ outcome: _o, ...rest }) => rest)(decline)
          : { ...decline, outcome };
      expect(isDeclinedProposal([other], offer), String(outcome)).toBe(false);
    }
    expect(isDeclinedProposal([{ ...decline, kind: "later" }], offer)).toBe(false);
    expect(isDeclinedProposal([decline], { ...offer, caseName: "" })).toBe(false);
    expect(isDeclinedProposal([{ ...decline, caseKey: "" }], { ...offer, caseName: "" })).toBe(
      false,
    );
  });

  it("at a shared mail domain matches the address only", () => {
    const friend: ThingFeedback = { ...decline, senderAddress: "ola@gmail.com" };
    expect(isDeclinedProposal([friend], { ...offer, senderAddress: "ola@gmail.com" })).toBe(true);
    expect(isDeclinedProposal([friend], { ...offer, senderAddress: "ula@gmail.com" })).toBe(false);
  });
});

describe("outcomeOf (ADR 0066, rule 7)", () => {
  it("makes Not important a not-relevant, Later nothing, and a closing done unless it said more", () => {
    expect(outcomeOf("notImportant", "done")).toBe("notRelevant");
    expect(outcomeOf("later", "declined")).toBeUndefined();
    expect(outcomeOf("closed", undefined)).toBe("done");
    expect(outcomeOf("closed", "taken")).toBe("taken");
    expect(outcomeOf("closed", "declined")).toBe("declined");
    expect(outcomeOf("closed", "notRelevant")).toBe("done");
  });
});
