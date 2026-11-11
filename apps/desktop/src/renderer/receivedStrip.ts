// The files of a received message as chips (ADR 0043, rules 15 to 17). Pure helpers: the strip in
// receivedStrip.tsx draws them, and the controller in received.ts holds the state.
import type { ReceivedAnswer } from "@matters/contracts";
import { isRunnableFile } from "@matters/core";
import { fileSize } from "./format.ts";

/** More files than this fold behind "12 more" (rule 15). */
export const VISIBLE_FILES = 5;
/** Under 1 MiB the ring is not drawn: it would flash (rule 17). */
export const RING_FROM_BYTES = 1_048_576;

/**
 * Where a file stands in this window (rule 17).
 * - `idle`: not downloaded yet, or downloaded and ready; both look the same, and a press is the
 *   same press (the second is just instant).
 * - `downloading`: the ring fills with the true bytes.
 * - `offline`, `failed`: could not be downloaded; a press tries again.
 * - `gone`: the message is no longer on the server. Nothing to try.
 */
export type Phase = "idle" | "downloading" | "offline" | "failed" | "gone";

/** The name in two pieces, for middle truncation that keeps the end of the name visible. */
export interface NameParts {
  /** Shrinks with an ellipsis when there is no room. */
  readonly head: string;
  /** Always shown: the extension, and a few characters before it. */
  readonly tail: string;
}

/** Names shorter than this are not split: there is nothing worth keeping apart. */
const SHORT_NAME = 14;
/** What stays visible before the extension. */
const TAIL_BEFORE_EXTENSION = 4;
/** A "extension" longer than this is not one; the tail is then just the last characters. */
const MAX_EXTENSION = 8;
const TAIL_WITHOUT_EXTENSION = 6;

/**
 * Splits a name for middle truncation (rule 15). CSS puts the ellipsis at the end of the head
 * and keeps the tail whole, so `Zestawienie kosztów … (poprawione).xlsx` loses its middle and not
 * its `.xlsx`. The cut never falls inside a character, or between a letter and its accent.
 */
export function splitName(name: string): NameParts {
  const chars = Array.from(name);
  if (chars.length <= SHORT_NAME) return { head: name, tail: "" };
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? Array.from(name.slice(dot)).length : 0;
  const keep =
    extension > 0 && extension <= MAX_EXTENSION
      ? extension + TAIL_BEFORE_EXTENSION
      : TAIL_WITHOUT_EXTENSION;
  let cut = Math.max(1, chars.length - keep);
  // A combining mark belongs to the character before it.
  while (cut > 1 && /\p{M}/u.test(chars[cut] ?? "")) cut--;
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}

/** Which unit a total is counted in, so "14 of 34 MB" has one unit and not two. */
function unitFor(total: number): { divisor: number; suffix: string } {
  if (total >= 1_000_000_000) return { divisor: 1_000_000_000, suffix: "GB" };
  if (total >= 1_000_000) return { divisor: 1_000_000, suffix: "MB" };
  if (total >= 1000) return { divisor: 1000, suffix: "KB" };
  return { divisor: 1, suffix: "B" };
}

