/**
 * The letters in a sender's avatar (ADR 0073): the first letter of the first and of the last word of
 * the name, in capitals. A single word gives one letter. A bare address is read as a name: its local
 * part is split at the dots, dashes and underscores. Nothing to read gives "?".
 */
const WORD = /[\p{L}\p{N}]+/gu;

export function initials(input: string): string {
  // "Anna <anna@x.pl>" is a name and an address: the name is what people recognise.
  const named = input.replace(/<[^>]*>/g, " ").trim();
  const text = named === "" ? input.replace(/[<>]/g, "").trim() : named;
  const at = text.includes(" ") ? -1 : text.lastIndexOf("@");
  const words = (at > 0 ? text.slice(0, at) : text).match(WORD) ?? [];
  const first = words[0];
  if (first === undefined) return "?";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letter = (word: string): string => (Array.from(word)[0] ?? "").toLocaleUpperCase();
  return letter(first) + (last === undefined ? "" : letter(last));
}
