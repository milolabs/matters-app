// The files of an open composer as chips (ADR 0041, rules 1, 20 and 23). Pure helpers: the session
// in compose.ts holds the signal and the requests.
import type { AttachmentInfo, PickedFile } from "@matters/contracts";
import type { AttachmentState, DraftAttachment, StoredAttachment } from "@matters/core";
import { chipLabel, drawsRing } from "./receivedStrip.ts";

export interface Chip {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly state: AttachmentState;
  readonly reason: string | null;
  /**
   * The backend has the row. A chip starts without one (it appears in the frame of the drop, before
   * the draft exists), and only a chip with a row is listed in the saved draft.
   */
  readonly added: boolean;
  /** The original was edited after it was copied. */
  readonly changed: boolean;
  /** A part of a received message put here by a forward (ADR 0045); its bytes are downloaded first. */
  readonly forwarded: boolean;
  /** Try again can help. False for a forwarded file whose message left the server. */
  readonly canRetry: boolean;
}

/** A chip made from what the page already knows: no row yet, so it is read as `reading`. */
export function provisionalChip(id: string, name: string, size: number, forwarded = false): Chip {
  return {
    id,
    name,
    size,
    state: "reading",
    reason: null,
    added: false,
    changed: false,
    forwarded,
    canRetry: true,
  };
}

export function chipFromInfo(info: AttachmentInfo, changed = false): Chip {
  return {
    id: info.id,
    name: info.name,
    size: info.size,
    state: info.state,
    reason: info.reason,
    added: true,
    changed,
    forwarded: info.forwarded,
    canRetry: info.canRetry,
  };
}

/**
 * The backend's word for a file, applied to its chip. A trailing `reading` never undoes an
 * outcome that is already known, and a file that was ready stays "changed" until it is replaced.
 */
export function applyInfo(chip: Chip, info: AttachmentInfo): Chip {
  const settled = chip.state !== "reading" && info.state === "reading";
  return {
    ...chip,
    name: info.name,
    size: info.size,
    state: settled ? chip.state : info.state,
    reason: settled ? chip.reason : info.reason,
    added: true,
    changed: info.state === "ready" ? chip.changed : false,
    forwarded: info.forwarded,
    canRetry: info.canRetry,
  };
}

export function listedAttachments(chips: readonly Chip[]): DraftAttachment[] {
  return chips
    .filter((c) => c.added)
    .map((c) => ({ id: c.id, name: c.name, size: c.size, delivery: { kind: "inline" as const } }));
}

/**
 * The rows `sendBlockers` and `notifyIfLarge` read, made from chips. Only the fields they look at
 * are real (id, name, size, state, reason); the rest says "not known to the page".
 */
export function storedLike(
  chips: readonly Chip[],
  accountId: string,
  draftId: string,
): StoredAttachment[] {
  return chips.map((c) => ({
    id: c.id,
    draftId,
    accountId,
    name: c.name,
    size: c.size,
    state: c.state,
    reason: c.reason,
    sha256: null,
    sourcePath: null,
    sourceMtimeMs: null,
    origin: null,
    createdAtMs: 0,
  }));
}

/** "pdf" for "report.final.PDF"; "FILE" is what a name with no extension is called. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1, dot + 5).toUpperCase();
}

/** The same name and size is the same file for the purpose of "already attached". */
export function isDuplicate(chips: readonly Chip[], name: string, size: number): boolean {
  return chips.some((c) => c.name === name && c.size === size);
}

/** What the status line says for a file that cannot be attached; null for one that can. */
export function refusalText(file: PickedFile): string | null {
  switch (file.kind) {
    case "file":
      return null;
    case "directory":
      return "Folders can't be attached. Zip it first.";
    case "missing":
      return `${file.name || "That file"} could not be found.`;
    case "tooLarge":
      return "That image is over 50 MB. Save it and attach the file.";
  }
}

export function duplicateText(name: string): string {
  return `${name} is already attached.`;
}

/**
 * Words for the chip's second part, or null where the size goes. A file being read has its own
 * words, which progress rewrites directly (progress.ts), so they are not here.
 */
export function chipNote(chip: Chip): { text: string; tone: "plain" | "late" } | null {
  if (chip.state === "failed") {
    // A message that left the server is quiet, as on the received strip: nothing will change it.
    return { text: chip.reason ?? "Can't read this file", tone: chip.canRetry ? "late" : "plain" };
  }
  if (chip.state === "tooLarge") {
    return { text: chip.reason ?? "Larger than your server takes", tone: "late" };
  }
  if (chip.state === "ready" && chip.changed) {
    return { text: "Changed since you attached it", tone: "plain" };
  }
  if (chip.state === "ready" && chip.size === 0) return { text: "Empty, 0 bytes", tone: "plain" };
  return null;
}

/** What a screen reader hears when a chip's state changes: the state, never the percentage. */
export function announceChange(before: Chip | undefined, after: Chip): string | null {
  if (!before || before.state === after.state) return null;
  if (after.state === "ready") return `${after.name} is attached.`;
  if (after.state === "failed") return `${after.name}: ${after.reason ?? "Can't read this file"}`;
  if (after.state === "tooLarge") return `${after.name} is too large for your server.`;
  return null;
}

/**
 * Whether the chip draws a ring while it is copied. A forwarded file is downloaded first, and
 * under 1 MiB that would only flash (ADR 0045, rule 10; ADR 0043, rule 17).
 */
export function drawsReadingRing(chip: Chip): boolean {
  return chip.state === "reading" && chip.added && (!chip.forwarded || drawsRing(chip.size));
}

/** What a chip says before its first progress report: a forwarded file is being downloaded. */
export function readingText(chip: Chip): string {
  return chip.forwarded ? chipLabel("downloading", chip.size).text : "Reading 0%";
}
