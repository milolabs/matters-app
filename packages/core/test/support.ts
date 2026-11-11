import { createHash } from "node:crypto";
import type { Draft, DraftContent } from "../src/index.ts";
import { createDraft } from "../src/index.ts";

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const anna = { name: "Anna Kowalska", address: "anna@northwind.example" };
export const me = { name: "Miłosz", address: "me@example.com" };

export function content(overrides: Partial<DraftContent> = {}): DraftContent {
  return {
    accountId: "acc1",
    from: me,
    to: [anna],
    cc: [],
    bcc: [],
    subject: "Re: Wycena",
    bodyMarkdown: "Cena: [cena]. Pozdrawiam",
    inReplyTo: "<a1@northwind.example>",
    references: ["<a1@northwind.example>"],
    threadId: "t1",
    ...overrides,
  };
}

export function draft(overrides: Partial<DraftContent> = {}, id = "d1"): Draft {
  return createDraft(id, content(overrides), sha256, 1_000);
}
