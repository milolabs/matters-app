import { describe, expect, it } from "vitest";
import { attachmentsOfMime, decodePart, findPart } from "../src/index.ts";

const raw = (lines: string[]) => Buffer.from(lines.join("\r\n"));

const nested = raw([
  "Subject: nested",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/related; boundary="inner"',
  "",
  "--inner",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain",
  "",
  "plain",
  "--alt",
  "Content-Type: text/html",
  "",
  "<p>html</p>",
  "--alt--",
  "--inner",
  "Content-Type: image/png",
  "Content-ID: <logo@x>",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("PNGDATA").toString("base64"),
  "--inner--",
  "--outer",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Disposition: attachment; filename*=utf-8''Raport%20roczny%20%C5%BC.txt",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "caf=C3=A9 au lait=",
  "",
  "--outer",
  'Content-Type: application/octet-stream; name="=?UTF-8?B?xbzDs8WCdy5iaW4=?="',
  "",
  "raw bytes",
  "--outer",
  "Content-Type: message/rfc822",
  "",
  "Subject: inner",
  "",
  "forwarded",
  "--outer--",
  "",
]);

describe("parts of a raw message, numbered as IMAP numbers them (ADR 0136, rule 8)", () => {
  it("lists the files with part ids, names decoded, inline parts marked", () => {
    expect(attachmentsOfMime(nested)).toEqual([
      {
        partId: "1.2",
        name: "attachment.png",
        mimeType: "image/png",
        size: 7,
        inline: true,
        contentId: "logo@x",
      },
      { partId: "2", name: "Raport roczny ż.txt", mimeType: "text/plain", size: 20, inline: false },
      {
        partId: "3",
        name: "żółw.bin",
        mimeType: "application/octet-stream",
        size: 9,
        inline: false,
      },
      { partId: "4", name: "message.eml", mimeType: "message/rfc822", size: 27, inline: false },
    ]);
  });

  it("decodes the one part a download asks for", () => {
    const text = (id: string) => {
      const part = findPart(nested, id);
      return part === undefined
        ? undefined
        : Buffer.from(decodePart(nested, part)).toString("utf8");
    };
    expect(text("1.2")).toBe("PNGDATA");
    expect(text("2")).toBe("café au lait");
    expect(text("1.1.1")).toBe("plain");
    expect(text("9")).toBeUndefined();
  });

  it("a part of a digest without a Content-Type is a message, not text (RFC 2046, 5.1.5)", () => {
    const digest = raw([
      "Subject: digest",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: text/plain",
      "",
      "the letter",
      "--outer",
      'Content-Type: multipart/digest; boundary="d"',
      "",
      "--d",
      "",
      "Subject: first",
      "",
      "one",
      "--d",
      "Content-Type: text/plain",
      "",
      "a note",
      "--d--",
      "--outer--",
      "",
    ]);
    expect(attachmentsOfMime(digest).map((a) => [a.partId, a.mimeType])).toEqual([
      ["2.1", "message/rfc822"],
    ]);
  });

  it("a message of one part is part 1; one with no structure is not a file", () => {
    const single = raw([
      "Content-Type: application/pdf; name=a.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "QUJD",
      "",
    ]);
    expect(attachmentsOfMime(single).map((a) => [a.partId, a.name])).toEqual([["1", "a.pdf"]]);
    expect(Buffer.from(decodePart(single, findPart(single, "1") as never)).toString()).toBe("ABC");
    expect(attachmentsOfMime(raw(["Subject: x", "", "just text"]))).toEqual([]);
    expect(attachmentsOfMime(new Uint8Array())).toEqual([]);
  });
});
