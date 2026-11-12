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

/**
 * Runs `work` and gives its result with the time it took. For the long hostile inputs of the
 * pattern tests: linear work on them takes a few milliseconds, quadratic work takes seconds.
 */
export function timed<T>(work: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = work();
  return { result, ms: performance.now() - start };
}

/** Well above a linear pass over the long inputs, well below a quadratic one. */
export const QUICK_MS = 250;
