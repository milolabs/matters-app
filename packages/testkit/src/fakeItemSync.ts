import type {
  Account,
  FolderSyncContext,
  Label,
  MailSyncPort,
  MessageDocument,
  MessageLocation,
  ProviderCapability,
  SyncBatch,
  SyncCursor,
} from "@matters/core";
import { makeDocument } from "./fixtures.ts";

type Change =
  | { readonly kind: "added"; readonly itemId: string }
  | { readonly kind: "removed"; readonly itemId: string };

/**
 * A mailbox whose handle on a copy is the provider's own id, not a UID (ADR 0136, rule 6), behind
 * `MailSyncPort`: what a Graph adapter does, without HTTP. Each message has one immutable id that
 * stays the same when it moves between folders, and that id is its provider id. Each folder keeps
 * a log of what was added to it and what was removed (`@removed`); the cursor is how far the log
 * was read, as a delta link would be. It numbers ids through `FolderSyncContext.itemUids` and
 * records every message it "downloads", so tests can assert that a move costs nothing.
 */
export class FakeItemSync implements MailSyncPort {
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set(["savesSent"]);
  readonly downloads: string[] = [];
  private readonly logs = new Map<string, Change[]>();
  private readonly documents = new Map<string, MessageDocument>();

  constructor(folderIds: readonly string[]) {
    for (const id of folderIds) this.logs.set(id, []);
  }

  private log(folderId: string): Change[] {
    const log = this.logs.get(folderId);
    if (!log) throw new Error(`no folder ${folderId}`);
    return log;
  }

  /** A new message in a folder, with its immutable id. */
  add(folderId: string, itemId: string, subject = itemId): void {
    this.documents.set(itemId, makeDocument({ providerId: itemId, subject }, `body of ${itemId}`));
    this.log(folderId).push({ kind: "added", itemId });
  }

  /** The same id leaves one folder and shows up in another (immutable ids). */
  move(itemId: string, from: string, to: string): void {
    this.log(from).push({ kind: "removed", itemId });
    this.log(to).push({ kind: "added", itemId });
  }

  /** Gone from the folder, as delta query's `@removed` says. */
  remove(folderId: string, itemId: string): void {
    this.log(folderId).push({ kind: "removed", itemId });
  }

  async listFolders(account: Account): Promise<readonly Label[]> {
    return [...this.logs.keys()].map((id) => ({
      id,
      accountId: account.id,
      name: id,
      role: id === "Inbox" ? "inbox" : "other",
      exclusive: true,
    }));
  }

  async *syncFolder(
    account: Account,
    folder: Label,
    cursor: SyncCursor | null,
    context: FolderSyncContext,
  ): AsyncIterable<SyncBatch> {
    const log = this.log(folder.id);
    const from = typeof cursor?.read === "number" ? cursor.read : 0;
    const changes = log.slice(from);
    // What each id came to over the round: an id added and removed again is only a removal.
    const last = new Map<string, Change["kind"]>();
    for (const change of changes) last.set(change.itemId, change.kind);
    const addedIds = [...last].filter(([, kind]) => kind === "added").map(([id]) => id);
    const removedIds = [...last].filter(([, kind]) => kind === "removed").map(([id]) => id);
    const at = (uid: number, itemId: string): MessageLocation => ({
      accountId: account.id,
      folderId: folder.id,
      uidValidity: "1",
      uid,
      itemId,
    });

    const numbers = await context.itemUids(addedIds);
    const known = await context.knownProviderIds(addedIds);
    const batch: SyncBatch = {
      documents: [],
      knownLocations: [],
      flagUpdates: [],
      removedLocations: [],
      cursor: { read: from },
    };
    const documents: SyncBatch["documents"][number][] = [];
    const knownLocations: SyncBatch["knownLocations"][number][] = [];
    for (const itemId of addedIds) {
      const location = at(numbers.get(itemId) as number, itemId);
      const document = this.documents.get(itemId) as MessageDocument;
      if (known.has(itemId)) {
        knownLocations.push({ providerId: itemId, location, flags: document.message.flags });
      } else {
        this.downloads.push(itemId);
        documents.push({
          document: { ...document, message: { ...document.message, accountId: account.id } },
          location,
        });
      }
    }
    if (documents.length > 0 || knownLocations.length > 0) {
      yield { ...batch, documents, knownLocations };
    }
    const gone = await context.knownItemUids(removedIds);
    yield {
      ...batch,
      removedLocations: [...gone].map(([itemId, uid]) => at(uid, itemId)),
      cursor: { read: log.length },
    };
  }
}
