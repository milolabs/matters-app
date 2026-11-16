// Save as .eml… in the reader (ADR 0145, rules 1 and 5): the letters of the open thread as main is
// asked to save them, and the line that says how far a save is. Pure, so it is tested alone.
import type { EmlLetter, EmlProgressInfo } from "./files.ts";
import { progressText } from "./receivedStrip.ts";

/** Every letter of the thread, in its order (oldest first), by key, subject and date. */
export function emlLetters(
  messages: readonly { readonly key: number; readonly subject: string; readonly dateMs: number }[],
): EmlLetter[] {
  return [...messages]
    .sort((a, b) => a.dateMs - b.dateMs || a.key - b.key)
    .map((m) => ({ messageKey: m.key, subject: m.subject, dateMs: m.dateMs }));
}

/**
 * "Saving the message · 14 of 34 MB", or with several "Saving letter 2 of 5 · 14 of 34 MB". The
 * bytes show once the server said how many there are; until then only which letter.
 */
export function emlProgressText(progress: EmlProgressInfo): string {
  const which =
    progress.count <= 1
      ? "Saving the message"
      : `Saving letter ${progress.index + 1} of ${progress.count}`;
  return progress.totalBytes > 0
    ? `${which} · ${progressText(progress.bytes, progress.totalBytes)}`
    : `${which}…`;
}
