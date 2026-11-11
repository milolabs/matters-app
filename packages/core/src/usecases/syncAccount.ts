import type { Account, Label } from "../domain/entities.ts";
import type { FolderSyncContext, MailSyncPort, SyncBatch } from "../ports/index.ts";
import {
  type ApplySyncBatchDeps,
  type ApplySyncBatchResult,
  applySyncBatch,
} from "./applySyncBatch.ts";
import { reapplyPendingMoves } from "./move.ts";

export interface SyncAccountDeps extends ApplySyncBatchDeps {
  readonly sync: MailSyncPort;
}

export interface SyncProgress {
  readonly folder: Label;
  /** Messages of this folder handled so far in this run. */
  readonly done: number;
  /** Known only while the provider can tell how much is left. */
  readonly total?: number;
}

export interface SyncAccountOptions {
  /** Narrows the run to some of the provider's folders (default: all). */
  readonly folders?: (all: readonly Label[]) => readonly Label[];
  /** Checked between batches; once set, the run stops with `SyncAbortedError`. */
  readonly signal?: { readonly aborted: boolean };
  /** After each batch was committed and before the next one is fetched. */
  readonly onBatchApplied?: (folder: Label, applied: ApplySyncBatchResult) => void;
  readonly onProgress?: (progress: SyncProgress) => void;
}

export class SyncAbortedError extends Error {
  constructor() {
    super("Sync was cancelled");
    this.name = "SyncAbortedError";
  }
}

export interface FolderSyncResult {
  readonly folderId: string;
  readonly folderName: string;
  readonly batches: number;
  /** Messages stored for the first time (or refreshed) from downloaded documents. */
  readonly documents: number;
  /** Moves and copies of messages already stored: no download. */
  readonly knownLocations: number;
  readonly flagsUpdated: number;
  readonly locationsRemoved: number;
  /** Messages deleted because their last location went. */
  readonly messagesDeleted: number;
  readonly reset: boolean;
}

export interface SyncAccountResult {
  readonly folders: readonly FolderSyncResult[];
}

type Counters = {
  -readonly [K in keyof FolderSyncResult]: FolderSyncResult[K];
};

/**
 * Syncs every folder of an account: list folders, then per folder load the cursor, iterate the
 * provider's batches and apply each one atomically.
 *
 * Batches with removals wait until every folder had its additions. A move shows up as a removal
 * in one folder and an addition in another; applying the removal first would delete the message
 * and force a second download (ADR 0016). The cursor of such a batch is written only when it is
 * applied, so a crash in between repeats the removal detection.
 */
export async function syncAccount(
  deps: SyncAccountDeps,
  account: Account,
  options: SyncAccountOptions = {},
): Promise<SyncAccountResult> {
  const { sync, store, cursors } = deps;
  const labelSource = sync.capabilities.has("labels") ? "provider" : "locations";
  const listed = await sync.listFolders(account);
  // What each folder is (ADR 0044, rule 1). The mailboxes of mail follow, so the moves that are
  // still pending go back over them in the same unit.
  await deps.uow.run(async () => {
    await store.setFolders(account.id, listed);
    await reapplyPendingMoves(deps, account.id);
  });
  const folders = options.folders ? options.folders(listed) : listed;
  const checkAborted = () => {
    if (options.signal?.aborted) throw new SyncAbortedError();
  };
  const results = new Map<string, Counters>();
  const deferred: { folder: Label; batch: SyncBatch }[] = [];

  const apply = async (folder: Label, batch: SyncBatch) => {
    checkAborted();
    const applied = await applySyncBatch(deps, {
      accountId: account.id,
      folderId: folder.id,
      batch,
      labelSource,
    });
    record(results.get(folder.id), batch, applied);
    options.onBatchApplied?.(folder, applied);
  };

  for (const folder of folders) {
    results.set(folder.id, {
      folderId: folder.id,
      folderName: folder.name,
      batches: 0,
      documents: 0,
      knownLocations: 0,
      flagsUpdated: 0,
      locationsRemoved: 0,
      messagesDeleted: 0,
      reset: false,
    });
    const context: FolderSyncContext = {
      async knownProviderIds(ids) {
        return new Set((await store.findByProviderIds(account.id, ids)).keys());
      },
      storedUids: (uidValidity) => store.listLocationUids(account.id, folder.id, uidValidity),
      unknownReplyToUids: (uidValidity, limit) =>
        store.listUnknownReplyToUids(account.id, folder.id, uidValidity, limit),
      unknownAutomatedUids: (uidValidity, limit) =>
        store.listUnknownAutomatedUids(account.id, folder.id, uidValidity, limit),
      unknownAttachmentUids: (uidValidity, limit) =>
        store.listUnknownAttachmentUids(account.id, folder.id, uidValidity, limit),
    };
    const cursor = await cursors.get(account.id, folder.id);
    let done = 0;
    for await (const batch of sync.syncFolder(account, folder, cursor, context)) {
      checkAborted();
      if (batch.removedLocations.length > 0) deferred.push({ folder, batch });
      else await apply(folder, batch);
      done += batch.documents.length + batch.knownLocations.length;
      options.onProgress?.({
        folder,
        done,
        ...(batch.pending === undefined ? {} : { total: done + batch.pending }),
      });
    }
  }
  for (const { folder, batch } of deferred) await apply(folder, batch);

  return { folders: folders.map((f) => results.get(f.id) as FolderSyncResult) };
}

function record(into: Counters | undefined, batch: SyncBatch, applied: ApplySyncBatchResult) {
  if (!into) return;
  into.batches += 1;
  into.documents += batch.documents.length;
  into.knownLocations += applied.locationsAdded;
  into.flagsUpdated += applied.flagsUpdated;
  into.locationsRemoved += applied.locationsRemoved;
  into.messagesDeleted += applied.removedKeys.length;
  if (batch.resetFolder) into.reset = true;
}
