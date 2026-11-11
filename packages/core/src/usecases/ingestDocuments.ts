import type { MessageDocument } from "../domain/entities.ts";
import type {
  MessageBodyPort,
  MessageStorePort,
  SearchIndexPort,
  UnitOfWorkPort,
  UpsertResult,
} from "../ports/index.ts";

export interface IngestDeps {
  readonly store: MessageStorePort;
  readonly index: SearchIndexPort;
  readonly bodies: MessageBodyPort;
  readonly uow: UnitOfWorkPort;
}

/**
 * Store, index and bodies for a batch of documents. The store decides each message's
 * effective key (a known identity keeps its old one), so the index and the body store are fed
 * with those keys, never the input ones. Call inside a unit of work.
 */
export async function writeDocuments(
  deps: Omit<IngestDeps, "uow">,
  documents: readonly MessageDocument[],
): Promise<UpsertResult> {
  const result = await deps.store.upsertMessages(documents.map((d) => d.message));
  if (documents.length === 0) return result;

  const effective = documents.map((d, i) => {
    const key = result.keys[i];
    if (key === undefined) throw new Error("store returned fewer keys than messages");
    return { ...d, message: { ...d.message, key } };
  });
  await deps.index.indexMessages(effective);
  await deps.bodies.putBodies(
    effective.map((d) => ({
      key: d.message.key,
      threadId: d.message.threadId,
      sender: d.message.from.address,
      text: d.bodyText,
      ...(d.bodyHtml === undefined ? {} : { html: d.bodyHtml }),
      ...(d.htmlKind === undefined ? {} : { htmlKind: d.htmlKind }),
    })),
  );
  return result;
}

/**
 * Write path for mail that has no provider cursor, e.g. the dev seed: one unit of work, so a
 * crash never leaves a message in the store but not in the index or the body store.
 */
export function ingestDocuments(
  deps: IngestDeps,
  documents: readonly MessageDocument[],
): Promise<UpsertResult> {
  return deps.uow.run(() => writeDocuments(deps, documents));
}
