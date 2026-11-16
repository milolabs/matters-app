import { describe, expect, it } from "vitest";
import {
  draftSections,
  isValidAddress,
  MAILTO_MAX_BODY,
  MAILTO_MAX_LENGTH,
  MAILTO_MAX_RECIPIENTS,
  MAILTO_MAX_SUBJECT,
  parseMailto,
  placeSignature,
  plainBodyMarkdown,
  splitDraft,
} from "../src/index.ts";

const empty = { to: [], cc: [], bcc: [], subject: "", body: "" };

describe("parseMailto: RFC 6068, section 6.1 and 6.2", () => {
  it("reads a single address", () => {
    expect(parseMailto("mailto:chris@example.com")).toEqual({
      ...empty,
      to: ["chris@example.com"],
    });
  });

  it("reads a subject, with %20 as a space", () => {
    expect(parseMailto("mailto:infobot@example.com?subject=current-issue")).toMatchObject({
      to: ["infobot@example.com"],
      subject: "current-issue",
    });
    expect(parseMailto("mailto:list@example.org?subject=Weekly%20meeting")?.subject).toBe(
      "Weekly meeting",
    );
  });

  it("reads a body, with %0D%0A as a line break", () => {
    expect(
      parseMailto("mailto:majordomo@example.com?body=subscribe%20bamboo-l%0D%0Aend")?.body,
    ).toBe("subscribe bamboo-l\nend");
  });

  it("reads several addresses in the path and in to", () => {
    expect(parseMailto("mailto:joe@example.com?cc=bob@example.com&body=hello")).toEqual({
      ...empty,
      to: ["joe@example.com"],
      cc: ["bob@example.com"],
      body: "hello",
    });
    expect(parseMailto("mailto:?to=addr1@an.example,addr2@an.example")?.to).toEqual([
      "addr1@an.example",
      "addr2@an.example",
    ]);
    expect(parseMailto("mailto:addr1@an.example?to=addr2@an.example")?.to).toEqual([
      "addr1@an.example",
      "addr2@an.example",
    ]);
    expect(parseMailto("mailto:addr1@an.example,addr2@an.example")?.to).toEqual([
      "addr1@an.example",
      "addr2@an.example",
    ]);
  });

  it("reads an encoded comma between addresses as a comma", () => {
    expect(parseMailto("mailto:a@example.com%2Cb@example.com")?.to).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(parseMailto("mailto:?cc=a%40example.com%2c%20b%40example.com")?.cc).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("decodes once: an encoded percent stays a percent", () => {
    // `%252C` is `%2C` after one decoding, which is not a comma, and no address holds it.
    expect(parseMailto("mailto:a@example.com%252Cb@example.com")?.to).toEqual([]);
    expect(parseMailto("mailto:x@example.com?subject=100%2525")?.subject).toBe("100%25");
  });

  it("keeps an encoded & and = in a value as text", () => {
    expect(parseMailto("mailto:x@example.com?subject=a%26cc%3Dspy%40example.net")).toEqual({
      ...empty,
      to: ["x@example.com"],
      subject: "a&cc=spy@example.net",
    });
  });

  it("does not read + as a space", () => {
    expect(parseMailto("mailto:x@example.com?subject=1+1")?.subject).toBe("1+1");
  });

  it("reads field names and the scheme without regard to case", () => {
    expect(
      parseMailto("MAILTO:x@example.com?SUBJECT=Hi&Cc=y@example.com&%62cc=z@example.com"),
    ).toEqual({
      ...empty,
      to: ["x@example.com"],
      cc: ["y@example.com"],
      bcc: ["z@example.com"],
      subject: "Hi",
    });
  });

  it("is an empty message for a bare mailto:", () => {
    expect(parseMailto("mailto:")).toEqual(empty);
  });

  it("is null for anything that is not a mailto: link", () => {
    for (const href of ["", "https://example.com", "mail:x@example.com", "javascript:alert(1)"]) {
      expect(parseMailto(href)).toBeNull();
    }
  });
});

describe("parseMailto: what is dropped", () => {
  it("drops attach, attachment and every header field other than the five", () => {
    const draft = parseMailto(
      "mailto:x@example.org?attach=/etc/hosts&attachment=file:///etc/passwd&%61ttach=~/.ssh/id_rsa" +
        "&from=boss@example.com&reply-to=spy@example.net&in-reply-to=%3Cid%40x%3E&keywords=k" +
        "&x-mailer=evil&subject=hi&body=text",
    );
    expect(draft).toEqual({ ...empty, to: ["x@example.org"], subject: "hi", body: "text" });
  });

  it("drops a fragment", () => {
    expect(parseMailto("mailto:x@example.org?subject=a#bcc=spy@example.net")).toEqual({
      ...empty,
      to: ["x@example.org"],
      subject: "a",
    });
  });

  it("lets the first subject and the first body win", () => {
    expect(parseMailto("mailto:?subject=first&body=one&subject=second&body=two")).toMatchObject({
      subject: "first",
      body: "one",
    });
  });

  it("adds the addresses of a repeated to, cc or bcc, once each", () => {
    expect(
      parseMailto(
        "mailto:a@example.com?cc=b@example.com&to=c@example.com&cc=d@example.com&bcc=A@example.com&cc=b@example.com",
      ),
    ).toEqual({
      ...empty,
      to: ["a@example.com", "c@example.com"],
      cc: ["b@example.com", "d@example.com"],
      bcc: [],
    });
  });

  it("makes an address in two fields a To, whatever the order in the link", () => {
    expect(parseMailto("mailto:?bcc=x@example.com&to=x@example.com")).toMatchObject({
      to: ["x@example.com"],
      bcc: [],
    });
  });

  it("drops malformed addresses instead of guessing", () => {
    const draft = parseMailto(
      "mailto:not-an-address,Anna%20%3Canna@example.com%3E,%22q%22@example.com,a@b,@example.com," +
        "a@@example.com,a%20b@example.com,a@example.com%0d%0aBcc:spy@example.net,%E0%A4%A,ok@example.com",
    );
    expect(draft?.to).toEqual(["ok@example.com"]);
  });

  it("drops an address with an invisible character in it", () => {
    expect(parseMailto("mailto:bank%E2%80%8B@example.com,a@exa%E2%80%AEmple.com")?.to).toEqual([]);
  });

  it("drops a field whose value is not valid percent-encoding, and keeps the rest", () => {
    expect(parseMailto("mailto:x@example.com?subject=%E0%A4%A&body=ok")).toEqual({
      ...empty,
      to: ["x@example.com"],
      body: "ok",
    });
  });
});

describe("parseMailto: header injection", () => {
  it("cannot add a header through the subject", () => {
    const draft = parseMailto(
      "mailto:?to=y@example.org&cc=z@example.net&subject=a%0d%0aBcc:%20spy@example.net",
    );
    expect(draft).toEqual({
      ...empty,
      to: ["y@example.org"],
      cc: ["z@example.net"],
      subject: "a Bcc: spy@example.net",
    });
  });

  it("strips every control character and line separator from the subject", () => {
    expect(parseMailto("mailto:?subject=%00a%07b%1Bc%7Fd%E2%80%A8e%0Df%0Ag%09h")?.subject).toBe(
      "abcd e f g h",
    );
  });

  it("cannot add a header through an address", () => {
    for (const href of [
      "mailto:x@example.com%0D%0ABcc:%20spy@example.net",
      "mailto:?to=x@example.com%0ABcc:spy@example.net",
      "mailto:?cc=x@example.com%0d%0a%0d%0abody",
    ]) {
      const draft = parseMailto(href);
      expect([...(draft?.to ?? []), ...(draft?.cc ?? []), ...(draft?.bcc ?? [])]).toEqual([]);
    }
  });
});

describe("parseMailto: limits", () => {
  it("refuses a link longer than the limit", () => {
    const at = "mailto:x@example.com?body=";
    expect(parseMailto(at + "a".repeat(MAILTO_MAX_LENGTH - at.length))).not.toBeNull();
    expect(parseMailto(at + "a".repeat(MAILTO_MAX_LENGTH - at.length + 1))).toBeNull();
  });

  it("keeps at most the limit of recipients", () => {
    const many = Array.from({ length: 80 }, (_, i) => `p${i}@example.com`);
    const draft = parseMailto(
      `mailto:${many.slice(0, 40).join(",")}?cc=${many.slice(40).join(",")}`,
    );
    expect((draft?.to.length ?? 0) + (draft?.cc.length ?? 0)).toBe(MAILTO_MAX_RECIPIENTS);
    expect(draft?.to).toHaveLength(40);
  });

  it("cuts a long subject and a long body, never inside a pair of surrogates", () => {
    const subject = parseMailto(
      `mailto:?subject=${"a".repeat(MAILTO_MAX_SUBJECT - 1)}%F0%9F%98%80`,
    );
    expect(subject?.subject).toHaveLength(MAILTO_MAX_SUBJECT - 1);
    const body = parseMailto(`mailto:?body=${"b".repeat(MAILTO_MAX_BODY + 10)}`);
    expect(body?.body).toHaveLength(MAILTO_MAX_BODY);
  });

  it("gives only addresses the composer takes", () => {
    const draft = parseMailto("mailto:a.b+tag@sub.example.co.uk,ż@przykład.pl");
    expect(draft?.to).toEqual(["a.b+tag@sub.example.co.uk", "ż@przykład.pl"]);
    for (const address of draft?.to ?? []) expect(isValidAddress(address)).toBe(true);
  });
});

describe("plainBodyMarkdown: the body stays the text the link carried", () => {
  it("leaves ordinary text alone", () => {
    expect(plainBodyMarkdown("Hi, I'd like to *subscribe* (please) — thanks!\n\nAnna")).toBe(
      "Hi, I'd like to *subscribe* (please) — thanks!\n\nAnna",
    );
  });

  it("escapes what would make a link or an image", () => {
    expect(plainBodyMarkdown("![](https://tracker.example/p.gif)")).toBe(
      "!\\[\\](https://tracker.example/p.gif)",
    );
    expect(plainBodyMarkdown("[your bank](https://phish.example)")).toBe(
      "\\[your bank\\](https://phish.example)",
    );
    expect(plainBodyMarkdown("[x]: https://phish.example")).toBe("\\[x\\]: https://phish.example");
  });

  it("doubles a backslash that would cancel an escape", () => {
    expect(plainBodyMarkdown("\\[x](https://phish.example)")).toBe(
      "\\\\\\[x\\](https://phish.example)",
    );
    // One that escapes nothing stays as it is.
    expect(plainBodyMarkdown("C:\\Users\\anna")).toBe("C:\\Users\\anna");
  });

  it("keeps a line from reading as quoted mail or as a signature", () => {
    const body = plainBodyMarkdown("Hello\n> quoted\n   >> deeper\n-- \nNot me\n--");
    expect(body).toBe("Hello\n\\> quoted\n   \\>> deeper\n\\-- \nNot me\n\\--");
    const sections = draftSections(body);
    expect(sections.signature).toBe("");
    expect(sections.quote).toBe("");
    expect(splitDraft(body).quote).toBe("");
  });

  it("lets the account's signature go under it, once", () => {
    const body = parseMailto("mailto:?body=Hi%0A--%20%0AEvil%20Corp%0A%3E%20quote")?.body ?? "";
    expect(placeSignature(body, "Anna")).toBe("Hi\n\\-- \nEvil Corp\n\\> quote\n\n-- \nAnna");
  });

  it("drops control characters other than the line feed and the tab", () => {
    expect(plainBodyMarkdown("a\r\nb\rc\u0000d\u001be\tf\u2028g")).toBe("a\nb\ncd" + "e\tf\ng");
  });
});
