import type { ThreadMessage } from "@matters/contracts";
import type { ImageChoice } from "@matters/core";
import { describe, expect, it } from "vitest";
import { imageCopy } from "../src/renderer/imageBar.ts";
import { mailBaseStyle, mailView } from "../src/renderer/mailTheme.ts";
import {
  framePage,
  lightHtml,
  PRINT_FRAME_SANDBOX,
  type PrintNode,
  printDay,
  printDocument,
  printLetter,
  printNodes,
  printTextParts,
} from "../src/renderer/printDocument.ts";

const own = new Set(["me@example.com"]);
const me = { name: "Me", address: "me@example.com" };

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    key: 1,
    accountId: "a1",
    providerId: "p1",
    threadId: "t1",
    messageIdHeader: "<m1@x>",
    dateMs: Date.UTC(2026, 10, 16, 12, 0),
    from: { name: "Anna", address: "anna@example.com" },
    to: [me],
    cc: [],
    subject: "Invoices",
    snippet: "",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown",
    bodyText: "Hello.",
    attachments: [],
    attachmentsKnown: true,
    hasInline: false,
    ...over,
  };
}

const choice = (over: Partial<ImageChoice> = {}): ImageChoice => ({
  show: false,
  source: "none",
  verdict: "unknown",
  address: "anna@example.com",
  domain: "example.com",
  offerAddress: true,
  offerDomain: null,
  ...over,
});

const clean = (html: string) => ({ html: `${mailBaseStyle()}${html}`, theme: "none" as const });

describe("printLetter (ADR 0144, rule 2)", () => {
  it("says who, to whom, when and what as text, with every address", () => {
    const letter = printLetter(
      message({
        to: [me, { name: "", address: "piotr@example.com" }],
        cc: [{ name: "Ola", address: "ola@example.com" }],
      }),
      own,
      null,
    );
    expect(letter.from).toBe("Anna <anna@example.com>");
    expect(letter.to).toBe("Me <me@example.com>, piotr@example.com");
    expect(letter.cc).toBe("Ola <ola@example.com>");
    expect(letter.subject).toBe("Invoices");
    expect(letter.date).toContain("2026");
    expect(letter.badge).toBe("");
  });

  it("names an empty subject as the reader does, and says what the badges say", () => {
    expect(printLetter(message({ subject: "" }), own, null).subject).toBe("(no subject)");
    expect(printLetter(message({ senderAuth: "fail" }), own, null).badge).toBe(
      "Not verified · example.com",
    );
    expect(printLetter(message({ senderAuth: "pass" }), own, null).badge).toBe(
      "Verified · example.com",
    );
  });

  it("lists the files by name and size, and never prints them", () => {
    const letter = printLetter(
      message({
        hasAttachments: true,
        attachments: [
          {
            partId: "2",
            name: "Invoice.pdf",
            mimeType: "application/pdf",
            size: 120_000,
            inline: false,
          },
          { partId: "3", name: "logo.png", mimeType: "image/png", size: 2_000, inline: true },
        ],
      }),
      own,
      null,
    );
    expect(letter.attachments).toEqual(["Invoice.pdf · 120 KB"]);
    expect(
      printLetter(
        message({ hasAttachments: true, attachmentsKnown: false, attachments: [] }),
        own,
        null,
      ).attachments,
    ).toEqual(["Attachment"]);
  });

  it("prints the text as the reader shows it before anything is unfolded", () => {
    expect(printTextParts("Thanks!\n\n> earlier\n> mail\n\nBye\n-- \nAnna\nexample.com")).toEqual([
      { kind: "text", text: "Thanks!" },
      { kind: "folded", text: "Quoted text · 2 lines, not printed" },
      { kind: "text", text: "Bye" },
      { kind: "signature", text: "Anna\nexample.com" },
    ]);
    expect(printTextParts("Hi\n-- \n1\n2\n3\n4\n5")).toEqual([
      { kind: "text", text: "Hi" },
      { kind: "folded", text: "Signature, not printed" },
    ]);
  });

  it("hands the page the message's HTML and the reader's choice, and the page shows it light", () => {
    const letter = printLetter(message({ htmlKind: "designed" }), own, {
      html: "<p style='color:#000'>Hi</p>",
      images: false,
      choice: choice(),
    });
    // Not sanitized and not themed here: the print page sanitizes it, then takes the light view.
    expect(letter.body).toEqual({
      kind: "html",
      html: "<p style='color:#000'>Hi</p>",
      images: false,
    });
    // In the app's dark theme the same message is recolored; on paper it is not.
    const dark = mailView(clean("<p style='color:#000'>Hi</p>"), true);
    expect(dark.html).not.toBe(lightHtml(clean("<p style='color:#000'>Hi</p>")));
    expect(lightHtml(clean("<p style='color:#000'>Hi</p>"))).toContain("color:#000");
  });

  it("says the reader's words for blocked images, and nothing when they are shown", () => {
    const html = (images: boolean, c: ImageChoice | null) =>
      printLetter(message({ htmlKind: "designed" }), own, {
        html: '<img src="https://example.com/a.png">',
        images,
        choice: c,
      });
    expect(html(false, choice()).note).toBe(imageCopy.off);
    expect(html(false, choice({ verdict: "fail" })).note).toBe(imageCopy.unverified);
    expect(html(false, choice({ source: "address-deny" })).note).toBe(
      imageCopy.denied("anna@example.com"),
    );
    expect(html(true, choice({ show: true })).note).toBe("");
    expect(printLetter(message(), own, null).note).toBe("");
  });
});

