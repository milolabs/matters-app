import { describe, expect, it } from "vitest";
import { REPEATS_LEFT_OUT, tokenize, withoutRepeats } from "../src/index.ts";

const FIRST =
  "Hello Kim,\nthe harbour budget needs the signed scaffolding invoice\nbefore the end of June, please confirm the amount.\nBest, Anna";

describe("withoutRepeats (ADR 0084)", () => {
  it("leaves the first message alone, and a thread of one", () => {
    expect(withoutRepeats([FIRST])).toEqual([FIRST]);
    expect(withoutRepeats([])).toEqual([]);
  });

  it("drops a quote with > marks and re-wrapped lines, and keeps the reply's own words", () => {
    const quoted =
      "> Hello Kim, the harbour budget needs the signed\n> scaffolding invoice before the end of June,\n> please confirm the amount.";
    const reply = `Confirmed, the amount is 4200 euro.\n\nOn Monday Anna wrote:\n${quoted}\n>\n`;
    const [a, b] = withoutRepeats([FIRST, reply]);
    expect(a).toBe(FIRST);
    expect(b).toContain("Confirmed, the amount is 4200 euro.");
    expect(b).not.toContain("scaffolding");
    expect(b).not.toContain("please confirm");
    expect(b).not.toMatch(/^>\s*$/m);
    expect(b).toContain(REPEATS_LEFT_OUT);
    expect(b?.split(REPEATS_LEFT_OUT)).toHaveLength(2);
  });

  it("drops a repeated paragraph that has no marks", () => {
    const reply = `Thanks!\n\nthe harbour budget needs the signed scaffolding invoice\nbefore the end of June, please confirm the amount.\n\nSee you.`;
    const [, b] = withoutRepeats([FIRST, reply]);
    expect(b).toContain("Thanks!");
    expect(b).toContain("See you.");
    expect(b).not.toContain("scaffolding");
  });

  it("keeps a message that repeats only a short phrase", () => {
    const reply = "Please confirm the amount.\nthe harbour budget is fine\nShort: end of June";
    expect(withoutRepeats([FIRST, reply])[1]).toBe(reply);
  });

  it("keeps a line that is mostly new even when it starts with old words", () => {
    const line =
      "the harbour budget needs the signed scaffolding invoice and also a new permit from the city";
    expect(withoutRepeats([FIRST, line])[1]).toBe(line);
  });

  it("shrinks a thread of replies that each quote all before to a size that grows slowly", () => {
    const texts: string[] = [];
    let quoted = "";
    for (let i = 0; i < 20; i++) {
      const own = `Own words of reply ${i}: item${i} moves to week ${i + 3} for site${i} crew${i}.`;
      const text = i === 0 ? own : `${own}\n\n${quoted}`;
      texts.push(text);
      quoted = text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    }
    const out = withoutRepeats(texts);
    const before = texts.reduce((n, t) => n + t.length, 0);
    const after = out.reduce((n, t) => n + t.length, 0);
    expect(after).toBeLessThan(before / 5);
    expect(after).toBeLessThan(20 * 170);
    for (const [i, t] of out.entries()) expect(t).toContain(`Own words of reply ${i}`);
  });

  it("loses no word that did not appear earlier", () => {
    const texts = [
      FIRST,
      `New point one two three.\n> ${FIRST.replace(/\n/g, "\n> ")}\n\n\n\n\nLast bit: seven eight nine.`,
    ];
    const out = withoutRepeats(texts);
    const earlier = new Set(tokenize(texts[0] as string));
    for (const w of tokenize(texts[1] as string)) {
      if (!earlier.has(w)) expect(tokenize(out[1] as string)).toContain(w);
    }
    expect(out[1]).not.toMatch(/\n\n\n/);
  });
});
