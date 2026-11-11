import { describe, expect, it } from "vitest";
import { classifyHtml, htmlToText, PostalMimeParser } from "../src/index.ts";

const parser = new PostalMimeParser();
const crlf = (lines: readonly string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const headers = [
  `From: =?UTF-8?B?${b64("Łukasz Żółkiewski")}?= <lukasz@example.pl>`,
  "To: Miłosz <milosz@example.com>, ewa@example.pl",
  "Cc: Zespół <zespol@example.pl>",
  "Date: Tue, 03 Nov 2026 09:30:00 +0100",
  "MIME-Version: 1.0",
];

describe("PostalMimeParser", () => {
  it("decodes a UTF-8 base64 encoded-word subject with Polish letters", async () => {
    const parsed = await parser.parse(
      crlf([
        ...headers,
        "Message-ID: <utf8@example.pl>",
        `Subject: =?UTF-8?B?${b64("Zażółć gęślą jaźń: faktura nr 12/2026")}?=`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Treść wiadomości.",
      ]),
    );
    expect(parsed.subject).toBe("Zażółć gęślą jaźń: faktura nr 12/2026");
    expect(parsed.from).toEqual({ name: "Łukasz Żółkiewski", address: "lukasz@example.pl" });
    expect(parsed.to).toEqual([
      { name: "Miłosz", address: "milosz@example.com" },
      { address: "ewa@example.pl" },
    ]);
    expect(parsed.cc).toEqual([{ name: "Zespół", address: "zespol@example.pl" }]);
    expect(parsed.dateMs).toBe(Date.UTC(2026, 10, 3, 8, 30));
    expect(parsed.messageId).toBe("<utf8@example.pl>");
    expect(parsed.text).toBe("Treść wiadomości.");
    expect(parsed.attachments).toEqual([]);
  });

  it("decodes an ISO-8859-2 quoted-printable encoded-word subject", async () => {
    const parsed = await parser.parse(
      crlf([
        ...headers,
        "Subject: =?ISO-8859-2?Q?Za=BF=F3=B3=E6_g=EA=B6l=B1_ja=BC=F1?=",
        "Content-Type: text/plain; charset=iso-8859-2",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Za=BF=F3=B3=E6 g=EA=B6l=B1 ja=BC=F1",
      ]),
    );
    expect(parsed.subject).toBe("Zażółć gęślą jaźń");
    expect(parsed.text).toBe("Zażółć gęślą jaźń");
  });

  it("takes the text/plain part of multipart/alternative", async () => {
    const parsed = await parser.parse(
      crlf([
        ...headers,
        "Subject: alternative",
        'Content-Type: multipart/alternative; boundary="alt"',
        "",
        "--alt",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Cze=C5=9B=C4=87,=0D=0A=0D=0Atekst zwyk=C5=82y.",
        "--alt",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Cześć, <b>HTML</b> inny niż tekst.</p>",
        "--alt--",
      ]),
    );
    expect(parsed.text).toBe("Cześć,\n\ntekst zwykły.");
  });

  it("converts HTML to text when there is no text part", async () => {
    const parsed = await parser.parse(
      crlf([
        ...headers,
        "Subject: html only",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><head><title>x</title><style>p { color: red }</style></head><body>",
        "<p>Cześć&nbsp;świecie &amp; wszyscy</p><script>alert(1)</script>",
        "<div>Druga <b>linia</b><br>trzecia &#322;&oacute;d&zacute;</div></body></html>",
      ]),
    );
    expect(parsed.text).toBe("Cześć świecie & wszyscy\n\nDruga linia\ntrzecia łódź");
  });

  it("lists attachment metadata and tells inline images from attachments", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake content for the size check").toString("base64");
    const parsed = await parser.parse(
      crlf([
        ...headers,
        "Subject: attachment",
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        'Content-Type: multipart/related; boundary="rel"',
        "",
        "--rel",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Faktura w załączniku <img src="cid:logo@example.pl"></p>',
        "--rel",
        "Content-Type: image/png",
        "Content-ID: <logo@example.pl>",
        "Content-Disposition: inline",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("png!").toString("base64"),
        "--rel--",
        "--mix",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*=UTF-8''Faktura%20za%C5%BC%C3%B3%C5%82%C4%87.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        pdf,
        "--mix--",
      ]),
    );
    expect(parsed.text).toBe("Faktura w załączniku");
    expect(parsed.attachments).toEqual([
      { mimeType: "image/png", size: 4, contentId: "<logo@example.pl>", inline: true },
      {
        filename: "Faktura zażółć.pdf",
        mimeType: "application/pdf",
        size: "%PDF-1.4 fake content for the size check".length,
        inline: false,
      },
    ]);
  });

  it("returns an empty message id when the header is missing and reads reply headers", async () => {
    const parsed = await parser.parse(
      crlf([
        "From: a@example.pl",
        "Subject: Re: coś",
        "In-Reply-To: <b@example.pl>",
        "References: <a@example.pl>",
        " <b@example.pl>",
        "",
        "ok",
      ]),
    );
    expect(parsed.messageId).toBe("");
    expect(parsed.inReplyTo).toBe("<b@example.pl>");
    expect(parsed.references).toEqual(["<a@example.pl>", "<b@example.pl>"]);
    expect(parsed.dateMs).toBeUndefined();
    expect(parsed.to).toEqual([]);
  });

  it("does not fail on an empty or header-less message", async () => {
    const parsed = await parser.parse(new TextEncoder().encode(""));
    expect(parsed.subject).toBe("");
    expect(parsed.text).toBe("");
  });
});

