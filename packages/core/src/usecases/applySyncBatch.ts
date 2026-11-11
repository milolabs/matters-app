import type {
  CursorPort,
  FlagOutboxPort,
  FlagUpdate,
  LocationEntry,
  MoveOutboxPort,
  ReceivedFilesPort,
  SyncBatch,
  UpsertResult,
} from "../ports/index.ts";
import { type IngestDeps, writeDocuments } from "./ingestDocuments.ts";
import { reapplyPendingMoves } from "./move.ts";
import { provisionalSentId } from "./recordSent.ts";
import { reapplyPendingSeen } from "./seen.ts";

export interface ApplySyncBatchDeps extends IngestDeps {
  readonly cursors: CursorPort;
  /** Requests the server may not have yet; a batch must not undo them (ADR 0039). */
  readonly flagOps: Pick<FlagOutboxPort, "listPending">;
  /** Moves the server may not have yet; a batch must not undo them either (ADR 0044, rule 12). */
  readonly moveOps: Pick<MoveOutboxPort, "listPending">;
  /**
   * With it, the downloaded copies of a message go when the message does (ADR 0043, rule 8).
   * They are removed after the unit commits: no file work happens inside a transaction.
   */
  readonly received?: Pick<ReceivedFilesPort, "removeMessages">;
}

/**
 * Where a message's labels come from (ADR 0016): `locations` derives them from the folders it
 * is in, `provider` keeps what the document says (Gmail).
 */
export type LabelSource = "provider" | "locations";

export interface ApplySyncBatchInput {
  readonly accountId: string;
  readonly folderId: string;
  readonly batch: SyncBatch;
  /** Default `locations`. */
  readonly labelSource?: LabelSource;
}

export interface ApplySyncBatchResult {
  readonly upserted: UpsertResult;
  /** Keys deleted because their last location is gone. */
  readonly removedKeys: readonly number[];
  /** Locations of messages the store already had (moves and copies). */
  readonly locationsAdded: number;
  readonly flagsUpdated: number;
  /** Messages whose unpushed read state was put back over what the batch wrote. */
  readonly seenRestored: number;
  /** Messages whose unpushed move was put back over what the batch wrote. */
  readonly movesRestored: number;
  readonly locationsRemoved: number;
}

