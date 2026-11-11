import {
  bytesMatchType,
  type ExtractedText,
  type FileTextAnswer,
  MAX_FILE_READ_BYTES,
  MAX_WHOLE_BYTES,
  readableKind,
  wholeMediaType,
} from "../domain/fileText.ts";
import type {
  AgentFile,
  FileTextExtractorPort,
  FileTextPort,
  MessageStorePort,
} from "../ports/index.ts";
import type { FetchOutcome } from "./receivedDownloads.ts";

/**
 * Reading one attached file for the agent (ADR 0087, rules 2 to 6). A text kept from an earlier
 * read answers at once. Otherwise the type and size are checked from the row, before anything is
 * downloaded; the part comes through the cache of ADR 0043, the file work thread extracts its
 * text, and the text is kept. A failure is not kept: it is not retried within the same question,
 * which the tool server sees to, and a later question may succeed.
 */
export interface ReadFileDeps {
  readonly store: Pick<MessageStorePort, "getAttachment">;
  readonly texts: FileTextPort;
  /** The same download a chip press makes, through the same cache and limit (rule 2). */
  fetch(messageKey: number, partId: string): Promise<FetchOutcome>;
  /** Where the cached copy is; it goes to the file work thread and nowhere else. */
  locate(messageKey: number, partId: string): Promise<string | null>;
  readonly extractor: FileTextExtractorPort | undefined;
  /**
   * The bytes of the cached copy, for a file sent whole (ADR 0090, rule 8); `null` when the copy
   * is gone or larger than `max`. Absent: no file is sent whole.
   */
  readBytes?(path: string, max: number): Promise<Uint8Array | null>;
  now(): number;
}

/** A file to send whole, or why it cannot go. */
export type WholeFileAnswer =
  | { readonly kind: "ok"; readonly file: AgentFile }
  | { readonly kind: "not"; readonly reason: string };

const answer = (
  state: FileTextAnswer["state"],
  reason: string,
  text = "",
  pages: number | null = null,
): FileTextAnswer => ({ state, text, pages, reason });

const WHY_NOT_FETCHED: Record<Exclude<FetchOutcome["kind"], "done">, string> = {
  cancelled: "The download was stopped.",
  gone: "The file is no longer on the server.",
  offline: "The mail server could not be reached.",
  failed: "The file could not be downloaded.",
};

export function createFileReader(deps: ReadFileDeps) {
  /** Asks for the same part at the same time join one run. */
  const running = new Map<string, Promise<FileTextAnswer>>();

  const run = async (messageKey: number, partId: string): Promise<FileTextAnswer> => {
    const kept = await deps.texts.get(messageKey, partId);
    if (kept !== null) {
      return kept.state === "ok"
        ? answer("ok", "", kept.text, kept.pages)
        : answer("no_text", "This file has no text; it is probably a scan.", "", kept.pages);
    }
    const attachment = await deps.store.getAttachment(messageKey, partId);
    if (attachment === null) return answer("failed", "The file is not in this message.");
    const kind = readableKind(attachment.mimeType, attachment.name);
    if (kind === null) return answer("unsupported", "The text of this kind of file is not read.");
    if (attachment.size > MAX_FILE_READ_BYTES) {
      return answer("too_big", "The file is over 10 MB, so it is not downloaded for reading.");
    }
    if (deps.extractor === undefined) return answer("failed", "Reading files is not available.");
    const fetched = await deps.fetch(messageKey, partId);
    if (fetched.kind !== "done") return answer("failed", WHY_NOT_FETCHED[fetched.kind]);
    const path = await deps.locate(messageKey, partId);
    if (path === null) return answer("failed", "The downloaded copy is gone.");
    let extracted: ExtractedText;
    try {
      extracted = await deps.extractor.extractText({ sourcePath: path, kind });
    } catch {
      return answer("failed", "The file could not be read.");
    }
    if (extracted.state === "ok" || extracted.state === "no_text") {
      await deps.texts.put(messageKey, partId, {
        text: extracted.text,
        pages: extracted.pages,
        state: extracted.state,
        extractedMs: deps.now(),
      });
      return extracted.state === "ok"
        ? answer("ok", "", extracted.text, extracted.pages)
        : answer("no_text", "This file has no text; it is probably a scan.", "", extracted.pages);
    }
    return answer(extracted.state, extracted.reason, "", extracted.pages);
  };

  /**
   * The bytes of a file with no text, to go whole to the answer (ADR 0090, rules 2 and 8): through
   * the same cache and download as a read, so a file the loop read costs no second download.
   */
  const whole = async (messageKey: number, partId: string): Promise<WholeFileAnswer> => {
    const not = (reason: string): WholeFileAnswer => ({ kind: "not", reason });
    if (deps.readBytes === undefined) return not("Sending files is not available.");
    const attachment = await deps.store.getAttachment(messageKey, partId);
    if (attachment === null) return not("The file is not in this message.");
    const mediaType = wholeMediaType(attachment.mimeType, attachment.name);
    if (mediaType === null) return not("This kind of file is not sent.");
    if (attachment.size > MAX_WHOLE_BYTES) return not("The file is over 10 MB.");
    const fetched = await deps.fetch(messageKey, partId);
    if (fetched.kind !== "done") return not(WHY_NOT_FETCHED[fetched.kind]);
    const path = await deps.locate(messageKey, partId);
    if (path === null) return not("The downloaded copy is gone.");
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.readBytes(path, MAX_WHOLE_BYTES);
    } catch {
      bytes = null;
    }
    if (bytes === null) return not("The downloaded copy could not be read.");
    if (!bytesMatchType(bytes, mediaType)) return not("The file is not what its type says.");
    return { kind: "ok", file: { name: attachment.name, mediaType, bytes } };
  };

  return {
    whole(messageKey: number, partId: string): Promise<WholeFileAnswer> {
      return whole(messageKey, partId).catch(
        (): WholeFileAnswer => ({ kind: "not", reason: "The file could not be read." }),
      );
    },
    read(messageKey: number, partId: string): Promise<FileTextAnswer> {
      const id = `${messageKey}/${partId}`;
      const joined = running.get(id);
      if (joined !== undefined) return joined;
      const started = run(messageKey, partId)
        .catch((): FileTextAnswer => answer("failed", "The file could not be read."))
        .finally(() => running.delete(id));
      running.set(id, started);
      return started;
    },
  };
}
