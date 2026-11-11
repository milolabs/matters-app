import type { MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { attachmentsOf, decodedSize } from "../src/structure.ts";

type Node = MessageStructureObject;

const text = (part: string, subtype = "plain", over: Partial<Node> = {}): Node => ({
  part,
  type: `text/${subtype}`,
  parameters: { charset: "utf-8" },
  encoding: "quoted-printable",
  size: 400,
  ...over,
});

const file = (
  part: string,
  type: string,
  name: string | undefined,
  size: number,
  over: Partial<Node> = {},
): Node => ({
  part,
  type,
  ...(name === undefined ? {} : { parameters: { name } }),
  encoding: "base64",
  size,
  disposition: "attachment",
  ...(name === undefined ? {} : { dispositionParameters: { filename: name } }),
  ...over,
});

const multi = (subtype: string, children: Node[], part?: string): Node => ({
  ...(part === undefined ? {} : { part }),
  type: `multipart/${subtype}`,
  childNodes: children,
});

describe("attachmentsOf: real message shapes (ADR 0043, rules 1 to 3)", () => {
  it("finds nothing in a plain text message", () => {
    expect(attachmentsOf({ type: "text/plain", encoding: "7bit", size: 120 })).toEqual([]);
  });

  it("finds nothing in text and HTML alternatives", () => {
    const tree = multi("alternative", [text("1"), text("2", "html")]);
    expect(attachmentsOf(tree)).toEqual([]);
  });

  it("lists the file of multipart/mixed, with its type, part number and decoded size", () => {
    const tree = multi("mixed", [text("1"), file("2", "application/pdf", "Faktura.pdf", 78_000)]);
    expect(attachmentsOf(tree)).toEqual([
      {
        partId: "2",
        name: "Faktura.pdf",
        mimeType: "application/pdf",
        size: 57_000,
        inline: false,
      },
    ]);
  });

  it("keeps the order of the message and several files on one message", () => {
    const tree = multi("mixed", [
      multi("alternative", [text("1.1"), text("1.2", "html")], "1"),
      file("2", "application/pdf", "a.pdf", 780),
      file("3", "image/png", "b.png", 780),
      file("4", "application/zip", "c.zip", 780),
    ]);
    expect(attachmentsOf(tree).map((a) => [a.partId, a.name])).toEqual([
      ["2", "a.pdf"],
      ["3", "b.png"],
      ["4", "c.zip"],
    ]);
  });

  it("marks an image with a Content-ID inside multipart/related as inline", () => {
    const tree = multi("mixed", [
      multi(
        "related",
        [
          multi("alternative", [text("1.1.1"), text("1.1.2", "html")], "1.1"),
          {
            part: "1.2",
            type: "image/png",
            id: "<logo@example>",
            encoding: "base64",
            size: 3900,
            disposition: "inline",
            dispositionParameters: { filename: "logo.png" },
          },
        ],
        "1",
      ),
      file("2", "application/pdf", "umowa.pdf", 780),
    ]);
    const found = attachmentsOf(tree);
    expect(found.map((a) => [a.partId, a.name, a.inline])).toEqual([
      ["1.2", "logo.png", true],
      ["2", "umowa.pdf", false],
    ]);
    expect(found[0]?.contentId).toBe("logo@example");
  });

  it("lists a file with a Content-ID that is not inside multipart/related", () => {
    const tree = multi("mixed", [
      text("1"),
      file("2", "application/pdf", "tagged.pdf", 780, { id: "<abc@example>" }),
    ]);
    const [only] = attachmentsOf(tree);
    expect(only).toMatchObject({ name: "tagged.pdf", inline: false, contentId: "abc@example" });
  });

  it("lists an image in related that has no Content-ID: nothing points at it", () => {
    const tree = multi("related", [
      text("1", "html"),
      { part: "2", type: "image/jpeg", encoding: "base64", size: 780, disposition: "inline" },
    ]);
    expect(attachmentsOf(tree)).toEqual([
      expect.objectContaining({ partId: "2", name: "attachment.jpg", inline: false }),
    ]);
  });

  it("looks through nested multiparts", () => {
    const tree = multi("mixed", [
      multi(
        "mixed",
        [
          multi("alternative", [text("1.1.1"), text("1.1.2", "html")], "1.1"),
          file("1.2", "application/pdf", "inner.pdf", 780),
        ],
        "1",
      ),
      file("2", "application/zip", "outer.zip", 780),
    ]);
    expect(attachmentsOf(tree).map((a) => a.partId)).toEqual(["1.2", "2"]);
  });

  it("lists a forwarded message as one file and does not walk into it", () => {
    const tree = multi("mixed", [
      text("1"),
      {
        part: "2",
        type: "message/rfc822",
        encoding: "7bit",
        size: 5000,
        disposition: "attachment",
        // ImapFlow nests the structure of the inner message under the same part number.
        childNodes: [
          multi("mixed", [text("2.1"), file("2.2", "application/pdf", "deep.pdf", 780)], "2"),
        ],
      },
    ]);
    expect(attachmentsOf(tree)).toEqual([
      {
        partId: "2",
        name: "message.eml",
        mimeType: "message/rfc822",
        size: 5000,
        inline: false,
      },
    ]);
  });

  it("lists a calendar invitation next to the text, named invite.ics", () => {
    const tree = multi("alternative", [
      text("1"),
      text("2", "html"),
      {
        part: "3",
        type: "text/calendar",
        parameters: { charset: "utf-8", method: "REQUEST" },
        encoding: "7bit",
        size: 900,
      },
    ]);
    expect(attachmentsOf(tree)).toEqual([
      expect.objectContaining({ partId: "3", name: "invite.ics", mimeType: "text/calendar" }),
    ]);
  });

  it("names a part with no name from its type", () => {
    const tree = multi("mixed", [
      text("1"),
      file("2", "application/pdf", undefined, 780),
      file("3", "application/x-unheard-of", undefined, 780),
    ]);
    expect(attachmentsOf(tree).map((a) => a.name)).toEqual(["attachment.pdf", "attachment"]);
  });

  it("takes the name from the Content-Type when there is no disposition filename", () => {
    const tree = multi("mixed", [
      text("1"),
      {
        part: "2",
        type: "application/pdf",
        parameters: { name: "stary-klient.pdf" },
        encoding: "base64",
        size: 780,
      },
    ]);
    expect(attachmentsOf(tree)[0]?.name).toBe("stary-klient.pdf");
  });

  it("keeps a name with Polish letters that ImapFlow has decoded", () => {
    const tree = multi("mixed", [
      text("1"),
      file("2", "application/pdf", "Zażółć gęślą jaźń.pdf", 780),
    ]);
    expect(attachmentsOf(tree)[0]?.name).toBe("Zażółć gęślą jaźń.pdf");
  });

  it("cleans a name through safeFileName: no path, no override", () => {
    const rlo = String.fromCodePoint(0x202e);
    const tree = multi("mixed", [
      text("1"),
      file("2", "application/octet-stream", `../../.zshrc`, 780),
      file("3", "application/octet-stream", `invoice.pdf${rlo}exe`, 780),
      file("4", "application/octet-stream", "   ", 780),
    ]);
    expect(attachmentsOf(tree).map((a) => a.name)).toEqual([
      "zshrc",
      "invoice.pdfexe",
      "attachment",
    ]);
  });

  it("lists a text file that has a name or is marked as an attachment, but not the letter's text", () => {
    const tree = multi("mixed", [
      text("1"),
      text("2", "plain", {
        disposition: "attachment",
        dispositionParameters: { filename: "notatki.txt" },
      }),
      text("3", "csv", { parameters: { name: "dane.csv" } }),
      text("4", "html", { disposition: "attachment" }),
    ]);
    expect(attachmentsOf(tree).map((a) => [a.partId, a.name])).toEqual([
      ["2", "notatki.txt"],
      ["3", "dane.csv"],
      ["4", "attachment.html"],
    ]);
  });

  it("gives a message that is itself one file the part number 1", () => {
    const only: Node = {
      type: "application/pdf",
      parameters: { name: "tylko.pdf" },
      encoding: "base64",
      size: 7800,
      disposition: "attachment",
      dispositionParameters: { filename: "tylko.pdf" },
    };
    expect(attachmentsOf(only)).toEqual([
      expect.objectContaining({ partId: "1", name: "tylko.pdf" }),
    ]);
  });

  it("lists a signature part, since it is a file that is not the text", () => {
    const tree = multi("signed", [
      text("1"),
      {
        part: "2",
        type: "application/pkcs7-signature",
        parameters: { name: "smime.p7s" },
        encoding: "base64",
        size: 780,
      },
    ]);
    expect(attachmentsOf(tree)).toEqual([expect.objectContaining({ name: "smime.p7s" })]);
  });

  it("handles a deeply nested structure without losing the part numbers", () => {
    const tree = multi("mixed", [
      multi(
        "mixed",
        [multi("mixed", [file("1.1.1", "application/pdf", "g.pdf", 780)], "1.1")],
        "1",
      ),
    ]);
    expect(attachmentsOf(tree)[0]?.partId).toBe("1.1.1");
  });
});

describe("decodedSize", () => {
  it("takes a quarter off base64: 57 bytes of every 78 of a line", () => {
    expect(decodedSize(7800, "base64")).toBe(5700);
    expect(decodedSize(7800, "BASE64")).toBe(5700);
    expect(decodedSize(0, "base64")).toBe(0);
  });

  it("leaves other encodings as the server counted them", () => {
    expect(decodedSize(1234, "7bit")).toBe(1234);
    expect(decodedSize(1234, "quoted-printable")).toBe(1234);
    expect(decodedSize(1234, undefined)).toBe(1234);
  });
});
