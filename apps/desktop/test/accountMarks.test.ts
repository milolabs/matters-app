import { readFileSync } from "node:fs";
import { parseQuery } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_COLORS,
  type AccountColor,
  accountMarks,
  contrastRatio,
  isAccountColor,
  resolveColors,
  showsAccountMarks,
} from "../src/renderer/accountMarks.ts";

const acc = (id: string, address: string) => ({ id, address });
const root = (text: string, ids: string[] = ["a", "b"]) =>
  parseQuery(text, {
    accounts: ids.map((id) => ({ id, address: `${id}@x.com`, displayName: id })),
  }).root;
const ids = ACCOUNT_COLORS.map((c) => c.id);
const many = (n: number) => Array.from({ length: n }, (_, i) => acc(`id${i}`, `u${i}@d${i}.com`));

describe("account colours", () => {
  it("gives the first eight accounts different colours in palette order", () => {
    const list = many(8);
    const m = accountMarks(list, {});
    expect(list.map((a) => m.get(a.id)?.color)).toEqual(ids);
    expect(m.get("id0")?.fill).toBe("#3a5ba0");
    expect(m.get("id0")?.dot).toBe("var(--acct-blue)");
  });

  it("skips colours that are chosen, by later accounts too", () => {
    const m = accountMarks(many(3), { id2: "blue", id1: "ochre" });
    expect(m.get("id0")?.color).toBe("green");
    expect(m.get("id1")?.color).toBe("ochre");
    expect(m.get("id2")?.color).toBe("blue");
  });

  it("respects a chosen colour even when another account has it", () => {
    const m = accountMarks(many(2), { id0: "plum", id1: "plum" });
    expect(m.get("id0")?.color).toBe("plum");
    expect(m.get("id1")?.color).toBe("plum");
  });

  it("ignores an unknown chosen id", () => {
    const m = accountMarks(many(1), { id0: "mauve" as AccountColor });
    expect(m.get("id0")?.color).toBe("blue");
  });

  it("wraps by index beyond eight", () => {
    const list = many(10);
    const m = accountMarks(list, {});
    expect(m.get("id8")?.color).toBe(ids[8 % 8]);
    expect(m.get("id9")?.color).toBe(ids[9 % 8]);
  });

  it("keeps colours when an earlier account disappears and the result is fed back", () => {
    const list = many(3);
    const first = resolveColors(list, {});
    expect(first).toEqual({ id0: "blue", id1: "ochre", id2: "green" });
    const after = resolveColors(list.slice(1), first);
    expect(after).toEqual({ id1: "ochre", id2: "green" });
    // A newcomer takes the freed colour only when it is the first free one.
    expect(resolveColors([...list.slice(1), acc("n", "n@n.com")], after).n).toBe("blue");
  });
});

describe("chosen hex colours", () => {
  it("keeps a chosen hex and reserves no palette colour", () => {
    const m = accountMarks(many(2), { id1: "#123456" });
    expect(m.get("id1")?.color).toBe("#123456");
    expect(m.get("id0")?.color).toBe("blue");
  });

  it("uses the hex for fill and dot", () => {
    const mark = accountMarks(many(1), { id0: "#123456" }).get("id0");
    expect(mark?.fill).toBe("#123456");
    expect(mark?.dot).toBe("#123456");
  });

  it("lower-cases an uppercase hex", () => {
    expect(resolveColors(many(1), { id0: "#AABBCC" }).id0).toBe("#aabbcc");
  });

  it("picks white ink on a dark hex and dark ink on a light one", () => {
    const m = accountMarks(many(2), { id0: "#102030", id1: "#ffee88" });
    expect(m.get("id0")?.ink).toBe("#ffffff");
    expect(m.get("id1")?.ink).toBe("#1d1d1f");
  });

  it("gives white ink on every palette fill", () => {
    for (const mark of accountMarks(many(8), {}).values()) expect(mark.ink).toBe("#ffffff");
  });

  it("accepts palette ids and hex, rejects the rest", () => {
    expect(isAccountColor("blue")).toBe(true);
    expect(isAccountColor("#AABBCC")).toBe(true);
    expect(isAccountColor("#aabbcc")).toBe(true);
    for (const bad of ["red", "#abc", "#gggggg", "aabbcc", 5, null, undefined])
      expect(isAccountColor(bad), String(bad)).toBe(false);
  });
});

