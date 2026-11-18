// What crosses between the mail window and main about saving letters as files (ADR 0145). The
// preload checks the shape of the page's ask and main checks it again; what main sends back is
// read before the page sees it. Only types and lengths: no path crosses in either direction.

/** A thread of more letters than this is not something a person saves letter by letter. */
export const MAX_EML_LETTERS = 500;

/** One letter the page asks to save: its key, and the subject and date its name is made from. */
export interface EmlLetterAsk {
  readonly messageKey: number;
  readonly subject: string;
  readonly dateMs: number;
}

/** What the mail window is told while a save runs: which letter, and how far it is. */
export interface EmlProgress {
  readonly index: number;
  readonly count: number;
  readonly bytes: number;
  readonly totalBytes: number;
}

export type EmlAnswer =
  | { readonly kind: "cancelled" }
  | { readonly kind: "busy" }
  | { readonly kind: "invalid" }
  /** `problem`: the one phrase for what was not saved; null when every letter was. */
  | { readonly kind: "done"; readonly saved: number; readonly problem: string | null };

/** Page to main: `save` with the letters, or `stop`. */
export const CHANNEL_EML = "matters:eml";
/** Main to the mail window: the menu's Save as .eml…. */
export const CHANNEL_EML_ASK = "matters:eml-ask";
/** Main to the mail window: how far the save is, or null when it ended. */
export const CHANNEL_EML_PROGRESS = "matters:eml-progress";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A message key, as core's `isMessageKey` says; repeated here so the preload needs no core. */
const isKey = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** The page's list, checked: keys, a subject that is text and a date that is a number. */
export function readEmlLetters(value: unknown): readonly EmlLetterAsk[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EML_LETTERS) return null;
  const out: EmlLetterAsk[] = [];
  for (const item of value as unknown[]) {
    const { messageKey, subject, dateMs } = (item ?? {}) as Record<string, unknown>;
    if (!isKey(messageKey) || typeof subject !== "string" || typeof dateMs !== "number")
      return null;
    if (!Number.isFinite(dateMs)) return null;
    out.push({ messageKey, subject: subject.slice(0, 2000), dateMs });
  }
  return out;
}

const count = (v: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Main's answer as it crosses to the page; anything else reads as a failure. */
export function readEmlAnswer(v: unknown): EmlAnswer {
  if (!isRecord(v))
    return { kind: "done", saved: 0, problem: "The message could not be saved as a file." };
  if (v.kind === "cancelled" || v.kind === "busy" || v.kind === "invalid") return { kind: v.kind };
  if (
    v.kind === "done" &&
    count(v.saved) &&
    (v.problem === null || typeof v.problem === "string")
  ) {
    return {
      kind: "done",
      saved: v.saved as number,
      problem: v.problem === null ? null : (v.problem as string).slice(0, 300),
    };
  }
  return { kind: "done", saved: 0, problem: "The message could not be saved as a file." };
}

/** The progress main pushes, checked; null when it is not one. */
export function readEmlProgress(v: unknown): EmlProgress | null {
  if (!isRecord(v)) return null;
  const { index, count: total, bytes, totalBytes } = v;
  return count(index, 1000) && count(total, 1000) && count(bytes) && count(totalBytes)
    ? {
        index: index as number,
        count: total as number,
        bytes: bytes as number,
        totalBytes: totalBytes as number,
      }
    : null;
}
