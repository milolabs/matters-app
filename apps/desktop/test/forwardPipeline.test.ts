// A forward through the real pipeline (ADR 0045): the draft core builds, the Markdown renderer
// of the compose adapter, nodemailer's message, and the files of the real file work.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { attachmentPath, captureFile, createFileWork, type FileDirs } from "@matters/adapter-files";
import { NodemailerComposer } from "@matters/adapter-smtp";
import type { ComposeInput, Message } from "@matters/core";
import { buildForward, forwardSubject, messageKey } from "@matters/core";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const account = { id: "acc1", address: "me@example.com", displayName: "Miłosz Sobczak" };
const NOV_3 = new Date(2026, 10, 3, 10, 29).getTime();

function message(over: Partial<Message> = {}): Message {
  return {
    key: messageKey(NOV_3, 0),
    accountId: "acc1",
    providerId: "m1",
    threadId: "t1",
    messageIdHeader: "<orig@northwind.example>",
    dateMs: NOV_3,
    from: { name: "Anna Nowak", address: "anna@example.com" },
    to: [{ name: "Miłosz Sobczak", address: "milosz@example.com" }],
    cc: [],
    subject: "Budget",
    snippet: "",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown",
    ...over,
  };
}

const renderer = new MarkdownComposeRenderer();

/** The HTML of a forward of `m`, and the text part exactly as the message carries it. */
function forwarded(m: Message, bodyText = "Hello there.") {
  const draft = buildForward({ account, message: m, bodyText });
  return { draft, ...renderer.render(draft.bodyMarkdown) };
}

/** The lines of the first blockquote, as a reader sees them: tags gone, a `<br>` ends a line. */
function quotedLines(html: string): string[] {
  const quote = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(html)?.[1] ?? "";
  return quote
    .split(/<br\s*\/?>|<\/p>/)
    .map((line) =>
      line
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
    )
    .map((line) => line.replace(/&amp;/g, "&").trim())
    .filter((line) => line !== "");
}

describe("the header of a forward through the renderer (rule 4)", () => {
  const expected = [
    "Forwarded message",
    "From: Anna Nowak (anna@example.com)",
    "Date: 3 Nov 2026, 10:29",
    "Subject: Budget",
    "To: Miłosz Sobczak (milosz@example.com)",
    "Hello there.",
  ];

  it("is one line each in the HTML part", () => {
    expect(quotedLines(forwarded(message()).html)).toEqual(expected);
  });

  it("is one line each in the text part", () => {
    const { text } = forwarded(message());
    const lines = text.split("\n").filter((l) => l.startsWith(">"));
    expect(lines).toEqual([
      "> Forwarded message",
      "> From: Anna Nowak (anna@example.com)",
      "> Date: 3 Nov 2026, 10:29",
      "> Subject: Budget",
      "> To: Miłosz Sobczak (milosz@example.com)",
      ">",
      "> Hello there.",
    ]);
  });

  it("has a Cc line when there is one, and still a line each", () => {
    const lines = quotedLines(
      forwarded(message({ cc: [{ name: "Jan", address: "jan@example.com" }] })).html,
    );
    expect(lines.slice(1, 6)).toEqual([
      "From: Anna Nowak (anna@example.com)",
      "Date: 3 Nov 2026, 10:29",
      "Subject: Budget",
      "To: Miłosz Sobczak (milosz@example.com)",
      "Cc: Jan (jan@example.com)",
    ]);
  });

  it("puts what the person writes above the quote, outside it", () => {
    const { draft } = forwarded(message());
    const html = renderer.render(`Please see below.${draft.bodyMarkdown}`).html;
    expect(html.indexOf("Please see below.")).toBeLessThan(html.indexOf("<blockquote"));
  });
});

