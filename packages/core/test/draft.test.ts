import { describe, expect, it } from "vitest";
import {
  canonicalDraft,
  DraftEncodingError,
  fingerprintOf,
  formatRecipients,
  gaps,
  parseRecipients,
  reviseDraft,
  SendBlockedError,
  sendBlockers,
} from "../src/index.ts";
import { anna, content, draft, me, sha256 } from "./support.ts";

describe("fingerprint", () => {
  it("is SHA-256 over a canonical encoding and is stable", () => {
    const a = fingerprintOf(content(), sha256);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(content(), sha256)).toBe(a);
  });

  it("covers every field an approval protects", () => {
    const base = fingerprintOf(content(), sha256);
    const changed = [
      content({ to: [anna, { address: "b@x.pl" }] }),
      content({ cc: [anna] }),
      content({ bcc: [me] }),
      content({ subject: "Inny" }),
      content({ bodyMarkdown: "Cena: 36 000 PLN" }),
      content({ from: { address: "other@example.com" } }),
      content({ inReplyTo: "<zzz@x>" }),
      content({ references: [] }),
      content({ accountId: "acc2" }),
    ];
    for (const c of changed) expect(fingerprintOf(c, sha256)).not.toBe(base);
  });

  it("ignores case and padding of addresses, nothing else", () => {
    const base = fingerprintOf(content(), sha256);
    const padded = content({
      to: [{ name: "Anna Kowalska", address: " ANNA@northwind.example " }],
    });
    expect(fingerprintOf(padded, sha256)).toBe(base);
  });

  it("throws instead of hashing a draft it cannot encode", () => {
    const broken = [
      { ...content(), subject: undefined },
      { ...content(), to: "anna@x.pl" },
      { ...content(), bodyMarkdown: "a\uD800b" },
      { ...content(), references: [1] },
      null,
    ] as unknown as Parameters<typeof canonicalDraft>[0][];
    for (const b of broken) expect(() => canonicalDraft(b)).toThrow(DraftEncodingError);
  });

  it("keeps Polish text apart from look-alikes", () => {
    const a = fingerprintOf(content({ bodyMarkdown: "zażółć gęślą jaźń" }), sha256);
    expect(fingerprintOf(content({ bodyMarkdown: "zazolc gesla jazn" }), sha256)).not.toBe(a);
  });
});

describe("reviseDraft", () => {
  it("keeps version and identity when nothing changed", () => {
    const d = draft();
    expect(reviseDraft(d, content(), sha256, 2_000)).toBe(d);
  });

  it("bumps the version only on a real change", () => {
    const d = draft();
    const next = reviseDraft(d, content({ bodyMarkdown: "Cena: 36 000 PLN" }), sha256, 2_000);
    expect(next).toMatchObject({ id: "d1", version: 2, updatedAtMs: 2_000 });
    expect(next.fingerprint).not.toBe(d.fingerprint);
    const again = reviseDraft(next, content({ bodyMarkdown: "Cena: 36 000 PLN" }), sha256, 3_000);
    expect(again).toBe(next);
  });

  it("changes the version for a recipient change, a bcc included", () => {
    expect(reviseDraft(draft(), content({ bcc: [me] }), sha256, 2).version).toBe(2);
  });
});

describe("gaps and blockers", () => {
  it("finds [placeholders] in subject and body", () => {
    expect(gaps(content())).toEqual([{ where: "body", token: "[cena]" }]);
    expect(gaps(content({ subject: "Re: [temat]", bodyMarkdown: "[a] i [b c]" }))).toEqual([
      { where: "subject", token: "[temat]" },
      { where: "body", token: "[a]" },
      { where: "body", token: "[b c]" },
    ]);
  });

  it("does not mistake Markdown links, references, images or task boxes for gaps", () => {
    const md =
      "[link](http://x.pl) ![img](a.png) [ref][1]\n\n[1]: http://x.pl\n\n- [ ] todo\n- [x] done";
    expect(gaps(content({ bodyMarkdown: md }))).toEqual([]);
  });

  it("leaves the quoted message alone: its brackets are not gaps", () => {
    const body =
      "Dzięki!\n\nOn 9 Nov 2026, 14:05, Shop wrote:\n> Logo [https://shop.pl/c?x=1]\n>  > [cena]";
    expect(gaps(content({ bodyMarkdown: body }))).toEqual([]);
  });

  it("does not take a bracketed link for a gap, even in the writer's own words", () => {
    const body = "See [https://x.pl/a] or [www.x.pl] or [mailto:a@x.pl], price [cena]";
    expect(gaps(content({ bodyMarkdown: body }))).toEqual([{ where: "body", token: "[cena]" }]);
  });

  it("blocks send while recipients are empty or gaps remain", () => {
    expect(sendBlockers(content({ bodyMarkdown: "ok" }))).toEqual([]);
    expect(sendBlockers(content({ to: [], bodyMarkdown: "ok" }))).toEqual([
      { kind: "noRecipients" },
    ]);
    expect(sendBlockers(content())).toEqual([
      { kind: "gaps", gaps: [{ where: "body", token: "[cena]" }] },
    ]);
    expect(sendBlockers(content({ to: [{ address: "nope" }], bodyMarkdown: "ok" }))).toEqual([
      { kind: "invalidAddress", address: "nope" },
    ]);
  });

  it("explains itself", () => {
    expect(new SendBlockedError(sendBlockers(content())).message).toBe("Fill in [cena] first.");
  });

  it("counts a bcc-only message as having a recipient", () => {
    expect(sendBlockers(content({ to: [], bcc: [anna], bodyMarkdown: "ok" }))).toEqual([]);
  });
});

describe("recipients", () => {
  it("parses addresses with and without names, quotes and separators", () => {
    const r = parseRecipients(
      'Anna <anna@x.pl>, "Kowalski, Jan" <jan@x.pl>; b@x.pl\nnot-an-address',
    );
    expect(r.participants).toEqual([
      { name: "Anna", address: "anna@x.pl" },
      { name: "Kowalski, Jan", address: "jan@x.pl" },
      { address: "b@x.pl" },
    ]);
    expect(r.invalid).toEqual(["not-an-address"]);
  });

  it("formats what it parses", () => {
    const list = [{ name: "Kowalski, Jan", address: "jan@x.pl" }, { address: "b@x.pl" }];
    expect(parseRecipients(formatRecipients(list)).participants).toEqual(list);
  });
});
