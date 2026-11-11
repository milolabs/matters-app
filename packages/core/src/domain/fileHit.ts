import type { Participant } from "./entities.ts";
import { foldText } from "./text.ts";

/** A file received in a message, found by its name (ADR 0074). */
export interface FileHit {
  /** The message that carries the file and the part of it, together the id of the file. */
  readonly messageKey: number;
  readonly partId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly threadId: string;
  readonly accountId: string;
  readonly sender: Participant;
  /** When the message was sent. */
  readonly dateMs: number;
}

/** The shortest text a substring index answers; shorter text matches the start of a word only. */
export const FILE_SUBSTRING_MIN = 3;

/** A name as it is indexed and compared (ADR 0074): folded, one space for any run of white space. */
export function foldFileName(name: string): string {
  return foldText(name).replace(/\s+/g, " ").trim();
}

/** The words of a folded name: runs of letters and digits, `Aneks_651_2026.pdf` has four. */
export function fileNameWords(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/**
 * Whether a file matches the text the person typed (both folded). Three characters or more must
 * appear anywhere in the name; one or two must start a word of it, because that is all a short
 * text can say without matching nearly everything. Short text with a separator in it matches
 * nothing.
 */
export function fileNameMatches(foldedName: string, foldedText: string): boolean {
  if (foldedText === "") return false;
  if ([...foldedText].length >= FILE_SUBSTRING_MIN) return foldedName.includes(foldedText);
  if (fileNameWords(foldedText).join("") !== foldedText) return false;
  return fileNameWords(foldedName).some((w) => w.startsWith(foldedText));
}