describe("htmlToText", () => {
  it("keeps text that looks like a tag but is not, and drops comments and scripts", () => {
    expect(htmlToText("a < b <!-- hidden --> and c<script>x()</script>d")).toBe("a < b and cd");
  });

  it("copes with unterminated markup in linear time", () => {
    const evil = `${"<".repeat(50_000)}text`;
    const started = performance.now();
    htmlToText(evil);
    htmlToText(`<script>${"<".repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("what HTML mail becomes", () => {
  const parse = (lines: string[]) =>
    new PostalMimeParser().parse(new TextEncoder().encode(lines.join("\r\n")));
  const html = (body: string, extra: string[] = []) => [
    "From: a@example.com",
    ...extra,
    "Content-Type: text/html; charset=utf-8",
    "",
    body,
  ];

  it("leaves markup and invisible characters out of the text", () => {
    expect(
      htmlToText(
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0"><?xml version="1.0"?><p>In&shy;voice &zwnj;&eacute;&hearts;</p>',
      ),
    ).toBe("Invoice é♥");
  });

  it("keeps the HTML with its kind, and text for search", async () => {
    const parsed = await parse(html("<table><tr><td><img src=a><img src=b>Sale</td></tr></table>"));
    expect(parsed.text).toBe("Sale");
    expect(parsed.htmlKind).toBe("designed");
    expect(parsed.html).toContain("<table>");
  });

  it("treats HTML sent as the text part as HTML", async () => {
    const parsed = await parse([
      "From: a@example.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "<!DOCTYPE html><html><body><p>Hello</p></body></html>",
    ]);
    expect(parsed.text).toBe("Hello");
    expect(parsed.html).toContain("<p>Hello</p>");
  });

  it("has no HTML for a plain message", async () => {
    const parsed = await parse(["From: a@example.com", "", "Just words"]);
    expect(parsed.html).toBeUndefined();
    expect(parsed.htmlKind).toBeUndefined();
  });

  it("embeds a small inline image and leaves other types out", async () => {
    const parsed = await parse([
      "From: a@example.com",
      'Content-Type: multipart/related; boundary="b"',
      "",
      "--b",
      "Content-Type: text/html",
      "",
      '<img src="cid:logo@x"><img src="cid:evil@x">',
      "--b",
      "Content-Type: image/png",
      "Content-ID: <logo@x>",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--b",
      "Content-Type: image/svg+xml",
      "Content-ID: <evil@x>",
      "Content-Transfer-Encoding: base64",
      "",
      "PHN2Zy8+",
      "--b--",
    ]);
    expect(parsed.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(parsed.html).toContain('src="cid:evil@x"');
  });
});

describe("classifyHtml", () => {
  const none = new Set<string>();

  it("believes list headers", () => {
    expect(classifyHtml("<p>hi</p>", new Set(["list-unsubscribe"]))).toBe("designed");
  });

  it("sees a page in its markup", () => {
    expect(classifyHtml("<table></table><table></table><table></table>", none)).toBe("designed");
    expect(classifyHtml("<style>a{}</style><img src=x>", none)).toBe("designed");
  });

  it("sees a person in what mail programs write, even with a table in the signature", () => {
    expect(classifyHtml("<p>Hi Anna</p><p>Best</p>", none)).toBe("simple");
    expect(
      classifyHtml(
        '<p class="MsoNormal">Hi</p><style>a{}</style><table></table><table></table><table></table><img src=x>',
        none,
      ),
    ).toBe("simple");
    expect(
      classifyHtml(
        '<div class="gmail_signature"><table></table><img src=a><img src=b></div>',
        none,
      ),
    ).toBe("simple");
  });
});