describe("a name written by a stranger is text (rule 5)", () => {
  const hostile = [
    "[Click here](https://evil.example)",
    "*x*",
    "_x_",
    "`ticks`",
    "<b>bold</b>",
    "# heading",
    "> quote",
    "https://evil.example/path",
    "<https://evil.example>",
    "www.evil.example",
    "evil@phish.example",
    "<evil@phish.example>",
    "![img](https://evil.example/p.png)",
    "~~gone~~",
    "&lt;script&gt;",
    "[a][1]\n\n[1]: https://evil.example",
  ];

  /** The only links a header may hold: each address it names, to that very address. */
  function expectOnlyAddressLinks(html: string, addresses: readonly string[]) {
    const links = [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    expect(links.length).toBe((html.match(/<a[\s>]/g) ?? []).length);
    for (const [, href, text] of links) {
      expect(addresses).toContain(text);
      expect(href).toBe(`mailto:${text}`);
    }
  }

  function from(name: string) {
    return forwarded(message({ from: { name, address: "real@sender.example" } })).html;
  }
  const withoutQuoteSyntax = (html: string) => html.replace(/<\/?(p|br|blockquote)[^>]*>/g, "");

  it.each(hostile)("%j becomes neither a link nor formatting", (name) => {
    const html = from(name);
    // Not one tag a person's Markdown would make, and nothing in a name links: the recipient gets
    // the characters. The sender's real address may link, to itself.
    expectOnlyAddressLinks(html, ["real@sender.example", "milosz@example.com"]);
    expect(html).not.toMatch(/<(strong|em|code|pre|b|i|h[1-6]|img|script|del|s|ul|ol|li)[\s>]/);
    expect(html).not.toMatch(/evil\.example[^<]*<\/a>|href="[^"]*evil/);
    expect(quotedLines(html)).toHaveLength(6);
    expect(withoutQuoteSyntax(html)).toContain("real@sender.example");
  });

  it("shows a name with Markdown in it exactly as it was written", () => {
    const line = (name: string) => quotedLines(from(name))[1] as string;
    expect(line("[Click here](https://evil.example)")).toBe(
      "From: [Click here](https://evil.example) (real@sender.example)",
    );
    expect(line("*x* and _y_ and `z`")).toBe("From: *x* and _y_ and `z` (real@sender.example)");
    expect(line("<b>bold</b>")).toBe("From: <b>bold</b> (real@sender.example)");
    expect(line("evil@phish.example")).toBe("From: evil@phish.example (real@sender.example)");
    expect(line("https://evil.example/path")).toBe(
      "From: https://evil.example/path (real@sender.example)",
    );
  });

  it("an ordinary name and its address are not changed by any of it", () => {
    expect(quotedLines(from("Anna Nowak-Kowalska (Biuro)"))[1]).toBe(
      "From: Anna Nowak-Kowalska (Biuro) (real@sender.example)",
    );
  });

  it("a sender with no name shows the bare address, which stays a link to that address", () => {
    const html = forwarded(message({ from: { address: "real@sender.example" } })).html;
    const links = [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, href, text] of links) expect(href).toBe(`mailto:${text}`);
    expect(links.map((l) => l[2])).toContain("real@sender.example");
  });

  it("a subject with Markdown is plain text too", () => {
    const html = forwarded(message({ subject: "[Pay now](https://evil.example) *urgent*" })).html;
    expectOnlyAddressLinks(html, ["anna@example.com", "milosz@example.com"]);
    expect(html).not.toMatch(/<em[\s>]|<strong[\s>]/);
    expect(quotedLines(html)[3]).toBe("Subject: [Pay now](https://evil.example) *urgent*");
  });

  it("a name in To and Cc is just as inert", () => {
    const html = forwarded(
      message({
        to: [{ name: "[x](https://evil.example)", address: "a@b.example" }],
        cc: [{ name: "*c*", address: "c@d.example" }],
      }),
    ).html;
    expectOnlyAddressLinks(html, ["anna@example.com", "a@b.example", "c@d.example"]);
    expect(html).not.toMatch(/<em[\s>]/);
    expect(quotedLines(html).slice(4, 6)).toEqual([
      "To: [x](https://evil.example) (a@b.example)",
      "Cc: *c* (c@d.example)",
    ]);
  });

  it("the subject of the draft itself is not Markdown and stays as it is", () => {
    expect(forwarded(message({ subject: "*Budget*" })).draft.subject).toBe(
      forwardSubject("*Budget*"),
    );
  });
});

