// Received text that goes into mail the user sends (ADR 0045 rule 5, ADR 0048): it must stay text.

/**
 * Text that stays text when Markdown reads it (rule 5). The header of a forward is written by
 * strangers: a sender named `[Click here](https://evil.example)` must not become a link in a
 * message the user sends under their own name. Only what Markdown or the renderer's `linkify`
 * reads in the middle of a line is escaped, since a header value never starts one: an underscore
 * between two letters is left alone, so `snake_case` stays readable in the text part, and the
 * `:` of `https://` goes, and the `@` of an address, so nothing in a name or a subject links.
 */
export function escapeMarkdown(text: string): string {
  return escapeAddress(text).replace(/@/g, "\\@");
}

/**
 * The same for an address, which keeps its `@`: the renderer links a bare address to that very
 * address and to nothing else, which is a link a reader can use.
 */
export function escapeAddress(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\\`*[\]<>~]/g, "\\$&")
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/:(?=\/\/)/g, "\\:");
}
