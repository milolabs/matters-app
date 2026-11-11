import type { DraftContent } from "../domain/draft.ts";
import type { Message, MessageLocation } from "../domain/entities.ts";
import { localThreadRoot, threadParents } from "../domain/threading.ts";
import { type IngestDeps, writeDocuments } from "./ingestDocuments.ts";

/** Provider id of a sent message that no server copy has been matched to yet (Gmail, or no APPEND). */
export function provisionalSentId(messageId: string): string {
  return `sent:${messageId}`;
}

export interface RecordSentInput {
  readonly content: DraftContent;
  readonly messageId: string;
  readonly dateMs: number;
  readonly text: string;
  /** The message carried files; the thread shows a paperclip. */
  readonly hasAttachments?: boolean;
  /** The copy appended to the Sent folder; absent when the provider keeps its own. */
  readonly copy?: { readonly providerId: string; readonly location: MessageLocation };
}

/**
 * Stores a message we just sent in its thread, so it shows up before the next sync (ADR 0020,
 * rule 10). With a Sent copy the message has the provider id sync will compute, so the sync
 * finds it known and only adds its location; without one it gets a provisional id that the
 * sync replaces when the provider's own copy arrives (`applySyncBatch`). Returns the key.
 */
export async function recordSentMessage(deps: IngestDeps, input: RecordSentInput): Promise<number> {
  const { content, messageId, copy } = input;
  return deps.uow.run(async () => {
    const [key] = await deps.store.allocateKeys([input.dateMs]);
    if (key === undefined) throw new Error("no key for the sent message");
    const threadId =
      content.threadId ??
      `lt:${content.accountId}:${localThreadRoot({ messageId, inReplyTo: content.inReplyTo, references: content.references })}`;
    const message: Message = {
      key,
      accountId: content.accountId,
      providerId: copy?.providerId ?? provisionalSentId(messageId),
      threadId,
      messageIdHeader: messageId,
      parentIds: threadParents({
        messageId,
        inReplyTo: content.inReplyTo,
        references: content.references,
      }),
      dateMs: input.dateMs,
      from: content.from,
      to: content.to,
      cc: content.cc,
      subject: content.subject,
      snippet: input.text.replace(/\s+/g, " ").trim().slice(0, 140),
      flags: { seen: true, flagged: false, answered: false, draft: false },
      labelIds: copy ? [copy.location.folderId] : ["sent"],
      hasAttachments: input.hasAttachments ?? false,
      senderAuth: "unknown",
      // We wrote it, and we set no Reply-To: nothing for the server to tell us later.
      replyTo: [],
    };
    const upserted = await writeDocuments(deps, [{ message, bodyText: input.text }]);
    const effective = upserted.keys[0] as number;
    if (copy) {
      await deps.store.addLocations([{ key: effective, location: copy.location }]);
      await deps.store.deriveLabelsFromLocations([effective]);
    }
    return effective;
  });
}
