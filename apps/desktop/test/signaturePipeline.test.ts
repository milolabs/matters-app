// The person's signature through the real pipeline (ADR 0142, rules 4 and 10): the text the core
// starts a message with, the editor's document, the draft store, the Markdown renderer, nodemailer's
// message and the parser, and then the reader, which must fold what we sent as a signature.
import { createHash } from "node:crypto";
import { EditorState } from "@codemirror/state";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { PostalMimeParser } from "@matters/adapter-mime";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { NodemailerComposer } from "@matters/adapter-smtp";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import { createDraft, type DraftContent, emptyDraftContent, placeSignature } from "@matters/core";
import { describe, expect, it } from "vitest";
import { readablePieces, splitBody, splitSignature } from "../src/renderer/body.ts";
import { ownText, signatureStart } from "../src/renderer/liveMarkdown.ts";

const account = { id: "acc1", address: "me@example.com", displayName: "Miłosz Sobczak" };
const SIGNATURE = "Miłosz Sobczak\n**Matters** · [matters.example](https://matters.example)";
const renderer = new MarkdownComposeRenderer();
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** What the person sends: the first text with the signature, and the words typed at the caret. */
function written(words: string, start = placeSignature("", SIGNATURE)): string {
  // The caret is at 0 when the composer opens (ADR 0142, rule 3): the words go above.
  const state = EditorState.create({ doc: start, selection: { anchor: 0 } });
  return state.update({ changes: { from: 0, insert: words } }).state.doc.toString();
}

async function sentText(body: string): Promise<{ text: string; html: string }> {
  const rendered = renderer.render(body);
  const composed = await new NodemailerComposer().compose({
    from: { name: account.displayName, address: account.address },
    to: [{ address: "anna@example.com" }],
    cc: [],
    subject: "Budget",
    text: rendered.text,
    html: rendered.html,
    dateMs: Date.UTC(2026, 10, 16, 10, 0),
    inReplyTo: "",
    references: [],
  });
  const parsed = await new PostalMimeParser({ registrableDomain }).parse(composed.raw);
  return { text: parsed.text, html: parsed.html ?? "" };
}

describe("the delimiter survives every step (rule 4)", () => {
  it("the editor keeps the line with its space, and the caret above it", () => {
    const body = written("Hello Anna,");
    expect(body).toBe(`Hello Anna,\n\n-- \n${SIGNATURE}`);
    expect(signatureStart(body)).toBe("Hello Anna,\n\n".length);
    // The agent's look at the person's own words leaves the signature out.
    expect(ownText(body)).toBe("Hello Anna,\n\n");
  });

  it("the draft store keeps it exactly", async () => {
    const storage = createSqliteStorage(":memory:");
    try {
      const content: DraftContent = {
        ...emptyDraftContent(account),
        to: [{ address: "anna@example.com" }],
        bodyMarkdown: written("Hello Anna,"),
      };
      const draft = createDraft("d1", content, sha256, 1);
      await storage.drafts.put(draft);
      expect((await storage.drafts.get(draft.id))?.bodyMarkdown).toBe(content.bodyMarkdown);
    } finally {
      storage.close();
    }
  });

  it("the sent text part carries `-- ` on a line of its own, and the reader folds the signature", async () => {
    const { text, html } = await sentText(written("Hello Anna,\n\nthe numbers are attached."));
    expect(text.split("\n")).toContain("-- ");
    const [plain] = splitBody(text);
    const split = splitSignature(plain?.text ?? "");
    expect(split.body).toBe("Hello Anna,\n\nthe numbers are attached.");
    expect(split.signature).toBe(SIGNATURE);
    // A short signature sits under the words; the reader counts both.
    expect(readablePieces(text)).toEqual(["Hello Anna,\n\nthe numbers are attached.", SIGNATURE]);
    // The HTML part has the quiet block, with the delimiter as text.
    expect(html).toContain('class="matters-signature"');
    expect(html).toMatch(/>-- <\/p>/);
  });

  it("a reply: the signature above the quote, the quote still quoted", async () => {
    const quote = "On 3 Nov 2026, 10:29, Anna Nowak wrote:\n> Can you send the numbers?\n";
    const start = placeSignature(`\n\n${quote}`, SIGNATURE);
    const { text } = await sentText(written("Here they are.", start));
    const segments = splitBody(text);
    expect(segments.map((s) => s.quoted)).toEqual([false, true]);
    const split = splitSignature(segments[0]?.text ?? "");
    expect(split.body).toBe("Here they are.");
    // In plain text everything under `-- ` up to the quote is the signature, the line that
    // introduces the quote with it: other readers fold it the same way.
    expect(split.signature?.startsWith(SIGNATURE)).toBe(true);
    expect(segments[1]?.text).toBe("Can you send the numbers?");
  });
});
