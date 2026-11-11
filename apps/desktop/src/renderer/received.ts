// The state of the received files of one message in this window (ADR 0043, rules 6, 16, 17), and
// the asks to main. Where a file stands is a signal, because it changes a line and a tag. The
// bytes are not: progress sets one CSS variable on one ring and rewrites one label directly
// (progress.ts), so a download never renders the strip again.
import type { BackendEvent, ReceivedAnswer, ReceivedItem } from "@matters/contracts";
import type { ReceivedAttachment } from "@matters/core";
import { createSignal } from "solid-js";
import type { ProgressSink } from "./progress.ts";
import {
  announcement,
  drawsRing,
  type Phase,
  progressText,
  ringFraction,
  saveAllNote,
  settle,
} from "./receivedStrip.ts";

/** What the page may say to main about a file: a message key and a part id, and nothing else. */
export interface ReceivedAsk {
  readonly action: "open" | "preview" | "save" | "saveAll";
  readonly messageKey?: number;
  readonly partId?: string;
  /** For Save: the name main offers in the dialog. A hint; main cleans it. */
  readonly name?: string;
  readonly items?: readonly ReceivedItem[];
}

export interface ReceivedDeps {
  ask(request: ReceivedAsk): Promise<ReceivedAnswer>;
  sink: ProgressSink;
  /** The sink key of one part's ring and label. */
  keyOf(messageKey: number, partId: string): string;
  onEvent(listener: (event: BackendEvent) => void): () => void;
  reducedMotion(): boolean;
}

export interface FileState {
  readonly phase: Phase;
  /** Downloaded in this window; the second press does not wait. */
  readonly here: boolean;
}

export interface Note {
  readonly text: string;
  readonly tone: "plain" | "late";
}

const idle: FileState = { phase: "idle", here: false };
/** A download shorter than this never shows as one. */
const SHOW_DOWNLOAD_AFTER_MS = 150;

export type ReceivedController = ReturnType<typeof createReceivedController>;

/**
 * One per message strip. `files` is what the strip lists now: the controller needs a part's name
 * and size for words, and reads them when it is asked, so a refreshed list is never stale here.
 */
export function createReceivedController(
  messageKey: number,
  files: () => readonly ReceivedAttachment[],
  deps: ReceivedDeps,
) {
  const [states, setStates] = createSignal<ReadonlyMap<string, FileState>>(new Map());
  const [note, setNote] = createSignal<Note | null>(null);
  const [spoken, setSpoken] = createSignal("");

  const find = (partId: string) => files().find((f) => f.partId === partId);
  const stateOf = (partId: string): FileState => states().get(partId) ?? idle;

  function put(partId: string, next: FileState) {
    const before = stateOf(partId);
    setStates((m) => new Map(m).set(partId, next));
    const name = find(partId)?.name ?? "The file";
    const words = announcement(name, before.phase, next.phase);
    if (words) setSpoken(words);
  }

  /** Parts with an ask in flight, so a second press joins nothing and starts nothing. */
  const busy = new Set<string>();

  /**
   * Runs one ask for one part. The chip shows the download only if it lasts: a copy that is
   * already in the cache answers at once, and a ring that appeared for a blink would be a flash.
   */
  async function run(partId: string, ask: ReceivedAsk): Promise<void> {
    const file = find(partId);
    if (!file || busy.has(partId) || stateOf(partId).phase === "gone") return;
    busy.add(partId);
    setNote(null);
    const here = stateOf(partId).here;
    const showing = here
      ? undefined
      : setTimeout(
          () => put(partId, { phase: "downloading", here: false }),
          SHOW_DOWNLOAD_AFTER_MS,
        );
    let answer: ReceivedAnswer;
    try {
      answer = await deps.ask(ask);
    } catch {
      answer = { kind: "failed" };
    }
    if (showing !== undefined) clearTimeout(showing);
    busy.delete(partId);
    deps.sink.forget(deps.keyOf(messageKey, partId));
    const done = settle(answer, file.name);
    put(partId, { phase: done.phase, here: done.here || (here && done.phase === "idle") });
    setNote(done.note);
  }

  const request = (partId: string, action: ReceivedAsk["action"], name?: string): ReceivedAsk => ({
    action,
    messageKey,
    partId,
    ...(name === undefined ? {} : { name }),
  });

  // A download started in another window of the app, or before this strip was drawn, still shows.
  const off = deps.onEvent((event) => {
    if (event.type !== "receivedProgress" || event.messageKey !== messageKey) return;
    if (stateOf(event.partId).phase === "idle" && find(event.partId)) {
      put(event.partId, { phase: "downloading", here: false });
    }
    const key = deps.keyOf(messageKey, event.partId);
    deps.sink.report(
      key,
      ringFraction(event.bytes, event.totalBytes, deps.reducedMotion()),
      progressText(event.bytes, event.totalBytes),
    );
  });

  return {
    messageKey,
    stateOf,
    note,
    /** The words for the strip's one live region: state changes, never a percentage. */
    spoken,
    /** Says something about a file without asking main anything (a runnable file is not downloaded to be refused). */
    explain(text: string): void {
      setNote({ text, tone: "plain" });
      setSpoken(text);
    },
    /** A press: open it (rule 16). */
    open: (partId: string) => run(partId, request(partId, "open")),
    /** `Space`: Quick Look. */
    preview: (partId: string) => run(partId, request(partId, "preview")),
    /** `⌘S` or the button: the save dialog. */
    save: (partId: string) => run(partId, request(partId, "save", find(partId)?.name ?? "")),
    async saveAll(parts: readonly string[]): Promise<void> {
      setNote(null);
      let answer: ReceivedAnswer;
      try {
        answer = await deps.ask({
          action: "saveAll",
          items: parts.map((partId) => ({ messageKey, partId })),
        });
      } catch {
        answer = { kind: "failed" };
      }
      setNote(saveAllNote(answer));
    },
    /** Whether a ring is drawn for this part while it downloads (rule 17). */
    ringed: (partId: string) => {
      const f = find(partId);
      return f !== undefined && drawsRing(f.size);
    },
    dispose: off,
  };
}
