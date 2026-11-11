// What of a message goes into a prompt.

/**
 * The text of one message that goes into a prompt (ADR 0052, rule 8; ADR 0051, rule 8): when the
 * message has HTML, the words its page would show, so text hidden from the person never reaches a
 * model; otherwise the stored plain text. The stored text is kept for search and is not trusted
 * for this, because mail stored before hidden words were left out still holds them.
 */
export function textForPrompt(input: {
  readonly text: string;
  readonly html?: string;
  visibleText(html: string): string;
}): string {
  if (input.html !== undefined) {
    const shown = input.visibleText(input.html);
    if (shown !== "") return shown;
  }
  return input.text;
}