describe("the message that goes out (rules 2 and 7)", () => {
  let root: string;
  let dirs: FileDirs;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "matters-forward-"));
    dirs = { attachments: join(root, "attachments"), spool: join(root, "spool") };
    mkdirSync(join(root, "cache"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const composer = new NodemailerComposer();
  const work = () => createFileWork(dirs, (input, parts) => composer.composeToStream(input, parts));
  /** Every byte value twice, so nothing text-like can hide a change. */
  const binary = Uint8Array.from({ length: 512 }, (_, i) => i % 256);

  async function sent(files: { name: string; bytes: Uint8Array }[]) {
    const { draft, html, text } = forwarded(message());
    const hashes: { attachmentId: string; name: string; sha256: string }[] = [];
    for (const [i, file] of files.entries()) {
      // What the cache holds, and what a capture from it makes (rule 7).
      const cached = join(root, "cache", `part-${i}`);
      writeFileSync(cached, file.bytes);
      const done = await captureFile(
        dirs,
        { attachmentId: `att${i}`, sourcePath: cached },
        () => {},
      );
      hashes.push({ attachmentId: `att${i}`, name: file.name, sha256: done.sha256 });
    }
    const input: ComposeInput = {
      from: draft.from,
      to: [{ name: "Jan", address: "jan@example.com" }],
      cc: draft.cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      html,
      text,
      dateMs: NOV_3,
    };
    const built = await work().buildMessage(input, hashes, "op1");
    const raw = readFileSync(built.spoolPath);
    return { raw, parsed: await PostalMime.parse(new Uint8Array(raw)), draft };
  }

  it("starts a conversation: no In-Reply-To, no References", async () => {
    const { raw, parsed, draft } = await sent([{ name: "a.bin", bytes: binary }]);
    const head = raw.toString("latin1").split("\r\n\r\n")[0] as string;
    expect(head).not.toMatch(/^in-reply-to:/im);
    expect(head).not.toMatch(/^references:/im);
    expect(parsed.inReplyTo ?? "").toBe("");
    expect(parsed.references ?? "").toBe("");
    expect(parsed.subject).toBe("Fwd: Budget");
    expect(draft.threadId).toBeUndefined();
    expect(parsed.to).toMatchObject([{ name: "Jan", address: "jan@example.com" }]);
  });

  it("carries the files byte for byte, with their names, in order", async () => {
    const second = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);
    const { parsed } = await sent([
      { name: "Faktura FV 2026.pdf", bytes: binary },
      { name: "zdjęcie.jpg", bytes: second },
    ]);
    expect(parsed.attachments.map((a) => a.filename)).toEqual([
      "Faktura FV 2026.pdf",
      "zdjęcie.jpg",
    ]);
    const content = (i: number) => new Uint8Array(parsed.attachments[i]?.content as ArrayBuffer);
    expect(content(0)).toEqual(binary);
    expect(content(1)).toEqual(second);
    expect(createHash("sha256").update(content(1)).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });

  it("is the text of the message and its quote, with the header on lines of their own", async () => {
    const { parsed } = await sent([]);
    expect(parsed.text).toContain(
      "> From: Anna Nowak (anna@example.com)\n> Date: 3 Nov 2026, 10:29",
    );
    expect(parsed.html).toContain("<blockquote");
    expect(parsed.attachments).toEqual([]);
  });

  it("a copy the cache lost afterwards changes nothing: the draft's copy is its own", async () => {
    const cached = join(root, "cache", "part-0");
    writeFileSync(cached, binary);
    const done = await captureFile(dirs, { attachmentId: "att0", sourcePath: cached }, () => {});
    rmSync(cached);
    expect(readFileSync(attachmentPath(dirs, "att0"))).toEqual(Buffer.from(binary));
    expect(done.size).toBe(binary.byteLength);
  });
});
