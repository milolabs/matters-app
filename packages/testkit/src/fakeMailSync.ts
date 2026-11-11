import type {
  Account,
  FolderSyncContext,
  Label,
  LabelRole,
  MailSyncPort,
  MessageDocument,
  ProviderCapability,
  SyncBatch,
  SyncCursor,
} from "@matters/core";
import { makeDocument, makeLocation } from "./fixtures.ts";

interface Folder {
  uidValidity: string;
  nextUid: number;
  messages: Map<number, { providerId: string; document: MessageDocument }>;
}

/**
 * A tiny in-memory mail server behind `MailSyncPort`: UIDs per folder, UIDVALIDITY, moves and
 * copies that keep the provider id. Cursor: `{ uidValidity, lastUid }`. It records every message
 * it "downloads" (a document in a batch) so tests can assert that moves cost nothing.
 */
export class FakeMailSync implements MailSyncPort {
  readonly capabilities: ReadonlySet<ProviderCapability>;
  readonly downloads: string[] = [];
  /** Folder ids that make `syncFolder` throw, for crash tests. */
  readonly failing = new Set<string>();
  /** What a folder is (ADR 0044); `INBOX` is the inbox and the rest have no role unless set. */
  readonly roles = new Map<string, LabelRole>();
  /** Folders where labels, not folders, are the places (Gmail's All Mail). */
  readonly labelFolders = new Set<string>();
  private readonly folders = new Map<string, Folder>();

  constructor(folderIds: readonly string[], capabilities: readonly ProviderCapability[] = []) {
    this.capabilities = new Set(capabilities);
    for (const id of folderIds) {
      this.folders.set(id, { uidValidity: "1", nextUid: 1, messages: new Map() });
    }
  }

  private folder(id: string): Folder {
    const f = this.folders.get(id);
    if (!f) throw new Error(`no folder ${id}`);
    return f;
  }

  /** Appends a message; returns its UID. */
  add(folderId: string, providerId: string, subject = providerId): number {
    const f = this.folder(folderId);
    const uid = f.nextUid++;
    const document = makeDocument({ providerId, subject }, `body of ${providerId}`);
    f.messages.set(uid, { providerId, document });
    return uid;
  }

  /** Same provider id in another folder, as a server with stable ids reports it. */
  copy(from: string, uid: number, to: string): number {
    const m = this.folder(from).messages.get(uid);
    if (!m) throw new Error(`no uid ${uid} in ${from}`);
    const target = this.folder(to);
    const newUid = target.nextUid++;
    target.messages.set(newUid, m);
    return newUid;
  }

  move(from: string, uid: number, to: string): number {
    const newUid = this.copy(from, uid, to);
    this.expunge(from, uid);
    return newUid;
  }

  expunge(folderId: string, uid: number): void {
    this.folder(folderId).messages.delete(uid);
  }

  /** The folder was deleted and recreated: new UIDVALIDITY, UIDs restart. */
  recreate(folderId: string): void {
    const f = this.folder(folderId);
    f.uidValidity = String(Number(f.uidValidity) + 1);
    f.nextUid = 1;
    f.messages = new Map();
  }

  async listFolders(account: Account): Promise<readonly Label[]> {
    return [...this.folders.keys()].map((id) => ({
      id,
      accountId: account.id,
      name: id,
      role: this.roles.get(id) ?? (id === "INBOX" ? ("inbox" as const) : ("other" as const)),
      exclusive: !this.labelFolders.has(id),
    }));
  }

  async *syncFolder(
    account: Account,
    folder: Label,
    cursor: SyncCursor | null,
    context: FolderSyncContext,
  ): AsyncIterable<SyncBatch> {
    if (this.failing.has(folder.id)) throw new Error(`sync of ${folder.id} failed`);
    const f = this.folder(folder.id);
    const reset = cursor !== null && cursor.uidValidity !== f.uidValidity;
    const lastUid = cursor && !reset ? Number(cursor.lastUid) : 0;
    const at = (uid: number) => makeLocation(uid, folder.id, f.uidValidity, account.id);

    const fresh = [...f.messages].filter(([uid]) => uid > lastUid).sort((a, b) => b[0] - a[0]);
    const known = await context.knownProviderIds(fresh.map(([, m]) => m.providerId));
    const stored = reset ? [] : await context.storedUids(f.uidValidity);

    const documents: SyncBatch["documents"] = [];
    const knownLocations: SyncBatch["knownLocations"][number][] = [];
    for (const [uid, m] of fresh) {
      if (known.has(m.providerId)) {
        knownLocations.push({
          providerId: m.providerId,
          location: at(uid),
          flags: m.document.message.flags,
        });
      } else {
        this.downloads.push(m.providerId);
        (documents as SyncBatch["documents"][number][]).push({
          document: m.document,
          location: at(uid),
        });
      }
    }
    yield {
      documents,
      knownLocations,
      flagUpdates: [],
      removedLocations: stored.filter((uid) => !f.messages.has(uid)).map(at),
      ...(reset ? { resetFolder: true as const } : {}),
      cursor: { uidValidity: f.uidValidity, lastUid: String(f.nextUid - 1) },
    };
  }
}
