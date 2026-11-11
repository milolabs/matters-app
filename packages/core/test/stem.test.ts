import { describe, expect, it } from "vitest";
import { parseQuery, stemQuery, stemWord } from "../src/index.ts";

describe("stemWord (ADR 0081)", () => {
  it("cuts the ending of Polish words so that their forms share a stem", () => {
    expect(stemWord("wypowiedzenie")).toBe("wypowiedz");
    for (const form of ["umowa", "umowy", "umowę", "umowie", "umowach"]) {
      expect(stemWord(form)).toBe("umow");
    }
    for (const form of ["oferta", "oferty", "ofertę", "ofertach"]) {
      expect(stemWord(form)).toBe("ofert");
    }
    expect(stemWord("pracować")).toBe("prac");
    expect(stemWord("rekrutacja")).toBe(stemWord("rekrutacji"));
  });

  it("cuts the ending of English words", () => {
    expect(stemWord("contracts")).toBe("contract");
    expect(stemWord("agreement")).toBe("agree");
    expect(stemWord("signed")).toBe("sign");
    expect(stemWord("signing")).toBe("sign");
    expect(stemWord("resignation")).toBe("resign");
    expect(stemWord("offered")).toBe("offer");
    expect(stemWord("offers")).toBe("offer");
  });

  it("keeps a stem of four characters or more, and short words and numbers whole", () => {
    expect(stemWord("job")).toBe("job");
    expect(stemWord("pay")).toBe("pay");
    expect(stemWord("payment")).toBe("payment");
    expect(stemWord("2019")).toBe("2019");
    expect(stemWord("abc123s")).toBe("abc123s");
    for (const w of ["umowa", "agreement", "wypowiedzenie", "documents", "rok", "oferta"]) {
      expect(stemWord(w).length).toBeGreaterThanOrEqual(Math.min(w.length, 4));
    }
  });

  it("does not leave a fragment of a word that is not a stem of it", () => {
    // `documents` must not become `docu`, which would find docusign and documentation alike.
    expect(stemWord("documents")).toBe("document");
  });

  it("folds first: no case, no diacritics", () => {
    expect(stemWord("UMOWĘ")).toBe("umow");
    expect(stemWord("Wypowiedzenie")).toBe("wypowiedz");
    expect(stemWord("Łączność")).toBe(stemWord("lacznosc"));
  });
});

describe("stemQuery (ADR 0081)", () => {
  const words = (query: string) => {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      const node = n as { kind: string; children?: unknown[]; child?: unknown; value?: string };
      if (node.kind === "text") out.push(node.value as string);
      node.children?.forEach(walk);
      if (node.child !== undefined) walk(node.child);
    };
    const root = stemQuery(parseQuery(query, { nowMs: 0 })).root;
    if (root !== null) walk(root);
    return out;
  };

  it("stems plain words, alone and inside OR, brackets and minus", () => {
    expect(words("(umowa OR contracts) -newsletters wypowiedzenie")).toEqual([
      "umow",
      "contract",
      "newslett",
      "wypowiedz",
    ]);
  });

  it("leaves quoted phrases, people and addresses exact", () => {
    expect(words('"umowa o pracę" from:anna@example.test to:umowa')).toEqual([
      "umowa o prace",
      "anna example test",
      "umowa",
    ]);
  });

  it("stems the subject, and nothing else about the query changes", () => {
    const parsed = parseQuery("subject:umowy has:attachment", { nowMs: 0 });
    const stemmed = stemQuery(parsed);
    expect(words("subject:umowy has:attachment")).toEqual(["umow"]);
    expect(stemmed.diagnostics).toEqual(parsed.diagnostics);
    expect(stemmed.tokens).toBe(parsed.tokens);
  });

  it("leaves an empty query alone", () => {
    const parsed = parseQuery("", { nowMs: 0 });
    expect(stemQuery(parsed)).toBe(parsed);
  });
});