/** A `KnownLocation` named a provider id the store no longer has: the adapter's answer was stale. */
export class UnknownProviderIdError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Provider id ${providerId} was reported as known but the store does not have it`);
    this.name = "UnknownProviderIdError";
    this.providerId = providerId;
  }
}

/**
 * A message we sent without a Sent copy of our own (Gmail keeps its own) is stored under a
 * provisional id. When the provider's copy arrives it replaces ours: same `Message-ID`.
 */
async function dropProvisionalSent(
  deps: ApplySyncBatchDeps,
  accountId: string,
  batch: SyncBatch,
  known: ReadonlyMap<string, number>,
): Promise<void> {
  const ids = new Set<string>();
  for (const { document } of batch.documents) {
    const m = document.message;
    if (m.messageIdHeader !== "" && !known.has(m.providerId)) {
      ids.add(provisionalSentId(m.messageIdHeader));
    }
  }
  if (ids.size === 0) return;
  const found = await deps.store.findByProviderIds(accountId, [...ids]);
  if (found.size === 0) return;
  const keys = await deps.store.removeByProviderIds(accountId, [...found.keys()]);
  await deps.index.removeMessages(keys);
  await deps.bodies.removeBodies(keys);
}

/**
 * Applies one provider batch in a single unit of work (ADR 0007, rule 2): documents, locations,
 * flags, removals and the new cursor commit together. A failure at any step leaves the store,
 * index, bodies and the old cursor untouched, so the next sync resumes from the old cursor.
 * Re-applying the same batch is idempotent.
 *
 * Order: documents and locations first, removals last, so a message that moves inside one batch
 * keeps its key (ADR 0016).
 */
export async function applySyncBatch(
  deps: ApplySyncBatchDeps,
  input: ApplySyncBatchInput,
): Promise<ApplySyncBatchResult> {
  const result = await applyInUnit(deps, input);
  // A copy with no message is only a file nobody can reach, and the start-up sweep takes it too.
  if (deps.received && result.removedKeys.length > 0) {
    await deps.received.removeMessages(result.removedKeys).catch(() => {});
  }
  return result;
}

function applyInUnit(
  deps: ApplySyncBatchDeps,
  { accountId, folderId, batch, labelSource = "locations" }: ApplySyncBatchInput,
): Promise<ApplySyncBatchResult> {
  return deps.uow.run(async () => {
    const { store } = deps;
    const touched = new Set<number>();
    const entries: LocationEntry[] = [];
    const flagUpdates: FlagUpdate[] = [];

    // New messages get fresh chronological keys; a known identity keeps its own (the store decides).
    const known = await store.findByProviderIds(
      accountId,
      batch.documents.map((d) => d.document.message.providerId),
    );
    await dropProvisionalSent(deps, accountId, batch, known);
    const fresh = new Map<string, number>();
    for (const { document } of batch.documents) {
      const m = document.message;
      if (!known.has(m.providerId) && !fresh.has(m.providerId)) fresh.set(m.providerId, m.dateMs);
    }
    const freshKeys = await store.allocateKeys([...fresh.values()]);
    const keyOf = new Map([...fresh.keys()].map((id, i) => [id, freshKeys[i] as number]));
    const documents = batch.documents.map((d) => {
      const key = keyOf.get(d.document.message.providerId);
      return key === undefined
        ? d.document
        : { ...d.document, message: { ...d.document.message, key } };
    });

    const upserted = await writeDocuments(deps, documents);
    batch.documents.forEach((d, i) => {
      const key = upserted.keys[i] as number;
      touched.add(key);
      entries.push({ key, location: d.location });
    });

    if (batch.knownLocations.length > 0) {
      const found = await store.findByProviderIds(
        accountId,
        batch.knownLocations.map((k) => k.providerId),
      );
      for (const k of batch.knownLocations) {
        const key = found.get(k.providerId);
        if (key === undefined) throw new UnknownProviderIdError(k.providerId);
        touched.add(key);
        entries.push({ key, location: k.location });
        flagUpdates.push(
          k.labelIds === undefined
            ? { location: k.location, flags: k.flags }
            : { location: k.location, flags: k.flags, labelIds: k.labelIds },
        );
      }
    }
    await store.addLocations(entries);

    // What the server told about messages stored before the field existed (ADR 0042, rule 7).
    // Inside the unit, so the answers and the cursor commit together.
    if (batch.replyTos && batch.replyTos.length > 0) await store.setReplyTo(batch.replyTos);
    // Whether stored mail is from a program, read from its headers (ADR 0066, rule 6).
    if (batch.automatedAnswers && batch.automatedAnswers.length > 0) {
      await store.setAutomated(batch.automatedAnswers);
    }
    // The files of new messages and of old ones that did not know theirs (ADR 0043, rule 2).
    // After the locations, since an answer finds its message through the place it was read.
    if (batch.attachmentAnswers && batch.attachmentAnswers.length > 0) {
      await store.setAttachments(batch.attachmentAnswers);
    }

    flagUpdates.push(...batch.flagUpdates);
    const flagged = flagUpdates.length > 0 ? await store.updateFlags(flagUpdates) : [];

    const deleted = new Set<number>();
    const surviving = new Set<number>();
    const collect = (r: { deletedKeys: readonly number[]; survivingKeys: readonly number[] }) => {
      for (const k of r.deletedKeys) deleted.add(k);
      for (const k of r.survivingKeys) surviving.add(k);
    };
    if (batch.resetFolder) {
      const keep = [
        ...batch.documents.map((d) => d.location),
        ...batch.knownLocations.map((k) => k.location),
      ].find((l) => l.folderId === folderId)?.uidValidity;
      collect(await store.removeFolderLocations(accountId, folderId, keep));
    }
    if (batch.removedLocations.length > 0) {
      collect(await store.removeLocations(batch.removedLocations));
    }
    const removedKeys = [...deleted];
    if (removedKeys.length > 0) {
      await deps.index.removeMessages(removedKeys);
      await deps.bodies.removeBodies(removedKeys);
    }

    if (labelSource === "locations") {
      const keys = new Set([...touched, ...surviving]);
      for (const k of deleted) keys.delete(k);
      if (keys.size > 0) await store.deriveLabelsFromLocations([...keys]);
    }

    // Last, over every path that wrote flags above: documents, known locations and flag updates.
    const restored = await reapplyPendingSeen(deps, accountId);
    const movesRestored = await reapplyPendingMoves(deps, accountId);
    await deps.cursors.set(accountId, folderId, batch.cursor);
    return {
      upserted,
      removedKeys,
      locationsAdded: batch.knownLocations.length,
      flagsUpdated: flagged.length,
      seenRestored: restored.length,
      movesRestored: movesRestored.length,
      locationsRemoved: batch.removedLocations.length,
    };
  });
}