/** Every node of a tree, depth first. */
function* all(nodes: readonly PrintNode[]): Generator<PrintNode> {
  for (const node of nodes) {
    yield node;
    if (node.tag !== "iframe") yield* all(node.children ?? []);
  }
}

/** The text of every node, in order. */
const texts = (nodes: readonly PrintNode[]) =>
  [...all(nodes)].flatMap((n) => (n.tag !== "iframe" && n.text !== undefined ? [n.text] : []));

const never = () => false;
describe("printDocument", () => {
  it("is the whole thread in order, titled by its subject, with the newest letter's day", () => {
    const a = message({ key: 1, dateMs: new Date(2026, 10, 14, 9).getTime() });
    const b = message({ key: 2, dateMs: new Date(2026, 10, 16, 9).getTime() });
    const letters = [a, b].map((m) => printLetter(m, own, null));
    const doc = printDocument("Invoices", [a, b], letters);
    expect(doc.title).toBe("Invoices");
    expect(doc.day).toBe("2026-11-16");
    expect(doc.letters).toHaveLength(2);
    expect(printDocument("", [a], [letters[0] as never]).title).toBe("(no subject)");
    expect(printDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});

describe("printNodes", () => {
  const hostile = '<img src=x onerror="parent.__pwned=1"><script>alert(1)</script>&amp;"\'';

  it("puts names and subjects in as text: markup in them prints as itself", () => {
    const letter = printLetter(
      message({
        subject: hostile,
        from: { name: hostile, address: "x@example.com" },
        attachments: [
          {
            partId: "2",
            name: "<b>a</b>.pdf",
            mimeType: "application/pdf",
            size: 1,
            inline: false,
          },
        ],
        hasAttachments: true,
        bodyText: hostile,
      }),
      own,
      null,
    );
    const nodes = printNodes({ title: hostile, day: "", letters: [letter] }, never);
    // Only our own elements: whatever a field says, it is a node's text, never an element.
    const tags = new Set([...all(nodes)].map((n) => n.tag));
    for (const tag of tags) {
      expect(["h1", "article", "dl", "div", "dt", "dd", "p", "ul", "li"]).toContain(tag);
    }
    const seen = texts(nodes);
    expect(seen[0]).toBe(hostile);
    expect(seen).toContain(`${hostile} <x@example.com>`);
    expect(seen).toContain(hostile);
    expect(seen).toContain("<b>a</b>.pdf · 1 B");
    // Nothing carries a field as a class or a label.
    for (const n of all(nodes)) {
      if (n.tag === "iframe") continue;
      expect([
        undefined,
        "head",
        "badge",
        "note",
        "mail",
        "words",
        "letter",
        "files",
        "text",
        "signature",
        "folded",
      ]).toContain(n.className);
      expect([undefined, "Attachments"]).toContain(n.label);
    }
  });

  it("gives a letter with HTML an empty sandboxed frame of the reader's page, never its markup", () => {
    const nodes = (images: boolean) =>
      printNodes(
        {
          title: "t",
          day: "",
          letters: [
            {
              ...printLetter(message(), own, null),
              body: { kind: "html", html: "<p>SECRET-BODY</p>", images },
            },
          ],
        },
        never,
      );
    expect(JSON.stringify(nodes(false))).not.toContain("SECRET-BODY");
    const frame = (images: boolean) => [...all(nodes(images))].find((n) => n.tag === "iframe");
    expect(frame(false)).toEqual({ tag: "iframe", frame: 0, images: false });
    expect(frame(true)).toEqual({ tag: "iframe", frame: 0, images: true });
    expect(framePage(false)).toBe("./mail.html");
    expect(framePage(true)).toBe("./mail-images.html");
    expect(PRINT_FRAME_SANDBOX).toBe("allow-same-origin");
  });

  it("prints the words for blocked images only for a letter that asks for images", () => {
    const letter = printLetter(message({ htmlKind: "designed" }), own, {
      html: '<img src="https://example.com/a.png">',
      images: false,
      choice: choice(),
    });
    const doc = { title: "t", day: "", letters: [letter] };
    const note = (asks: boolean) =>
      [...all(printNodes(doc, () => asks))].find((n) => n.tag === "p" && n.className === "note");
    expect(note(true)).toEqual({ tag: "p", className: "note", text: imageCopy.off });
    // A message that asks for nothing remote has nothing to say about images.
    expect(note(false)).toBeUndefined();
  });

  it("names folded quotes and lists the files", () => {
    const letter = printLetter(
      message({
        bodyText: "Hi\n> EARLIER-MAIL",
        hasAttachments: true,
        attachments: [
          { partId: "2", name: "a.pdf", mimeType: "application/pdf", size: 2_000, inline: false },
        ],
      }),
      own,
      null,
    );
    const nodes = printNodes({ title: "t", day: "", letters: [letter] }, never);
    expect([...all(nodes)]).toContainEqual({
      tag: "p",
      className: "folded",
      text: "Quoted text · 1 line, not printed",
    });
    expect(JSON.stringify(nodes)).not.toContain("EARLIER-MAIL");
    expect([...all(nodes)]).toContainEqual({
      tag: "ul",
      className: "files",
      label: "Attachments",
      children: [{ tag: "li", text: "a.pdf · 2 KB" }],
    });
  });
});