describe("account marks letters", () => {
  it("uses the uppercase first letter of the domain", () => {
    const m = accountMarks([acc("1", "alex@gmail.com"), acc("2", "alex@icloud.com")], {});
    expect(m.get("1")?.letter).toBe("G");
    expect(m.get("2")?.letter).toBe("I");
    expect(m.get("1")?.address).toBe("alex@gmail.com");
  });

  it("falls back to the local part when accounts share a domain letter", () => {
    const m = accountMarks([acc("1", "alex@gmail.com"), acc("2", "biuro@gmail.com")], {});
    expect(m.get("1")?.letter).toBe("A");
    expect(m.get("2")?.letter).toBe("B");
  });

  it("falls back for different domains with the same first letter", () => {
    const m = accountMarks(
      [acc("1", "alex@gmail.com"), acc("2", "biuro@gmx.com"), acc("3", "kim@icloud.com")],
      {},
    );
    expect(m.get("1")?.letter).toBe("A");
    expect(m.get("2")?.letter).toBe("B");
    expect(m.get("3")?.letter).toBe("I");
  });

  it("leaves colliding local parts equal without throwing", () => {
    const m = accountMarks([acc("1", "alex@gmail.com"), acc("2", "alex@gmx.com")], {});
    expect(m.get("1")?.letter).toBe("A");
    expect(m.get("2")?.letter).toBe("A");
    expect(m.get("1")?.color).not.toBe(m.get("2")?.color);
  });

  it("survives malformed addresses", () => {
    const m = accountMarks([acc("1", "nodomain"), acc("2", "x@"), acc("3", ""), acc("4", "@")], {});
    expect(m.get("1")?.letter).toBe("N");
    expect(m.get("2")?.letter).toBe("X");
    expect(m.get("3")?.letter).toBe("?");
    expect(m.get("4")?.letter).toBe("?");
  });
});

describe("palette contrast", () => {
  const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  const light = css.slice(0, darkAt);
  const dark = css.slice(darkAt);
  const value = (block: string, name: string) =>
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1] ?? "";

  it("keeps white letters at 4.5:1 on every fill", () => {
    for (const c of ACCOUNT_COLORS)
      expect(contrastRatio("#ffffff", c.fill), c.id).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the light dot equal to the fill and at 3:1 on the background", () => {
    expect(value(light, "bg")).toBe("#ffffff");
    for (const c of ACCOUNT_COLORS) {
      expect(value(light, `acct-${c.id}`), c.id).toBe(c.fill);
      expect(contrastRatio(value(light, `acct-${c.id}`), "#ffffff"), c.id).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("keeps the dark dot at 3:1 on the dark background", () => {
    expect(value(dark, "bg")).toBe("#1e1e20");
    for (const c of ACCOUNT_COLORS) {
      const dot = value(dark, `acct-${c.id}`);
      expect(dot, c.id).not.toBe("");
      expect(contrastRatio(dot, "#1e1e20"), c.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("showsAccountMarks", () => {
  it("is off for zero or one account", () => {
    expect(showsAccountMarks(0, null)).toBe(false);
    expect(showsAccountMarks(1, null)).toBe(false);
  });

  it("is on for two accounts with no query", () => {
    expect(showsAccountMarks(2, null)).toBe(true);
  });

  it("is off when the query pins one account", () => {
    expect(showsAccountMarks(2, { kind: "account", ids: ["a"] })).toBe(false);
    expect(showsAccountMarks(2, root("account:a"))).toBe(false);
  });

  it("stays on for an account node with several ids", () => {
    expect(showsAccountMarks(3, { kind: "account", ids: ["a", "b"] })).toBe(true);
  });

  it("is off when a single account is nested in and", () => {
    expect(showsAccountMarks(2, root("account:a is:unread"))).toBe(false);
    expect(
      showsAccountMarks(2, {
        kind: "and",
        children: [
          { kind: "attachment" },
          { kind: "and", children: [{ kind: "account", ids: ["a"] }] },
        ],
      }),
    ).toBe(false);
  });

  it("does not count a pin under or or not", () => {
    expect(
      showsAccountMarks(2, {
        kind: "or",
        children: [{ kind: "account", ids: ["a"] }, { kind: "attachment" }],
      }),
    ).toBe(true);
    expect(showsAccountMarks(2, { kind: "not", child: { kind: "account", ids: ["a"] } })).toBe(
      true,
    );
  });
});