/** "14 of 34 MB": one decimal only when the number is not whole, as Finder counts. */
export function progressText(bytes: number, total: number): string {
  const { divisor, suffix } = unitFor(total);
  const part = (n: number) => {
    const rounded = Math.round((n / divisor) * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  };
  return `${part(Math.min(bytes, total))} of ${part(total)} ${suffix}`;
}

/** The ring is drawn for files of 1 MiB or more. */
export const drawsRing = (size: number): boolean => size >= RING_FROM_BYTES;

/**
 * What the ring is set to. With reduced motion it steps by quarters, so nothing sweeps; the
 * words beside it give the number (rule 17).
 */
export function ringFraction(bytes: number, total: number, reducedMotion: boolean): number {
  const fraction = total <= 0 ? 0 : Math.min(1, Math.max(0, bytes / total));
  return reducedMotion ? Math.floor(fraction * 4) / 4 : fraction;
}

/** What a chip says in the place the size has, with its tone (rule 17). */
export function chipLabel(
  phase: Phase,
  size: number,
): { readonly text: string; readonly tone: "plain" | "late" } {
  switch (phase) {
    case "offline":
    case "failed":
      return { text: "Couldn’t download", tone: "late" };
    case "gone":
      return { text: "No longer on the server", tone: "plain" };
    case "downloading":
      // Progress rewrites this at once; it is what shows before the first report.
      return { text: drawsRing(size) ? progressText(0, size) : fileSize(size), tone: "plain" };
    case "idle":
      return { text: fileSize(size), tone: "plain" };
  }
}

/** The words of the action beside a failed chip. */
export const RETRY_TEXT = "Try again";

/** The one line under a runnable file (rule 12). */
export const RUNNABLE_NOTE = "This kind of file can run programs, so Matters doesn’t open it.";

/** What a screen reader hears for a chip: name, size, and where it stands, never a percentage. */
export function chipSpeech(name: string, size: number, phase: Phase, runnable: boolean): string {
  const base = `${name}, ${fileSize(size)}`;
  switch (phase) {
    case "downloading":
      return `${base}, downloading`;
    case "offline":
    case "failed":
      return `${base}, couldn’t download. Press to try again`;
    case "gone":
      return `${base}, no longer on the server`;
    case "idle":
      return runnable ? `${base}, can run programs, so it can be saved but not opened` : base;
  }
}

/** The state change a screen reader is told; null for the changes that need no words. */
export function announcement(name: string, before: Phase, after: Phase): string | null {
  if (before === after) return null;
  switch (after) {
    case "downloading":
      return `Downloading ${name}`;
    case "offline":
      return `Couldn’t download ${name}. You may be offline.`;
    case "failed":
      return `Couldn’t download ${name}.`;
    case "gone":
      return `${name} is no longer on the server.`;
    case "idle":
      return null;
  }
}

/** The phase after main answered a press, and the note (if any) to show under the strip. */
export interface Settled {
  readonly phase: Phase;
  /** The file is in the cache now, so a press is instant. */
  readonly here: boolean;
  readonly note: { readonly text: string; readonly tone: "plain" | "late" } | null;
}

/** What an answer to an open, preview or save does to a chip (rules 12, 14 and 17). */
export function settle(answer: ReceivedAnswer, name: string): Settled {
  switch (answer.kind) {
    case "opened":
    case "previewed":
    case "saved":
    case "cancelled":
      return { phase: "idle", here: answer.kind !== "cancelled", note: null };
    case "gone":
      return { phase: "gone", here: false, note: null };
    case "offline":
      return { phase: "offline", here: false, note: null };
    case "failed":
      return { phase: "failed", here: false, note: null };
    case "refused":
      switch (answer.reason) {
        case "runnable":
          return { phase: "idle", here: true, note: { text: RUNNABLE_NOTE, tone: "plain" } };
        case "quarantine":
          return {
            phase: "idle",
            here: true,
            note: { text: `Couldn’t open ${name} safely. Save it instead.`, tone: "late" },
          };
        case "unsupported":
          return {
            phase: "idle",
            here: false,
            note: { text: "Preview is only available on macOS.", tone: "plain" },
          };
        case "invalid":
          return { phase: "failed", here: false, note: null };
      }
  }
}

/** How many files show before the fold, and what the fold says (rule 15). */
export function visibleFiles(total: number, expanded: boolean): number {
  return expanded || total <= VISIBLE_FILES ? total : VISIBLE_FILES;
}

export const foldLabel = (hidden: number): string => `${hidden} more`;

/** Whether Open is offered for this name at all (rule 12): the same function main checks again. */
export const canOpen = (name: string): boolean => !isRunnableFile(name);

/** The note after a Save all (rule 13). */
export function saveAllNote(
  answer: ReceivedAnswer,
): { readonly text: string; readonly tone: "plain" | "late" } | null {
  if (answer.kind === "saved") {
    const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
    return answer.skipped === 0
      ? { text: `Saved ${files(answer.count)}.`, tone: "plain" }
      : {
          text: `Saved ${files(answer.count)}. Couldn’t save ${files(answer.skipped)}.`,
          tone: "late",
        };
  }
  if (answer.kind === "cancelled") return null;
  return { text: "Couldn’t save these files.", tone: "late" };
}
