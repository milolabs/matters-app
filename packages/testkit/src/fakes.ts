import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AccountStorePort,
  AttachmentAnswer,
  AutomatedAnswer,
  CandidateThread,
  Changes,
  Credential,
  CredentialAvailability,
  CredentialPort,
  CursorPort,
  FileHit,
  FilesPort,
  FlagUpdate,
  GetThreadOptions,
  HtmlKind,
  Label,
  LabelRole,
  ListNewestOptions,
  LocationEntry,
  LocationRemoval,
  Message,
  MessageAttachments,
  MessageBody,
  MessageBodyPort,
  MessageDocument,
  MessageLocation,
  MessageStorePort,
  ParsedQuery,
  PeoplePort,
  PersonSuggestion,
  Placement,
  QueryNode,
  RankedMessage,
  RankedSearchPort,
  ReceivedAttachment,
  ReceivedMail,
  ReplyToAnswer,
  SearchChunk,
  SearchIndexPort,
  SearchOptions,
  SenderCount,
  SentMail,
  SetPlacementResult,
  SetSeenResult,
  StoredAccount,
  SyncCursor,
  Thread,
  ThreadView,
  UnitOfWorkPort,
  UpsertResult,
  WrittenTo,
} from "@matters/core";
import {
  AccountExistsError,
  asksForHidden,
  CredentialsUnavailableError,
  computeMailboxes,
  fileHasWords,
  fileNameMatches,
  folderNamed,
  folderRoles,
  foldFileName,
  foldText,
  hasRole,
  isHiddenMailbox,
  MAILBOX_BIT,
  MESSAGE_KEY_SEQ_LIMIT,
  messageKey,
  plainGroups,
  positiveWords,
  splitMessageKey,
  tokenize,
} from "@matters/core";
import { InMemoryAttachmentStore } from "./fakeAttachments.ts";
import { InMemoryFlagOutbox } from "./fakeFlags.ts";
import { InMemoryImageRuleStore } from "./fakeImageRules.ts";
import { InMemoryMoveOutbox } from "./fakeMoves.ts";
import { InMemoryDraftStore, InMemoryOutbox } from "./fakeSend.ts";
import { InMemorySavedViewStore } from "./fakeViews.ts";

export * from "./fakeAttachments.ts";
export * from "./fakeSend.ts";

/** State a unit of work can roll back: `snapshot()` returns the function that restores it. */
export interface Snapshottable {
  snapshot(): () => void;
}

const identityOf = (m: Message): string => `${m.accountId}\u0000${m.providerId}`;
const locationId = (l: MessageLocation): string =>
  [l.accountId, l.folderId, l.uidValidity, l.uid].join("\u0000");
/** Code unit order, like SQLite's default collation. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sameFlags = (a: Message["flags"], b: Message["flags"]) =>
  a.seen === b.seen && a.flagged === b.flagged && a.answered === b.answered && a.draft === b.draft;

export class InMemoryMessageStore implements MessageStorePort, Snapshottable {
  private byKey = new Map<number, Message>();
  private keyByIdentity = new Map<string, number>();
  private changes: { seq: number; keys: number[] }[] = [];
  private removed = new Map<number, number>();
  private locations = new Map<string, { location: MessageLocation; key: number }>();
  private seq = 0;
  /** Each account's folders, as sync last listed them (ADR 0044, rule 1). */
  private folders = new Map<string, readonly Label[]>();
  /** The files of each message: whether the structure was read, and every file part in order. */
  private files = new Map<number, { known: boolean; items: readonly ReceivedAttachment[] }>();

  snapshot(): () => void {
    const saved = {
      folders: new Map(this.folders),
      files: new Map(this.files),
      locations: new Map(this.locations),
      byKey: new Map(this.byKey),
      keyByIdentity: new Map(this.keyByIdentity),
      changes: [...this.changes],
      removed: new Map(this.removed),
      seq: this.seq,
    };
    return () => {
      this.folders = saved.folders;
      this.files = saved.files;
      this.locations = saved.locations;
      this.byKey = saved.byKey;
      this.keyByIdentity = saved.keyByIdentity;
      this.changes = saved.changes;
      this.removed = saved.removed;
      this.seq = saved.seq;
    };
  }

  async upsertMessages(batch: readonly Message[]): Promise<UpsertResult> {
    if (batch.length === 0) return { changeSeq: this.seq, keys: [] };

    // Resolve every key first so a collision rejects the batch untouched.
    const pending = new Map<string, number>();
    const claimed = new Map<number, string>();
    const keys: number[] = [];
    for (const m of batch) {
      const id = identityOf(m);
      let key = this.keyByIdentity.get(id) ?? pending.get(id);
      if (key === undefined) {
        key = m.key;
        const owner = claimed.get(key) ?? this.ownerOf(key);
        if (owner !== undefined && owner !== id) {
          throw new Error(
            `Message key collision: key ${key} already belongs to another identity (${owner.replace("\u0000", ":")})`,
          );
        }
        pending.set(id, key);
        claimed.set(key, id);
      }
      keys.push(key);
    }

    this.seq++;
    for (const [id, key] of pending) this.keyByIdentity.set(id, key);
    batch.forEach((m, i) => {
      const key = keys[i] as number;
      // Like the real store: a message that does not know its Reply-To keeps what was learned.
      const learned = this.byKey.get(key)?.replyTo;
      const replyTo = m.replyTo ?? learned;
      // The same for the automated flag: an upsert that does not know never erases it.
      const automated = m.automated ?? this.byKey.get(key)?.automated;
      // Like the real store: files claimed for the first time wait for their structure.
      const before = this.byKey.get(key);
      const filed = this.files.get(key);
      if (!filed) this.files.set(key, { known: !m.hasAttachments, items: [] });
      else if (m.hasAttachments && before && !before.hasAttachments) {
        this.files.set(key, { ...filed, known: false });
      }
      this.byKey.set(key, {
        ...m,
        key,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(automated === undefined ? {} : { automated }),
      });
    });
    this.refresh(keys);
    this.changes.push({ seq: this.seq, keys });
    return { changeSeq: this.seq, keys };
  }

  /**
   * Sets the mailboxes of these messages from their labels, copies and folders, as the real store
   * does wherever labels or locations are written (ADR 0044, rule 2). Returns the keys it changed.
   */
  private refresh(keys: Iterable<number>): number[] {
    const changed: number[] = [];
    for (const key of keys) {
      const m = this.byKey.get(key);
      if (!m) continue;
      const folders = this.folders.get(m.accountId) ?? [];
      const byId = new Map(folders.map((f) => [f.id, f]));
      const copies = [...this.locations.values()]
        .filter((e) => e.key === key)
        .flatMap((e) => {
          const folder = byId.get(e.location.folderId);
          return folder && !folder.exclusive ? [{ role: folder.role, exclusive: false }] : [];
        });
      const mailboxes = computeMailboxes(m.labelIds, folderRoles(folders), copies);
      if (m.mailboxes === mailboxes) continue;
      this.byKey.set(key, { ...m, mailboxes });
      changed.push(key);
    }
    return changed;
  }

  /** The message as stored, for the search index to read what changed after it was indexed. */
  peek(key: number): Message | undefined {
    return this.byKey.get(key);
  }

  /** Every stored message with its listed (non-inline) files, for the fake file search. */
  withFiles(): { message: Message; files: readonly ReceivedAttachment[] }[] {
    const out: { message: Message; files: readonly ReceivedAttachment[] }[] = [];
    for (const [key, entry] of this.files) {
      const message = this.byKey.get(key);
      const files = entry.items.filter((a) => !a.inline);
      if (message && files.length > 0) out.push({ message, files });
    }
    return out;
  }

  /** The role of a folder (of any account) that a `label:` value names; Trash and Spam matter. */
  namedFolderRole(folded: string): LabelRole | undefined {
    for (const folders of this.folders.values()) {
      const found = folders.find((f) => folderNamed(f, folded));
      if (found) return found.role;
    }
    return undefined;
  }

  async setFolders(accountId: string, folders: readonly Label[]): Promise<readonly number[]> {
    this.folders.set(accountId, [...folders]);
    const changed = this.refresh(
      [...this.byKey.values()].filter((m) => m.accountId === accountId).map((m) => m.key),
    );
    if (changed.length > 0) {
      this.seq++;
      this.changes.push({ seq: this.seq, keys: changed });
    }
    return changed;
  }

  async listFolders(accountId?: string): Promise<readonly Label[]> {
    const all = [...this.folders.entries()]
      .filter(([id]) => accountId === undefined || id === accountId)
      .sort((a, b) => compareText(a[0], b[0]))
      .flatMap(([, folders]) => [...folders].sort((a, b) => compareText(a.id, b.id)));
    return all;
  }

  async setPlacement(
    entries: readonly (Placement & { readonly key: number })[],
  ): Promise<SetPlacementResult> {
    const next = new Map<number, Message>();
    for (const e of entries) {
      const m = next.get(e.key) ?? this.byKey.get(e.key);
      if (!m) continue;
      const labels = [...new Set(e.labelIds)];
      const same =
        labels.length === m.labelIds.length &&
        labels.every((l, i) => l === m.labelIds[i]) &&
        m.mailboxes === e.mailboxes;
      if (same) continue;
      next.set(e.key, { ...m, labelIds: labels, mailboxes: e.mailboxes });
    }
    if (next.size === 0) return { changeSeq: this.seq, changedKeys: [] };
    this.seq++;
    for (const [key, m] of next) this.byKey.set(key, m);
    const changedKeys = [...next.keys()];
    this.changes.push({ seq: this.seq, keys: changedKeys });
    return { changeSeq: this.seq, changedKeys };
  }

  async removeByProviderIds(
    accountId: string,
    providerIds: readonly string[],
  ): Promise<readonly number[]> {
    const keys: number[] = [];
    for (const providerId of new Set(providerIds)) {
      const id = `${accountId}\u0000${providerId}`;
      const key = this.keyByIdentity.get(id);
      if (key === undefined) continue;
      keys.push(key);
    }
    if (keys.length === 0) return keys;
    this.seq++;
    for (const key of keys) this.deleteMessage(key);
    return keys;
  }

  async removeAccountMessages(accountId: string): Promise<readonly number[]> {
    this.folders.delete(accountId);
    const keys = [...this.byKey.values()]
      .filter((m) => m.accountId === accountId)
      .map((m) => m.key);
    if (keys.length === 0) return keys;
    this.seq++;
    for (const key of keys) this.deleteMessage(key);
    return keys;
  }

  async listLabels(): Promise<readonly string[]> {
    const all = new Set<string>();
    for (const m of this.byKey.values()) for (const l of m.labelIds) all.add(foldText(l));
    return [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 500);
  }

  /** Drops the message and its locations; call after `this.seq` was bumped. */
  private deleteMessage(key: number): void {
    const m = this.byKey.get(key);
    if (m) this.keyByIdentity.delete(identityOf(m));
    this.byKey.delete(key);
    this.files.delete(key);
    for (const [id, e] of this.locations) if (e.key === key) this.locations.delete(id);
    this.removed.set(key, this.seq);
  }

  async findByProviderIds(
    accountId: string,
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const found = new Map<string, number>();
    for (const id of providerIds) {
      const key = this.keyByIdentity.get(`${accountId}\u0000${id}`);
      if (key !== undefined) found.set(id, key);
    }
    return found;
  }

  async allocateKeys(dateMs: readonly number[]): Promise<readonly number[]> {
    const claimed = new Set<number>();
    return dateMs.map((ms) => {
      for (let seq = 0; seq < MESSAGE_KEY_SEQ_LIMIT; seq++) {
        const key = messageKey(ms, seq);
        if (this.byKey.has(key) || claimed.has(key)) continue;
        claimed.add(key);
        return key;
      }
      throw new RangeError(`no free message key left for dateMs ${ms}`);
    });
  }

  async addLocations(entries: readonly LocationEntry[]): Promise<void> {
    for (const { key } of entries) {
      if (!this.byKey.has(key))
        throw new Error(`Cannot add a location for unknown message key ${key}`);
    }
    for (const { key, location } of entries)
      this.locations.set(locationId(location), { location, key });
    this.refresh(entries.map((e) => e.key));
  }

  async removeLocations(locations: readonly MessageLocation[]): Promise<LocationRemoval> {
    const affected = new Set<number>();
    for (const l of locations) {
      const entry = this.locations.get(locationId(l));
      if (!entry) continue;
      affected.add(entry.key);
      this.locations.delete(locationId(l));
    }
    return this.deleteOrphans([...affected]);
  }

  async removeFolderLocations(
    accountId: string,
    folderId: string,
    keepUidValidity?: string,
  ): Promise<LocationRemoval> {
    const affected = new Set<number>();
    for (const [id, { location, key }] of this.locations) {
      if (location.accountId !== accountId || location.folderId !== folderId) continue;
      if (location.uidValidity === keepUidValidity) continue;
      affected.add(key);
      this.locations.delete(id);
    }
    return this.deleteOrphans([...affected]);
  }

  private hasLocation(key: number): boolean {
    for (const e of this.locations.values()) if (e.key === key) return true;
    return false;
  }

  private deleteOrphans(keys: readonly number[]): LocationRemoval {
    const deletedKeys: number[] = [];
    const survivingKeys: number[] = [];
    for (const key of keys) {
      if (this.hasLocation(key)) survivingKeys.push(key);
      else if (this.byKey.has(key)) deletedKeys.push(key);
    }
    this.refresh(survivingKeys);
    if (deletedKeys.length > 0) {
      this.seq++;
      for (const key of deletedKeys) this.deleteMessage(key);
    }
    return { deletedKeys, survivingKeys };
  }

  async listLocationUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
  ): Promise<readonly number[]> {
    return [...this.locations.values()]
      .filter(
        ({ location: l }) =>
          l.accountId === accountId && l.folderId === folderId && l.uidValidity === uidValidity,
      )
      .map(({ location }) => location.uid)
      .sort((a, b) => a - b);
  }

  async getLocations(key: number): Promise<readonly MessageLocation[]> {
    return [...this.locations.values()]
      .filter((e) => e.key === key)
      .map((e) => e.location)
      .sort(
        (a, b) =>
          compareText(a.folderId, b.folderId) ||
          compareText(a.uidValidity, b.uidValidity) ||
          a.uid - b.uid,
      );
  }

  async updateFlags(updates: readonly FlagUpdate[]): Promise<readonly number[]> {
    const changed = new Set<number>();
    const next = new Map<number, Message>();
    for (const u of updates) {
      const entry = this.locations.get(locationId(u.location));
      const m = entry && (next.get(entry.key) ?? this.byKey.get(entry.key));
      if (!entry || !m) continue;
      const labels = u.labelIds === undefined ? m.labelIds : [...new Set(u.labelIds)];
      const sameLabels =
        labels.length === m.labelIds.length && labels.every((l, i) => l === m.labelIds[i]);
      if (sameFlags(u.flags, m.flags) && sameLabels) continue;
      next.set(entry.key, { ...m, flags: u.flags, labelIds: labels });
      changed.add(entry.key);
    }
    if (changed.size === 0) return [];
    this.seq++;
    for (const [key, m] of next) this.byKey.set(key, m);
    this.refresh(changed);
    this.changes.push({ seq: this.seq, keys: [...changed] });
    return [...changed];
  }

  async listUnknownReplyToUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]> {
    const unknown = [...this.locations.values()]
      .filter(
        ({ location: l, key }) =>
          l.accountId === accountId &&
          l.folderId === folderId &&
          l.uidValidity === uidValidity &&
          this.byKey.get(key)?.replyTo === undefined,
      )
      .sort((a, b) => b.key - a.key)
      .slice(0, Math.max(0, Math.trunc(limit)));
    return unknown.map((e) => e.location.uid).sort((a, b) => a - b);
  }

  async setReplyTo(answers: readonly ReplyToAnswer[]): Promise<readonly number[]> {
    const next = new Map<number, Message>();
    const announced: number[] = [];
    for (const { location, replyTo } of answers) {
      const entry = this.locations.get(locationId(location));
      const m = entry && (next.get(entry.key) ?? this.byKey.get(entry.key));
      if (!entry || !m || m.replyTo !== undefined) continue;
      next.set(entry.key, { ...m, replyTo });
      if (replyTo.length > 0) announced.push(entry.key);
    }
    if (announced.length > 0) {
      this.seq++;
      this.changes.push({ seq: this.seq, keys: announced });
    }
    for (const [key, m] of next) this.byKey.set(key, m);
    return [...next.keys()];
  }

  async listUnknownAutomatedUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]> {
    const unknown = [...this.locations.values()]
      .filter(
        ({ location: l, key }) =>
          l.accountId === accountId &&
          l.folderId === folderId &&
          l.uidValidity === uidValidity &&
          this.byKey.get(key)?.automated === undefined,
      )
      .sort((a, b) => b.key - a.key)
      .slice(0, Math.max(0, Math.trunc(limit)));
    return unknown.map((e) => e.location.uid).sort((a, b) => a - b);
  }

  async setAutomated(answers: readonly AutomatedAnswer[]): Promise<readonly number[]> {
    const next = new Map<number, Message>();
    for (const { location, automated } of answers) {
      const entry = this.locations.get(locationId(location));
      const m = entry && (next.get(entry.key) ?? this.byKey.get(entry.key));
      if (!entry || !m || m.automated !== undefined) continue;
      next.set(entry.key, { ...m, automated });
    }
    for (const [key, m] of next) this.byKey.set(key, m);
    return [...next.keys()];
  }

  async listUnknownAttachmentUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]> {
    const unknown = [...this.locations.values()]
      .filter(({ location: l, key }) => {
        const m = this.byKey.get(key);
        return (
          l.accountId === accountId &&
          l.folderId === folderId &&
          l.uidValidity === uidValidity &&
          m?.hasAttachments === true &&
          this.files.get(key)?.known === false
        );
      })
      .sort((a, b) => b.key - a.key)
      .slice(0, Math.max(0, Math.trunc(limit)));
    return unknown.map((e) => e.location.uid).sort((a, b) => a - b);
  }

  async setAttachments(answers: readonly AttachmentAnswer[]): Promise<readonly number[]> {
    const set: number[] = [];
    const announced: number[] = [];
    for (const { location, attachments } of answers) {
      const entry = this.locations.get(locationId(location));
      const m = entry && this.byKey.get(entry.key);
      if (!entry || !m) continue;
      const listed = attachments.some((a) => !a.inline);
      this.files.set(entry.key, { known: true, items: attachments });
      this.byKey.set(entry.key, { ...m, hasAttachments: listed });
      set.push(entry.key);
      if (listed || m.hasAttachments !== listed) announced.push(entry.key);
    }
    if (announced.length > 0) {
      this.seq++;
      this.changes.push({ seq: this.seq, keys: announced });
    }
    return set;
  }

  async getAttachment(key: number, partId: string): Promise<ReceivedAttachment | null> {
    return this.files.get(key)?.items.find((a) => a.partId === partId) ?? null;
  }

  async setSeen(keys: readonly number[], seen: boolean): Promise<SetSeenResult> {
    const changed: number[] = [];
    const next = new Map<number, Message>();
    for (const key of new Set(keys)) {
      const m = this.byKey.get(key);
      if (!m || m.flags.seen === seen) continue;
      next.set(key, { ...m, flags: { ...m.flags, seen } });
      changed.push(key);
    }
    if (changed.length === 0) return { changeSeq: this.seq, changedKeys: [] };
    this.seq++;
    for (const [key, m] of next) this.byKey.set(key, m);
    this.changes.push({ seq: this.seq, keys: changed });
    return { changeSeq: this.seq, changedKeys: changed };
  }

  async deriveLabelsFromLocations(keys: readonly number[]): Promise<void> {
    const changed: number[] = [];
    const next = new Map<number, Message>();
    for (const key of new Set(keys)) {
      const m = this.byKey.get(key);
      if (!m) continue;
      const folders = [
        ...new Set(
          [...this.locations.values()].filter((e) => e.key === key).map((e) => e.location.folderId),
        ),
      ].sort();
      if (folders.length === 0) continue;
      if (folders.length === m.labelIds.length && folders.every((f, i) => f === m.labelIds[i])) {
        continue;
      }
      next.set(key, { ...m, labelIds: folders });
      changed.push(key);
    }
    if (changed.length === 0) return;
    this.seq++;
    for (const [key, m] of next) this.byKey.set(key, m);
    this.refresh(changed);
    this.changes.push({ seq: this.seq, keys: changed });
  }

  private ownerOf(key: number): string | undefined {
    const m = this.byKey.get(key);
    return m && identityOf(m);
  }

  async getByKeys(keys: readonly number[]): Promise<readonly Message[]> {
    const out: Message[] = [];
    for (const k of keys) {
      const m = this.byKey.get(k);
      if (m) out.push(m);
    }
    return out;
  }

  async getThread(threadId: string, options: GetThreadOptions = {}): Promise<ThreadView | null> {
    const messages = [...this.byKey.values()]
      .filter((m) => m.threadId === threadId)
      .filter((m) => options.visibleOnly !== true || !isHiddenMailbox(m.mailboxes ?? 0))
      .sort((a, b) => a.key - b.key);
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (!first || !last) return null;
    const thread: Thread = {
      id: threadId,
      accountId: first.accountId,
      subject: first.subject,
      messageKeys: messages.map((m) => m.key),
      lastMessageKey: last.key,
      labelIds: [...new Set(messages.flatMap((m) => m.labelIds))],
      unreadCount: messages.filter((m) => !m.flags.seen).length,
    };
    const attachments = new Map<number, MessageAttachments>(
      messages.map((m) => {
        const filed = this.files.get(m.key);
        return [
          m.key,
          {
            known: filed?.known ?? true,
            items: (filed?.items ?? []).filter((a) => !a.inline),
            hasInline: (filed?.items ?? []).some((a) => a.inline),
          },
        ];
      }),
    );
    return { thread, messages, attachments };
  }

  async listNewest(options: ListNewestOptions): Promise<readonly Message[]> {
    return (
      [...this.byKey.values()]
        .filter((m) => options.beforeKey === undefined || m.key < options.beforeKey)
        .filter((m) => options.labelId === undefined || m.labelIds.includes(options.labelId))
        // All mail leaves out Trash and Spam; asking for a label is asking for them (ADR 0044).
        .filter((m) => options.labelId !== undefined || !isHiddenMailbox(m.mailboxes ?? 0))
        .sort((a, b) => b.key - a.key)
        .slice(0, Math.max(0, options.limit))
    );
  }

  async listWrittenTo(): Promise<ReadonlyMap<string, WrittenTo>> {
    const out = new Map<string, WrittenTo>();
    for (const m of this.byKey.values()) {
      if (!hasRole(m.mailboxes ?? 0, "sent")) continue;
      const named = new Set([...m.to, ...m.cc].map((p) => p.address.toLowerCase()));
      for (const address of named) {
        const known = out.get(address);
        const name = [...m.to, ...m.cc].find(
          (p) => p.address.toLowerCase() === address && p.name,
        )?.name;
        out.set(address, {
          sent: (known?.sent ?? 0) + 1,
          lastMs: Math.max(known?.lastMs ?? 0, m.dateMs),
          ...(known?.name !== undefined || name !== undefined
            ? { name: (known?.name ?? name) as string }
            : {}),
        });
      }
    }
    return out;
  }

  async listReceivedMail(sinceMs: number): Promise<readonly ReceivedMail[]> {
    return [...this.byKey.values()]
      .filter(
        (m) =>
          !hasRole(m.mailboxes ?? 0, "sent") &&
          !isHiddenMailbox(m.mailboxes ?? 0) &&
          m.key >= messageKey(sinceMs, 0),
      )
      .sort((a, b) => b.key - a.key)
      .map((m) => ({ key: m.key, threadId: m.threadId, from: m.from.address.toLowerCase() }));
  }

  async listSenderCounts(
    sinceMs: number,
    options: {
      readonly accountIds: readonly string[];
      readonly by: "sender" | "domain";
      readonly limit: number;
    },
  ): Promise<readonly SenderCount[]> {
    const accounts = new Set(options.accountIds);
    const rows = new Map<
      string,
      { key: string; name?: string; messages: number; unread: number; newest: number }
    >();
    for (const m of [...this.byKey.values()].sort((a, b) => b.key - a.key)) {
      if (hasRole(m.mailboxes ?? 0, "sent") || isHiddenMailbox(m.mailboxes ?? 0)) continue;
      if (m.key < messageKey(sinceMs, 0) || !accounts.has(m.accountId)) continue;
      const address = m.from.address.toLowerCase();
      if (address === "") continue;
      const key = options.by === "sender" ? address : address.slice(address.indexOf("@") + 1);
      const row = rows.get(key);
      if (row === undefined) {
        // Newest first: the first name met is the latest one.
        const name = options.by === "sender" ? m.from.name?.trim() : undefined;
        rows.set(key, {
          key,
          ...(name === undefined || name === "" ? {} : { name }),
          messages: 1,
          unread: m.flags.seen ? 0 : 1,
          newest: m.key,
        });
      } else {
        row.messages++;
        if (!m.flags.seen) row.unread++;
      }
    }
    return [...rows.values()]
      .sort((a, b) => b.messages - a.messages || b.newest - a.newest)
      .slice(0, Math.max(0, Math.trunc(options.limit)))
      .map(({ newest: _newest, ...row }) => row);
  }

  async listSentMail(): Promise<readonly SentMail[]> {
    return [...this.byKey.values()]
      .filter((m) => hasRole(m.mailboxes ?? 0, "sent") && !isHiddenMailbox(m.mailboxes ?? 0))
      .sort((a, b) => b.key - a.key)
      .map((m) => ({
        subject: m.subject,
        recipients: [...m.to, ...m.cc].map((p) => p.address.toLowerCase()),
      }));
  }

  async listThreadsSince(sinceMs: number, limit: number): Promise<readonly CandidateThread[]> {
    const floor = messageKey(sinceMs, 0);
    const visible = [...this.byKey.values()]
      .filter((m) => !isHiddenMailbox(m.mailboxes ?? 0))
      .sort((a, b) => a.key - b.key);
    const byThread = new Map<string, Message[]>();
    for (const m of visible) {
      const list = byThread.get(m.threadId);
      if (list) list.push(m);
      else byThread.set(m.threadId, [m]);
    }
    return [...byThread.values()]
      .filter((list) => (list[list.length - 1] as Message).key >= floor)
      .sort((a, b) => (b[b.length - 1] as Message).key - (a[a.length - 1] as Message).key)
      .slice(0, Math.max(0, limit))
      .map((list) => {
        const last = list[list.length - 1] as Message;
        return {
          threadId: last.threadId,
          accountId: last.accountId,
          lastMessageKey: last.key,
          lastDateMs: last.dateMs,
          lastFromOwn: ((last.mailboxes ?? 0) & MAILBOX_BIT.sent) !== 0,
          subject: last.subject,
          messages: list.map((m) => ({
            from: m.from.address.toLowerCase(),
            ...(m.automated === undefined ? {} : { automated: m.automated }),
          })),
        };
      });
  }

  async changesSince(seq: number): Promise<Changes> {
    const keys = new Set<number>();
    for (const c of this.changes) {
      if (c.seq > seq) for (const k of c.keys) keys.add(k);
    }
    const removedKeys = [...this.removed]
      .filter(([key, at]) => at > seq && !this.byKey.has(key))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .map(([key]) => key);
    return {
      changeSeq: this.seq,
      changedKeys: [...keys].filter((k) => this.byKey.has(k)),
      removedKeys,
    };
  }
}

interface IndexedDoc {
  readonly message: Message;
  readonly from: string[];
  readonly to: string[];
  readonly cc: string[];
  readonly subject: string[];
  readonly body: string[];
  readonly labels: string[];
}

function participantTokens(ps: readonly { name?: string; address: string }[]): string[] {
  return ps.flatMap((p) => tokenize(`${p.name ?? ""} ${p.address}`));
}

function hasSequence(tokens: readonly string[], words: readonly string[]): boolean {
  if (words.length === 0) return false;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

function textMatches(node: Extract<QueryNode, { kind: "text" }>, d: IndexedDoc): boolean {
  const fields =
    node.field === "any"
      ? [d.from, d.to, d.cc, d.subject, d.body]
      : [
          node.field === "from"
            ? d.from
            : node.field === "to"
              ? d.to
              : node.field === "cc"
                ? d.cc
                : d.subject,
        ];
  if (node.match === "phrase") return fields.some((f) => hasSequence(f, node.value.split(" ")));
  return fields.some((f) => f.some((t) => t.startsWith(node.value)));
}

/**
 * Dates are read from the key, not from `dateMs` (ADR 0025). `m` is the message as the store has
 * it now: like the real index, which reads flags, labels and mailboxes from the store.
 */
function evaluate(node: QueryNode, d: IndexedDoc, m: Message): boolean {
  switch (node.kind) {
    case "and":
      return node.children.every((c) => evaluate(c, d, m));
    case "or":
      return node.children.some((c) => evaluate(c, d, m));
    case "not":
      return !evaluate(node.child, d, m);
    case "text":
      return textMatches(node, d);
    case "label":
      return m.labelIds.some((l) => foldText(l) === node.value);
    case "in":
      return hasRole(m.mailboxes ?? 0, node.role);
    case "flag":
      switch (node.flag) {
        case "unread":
          return !m.flags.seen;
        case "read":
          return m.flags.seen;
        case "starred":
          return m.flags.flagged;
        case "replied":
          return m.flags.answered;
        case "draft":
          return m.flags.draft;
      }
      return false;
    case "attachment":
      return m.hasAttachments;
    case "account":
      return node.ids.includes(m.accountId);
    case "after":
      return splitMessageKey(m.key).dateMs >= node.ms;
    case "before":
      return splitMessageKey(m.key).dateMs < node.ms;
  }
}

/** Reference semantics for `SearchIndexPort`; the SQLite adapter must agree with it. */
export class InMemorySearchIndex
  implements SearchIndexPort, RankedSearchPort, PeoplePort, FilesPort, Snapshottable
{
  private docs = new Map<number, IndexedDoc>();
  private readonly store:
    | Pick<InMemoryMessageStore, "peek" | "namedFolderRole" | "withFiles">
    | undefined;

  /** With the store the index reads what changed after a message was indexed (labels, mailboxes). */
  constructor(store?: Pick<InMemoryMessageStore, "peek" | "namedFolderRole" | "withFiles">) {
    this.store = store;
  }

  snapshot(): () => void {
    const saved = new Map(this.docs);
    return () => {
      this.docs = saved;
    };
  }

  async removeMessages(keys: readonly number[]): Promise<void> {
    for (const k of keys) this.docs.delete(k);
  }

  async indexMessages(batch: readonly MessageDocument[]): Promise<void> {
    for (const { message: m, bodyText } of batch) {
      this.docs.set(m.key, {
        message: m,
        from: participantTokens([m.from]),
        to: participantTokens(m.to),
        cc: participantTokens(m.cc),
        subject: tokenize(m.subject),
        body: tokenize(`${m.snippet} ${bodyText}`),
        labels: m.labelIds.map(foldText),
      });
    }
  }

  async search(query: ParsedQuery, options: SearchOptions): Promise<readonly number[]> {
    const root = query.root;
    if (root === null) return [];
    const { beforeKey, afterKey } = options;
    const oldest = options.order === "oldest";
    // Trash and Spam are left out unless the query asks for them (ADR 0044, rule 3).
    const asked = asksForHidden(root, (v) => this.store?.namedFolderRole(v));
    return [...this.docs.values()]
      .filter((d) => {
        const m = this.store?.peek(d.message.key) ?? d.message;
        if (beforeKey !== undefined && m.key >= beforeKey) return false;
        if (afterKey !== undefined && m.key <= afterKey) return false;
        if (!asked && isHiddenMailbox(m.mailboxes ?? 0)) return false;
        return evaluate(root, d, m);
      })
      .map((d) => d.message.key)
      .sort((a, b) => (oldest ? a - b : b - a))
      .slice(0, Math.max(0, options.limit));
  }

  /**
   * The agent's search (ADR 0080), simply: the messages `search` finds, each with a relevance of 1
   * plus 2 when a word of the query is in the subject and 1 when it is in the sender; the names
   * of files join when the query is plain words. SQLite ranks by bm25; the order of this one is
   * only a stand-in that agrees on what a better match is.
   */
  async searchRanked(
    query: ParsedQuery,
    options: { readonly limit: number; readonly accountIds?: readonly string[] },
  ): Promise<readonly RankedMessage[]> {
    const root = query.root;
    if (root === null) return [];
    const accounts = options.accountIds === undefined ? null : new Set(options.accountIds);
    const words = positiveWords(root);
    const keys = await this.search(query, { limit: Number.MAX_SAFE_INTEGER });
    const out: RankedMessage[] = [];
    for (const key of keys) {
      const d = this.docs.get(key);
      if (d === undefined) continue;
      const m = this.store?.peek(key) ?? d.message;
      if (accounts !== null && !accounts.has(m.accountId)) continue;
      const inSubject = words.some((w) => d.subject.some((t) => t.startsWith(w)));
      const inSender = words.some((w) => d.from.some((t) => t.startsWith(w)));
      out.push({
        messageKey: key,
        threadId: m.threadId,
        accountId: m.accountId,
        relevance: 1 + (inSubject ? 2 : 0) + (inSender ? 1 : 0),
        via: "text",
      });
    }
    out.sort((a, b) => b.relevance - a.relevance || b.messageKey - a.messageKey);
    out.length = Math.min(out.length, Math.max(0, Math.trunc(options.limit)));
    for (const words of plainGroups(root) ?? []) {
      const folded = words.map(foldFileName);
      if (folded.length === 1) {
        for (const hit of await this.searchFiles(words.join(" "), 20)) {
          if (accounts !== null && !accounts.has(hit.accountId)) continue;
          out.push({
            messageKey: hit.messageKey,
            threadId: hit.threadId,
            accountId: hit.accountId,
            relevance: 5,
            via: "file",
          });
        }
      } else {
        const longest = folded.reduce((x, y) => (y.length > x.length ? y : x));
        for (const hit of await this.searchFiles(longest, 100)) {
          if (accounts !== null && !accounts.has(hit.accountId)) continue;
          if (!fileHasWords(foldFileName(hit.fileName), folded)) continue;
          out.push({
            messageKey: hit.messageKey,
            threadId: hit.threadId,
            accountId: hit.accountId,
            relevance: 9,
            via: "file",
          });
        }
      }
    }
    return out;
  }

  /**
   * People derived from the live documents: count is the documents naming the address, the name
   * is the one of the newest document that has one. Same words, filter and order as SQLite.
   */
  async suggest(prefix: string, limit: number): Promise<readonly PersonSuggestion[]> {
    const wanted = tokenize(prefix);
    return wanted.length === 0 ? [] : this.ranked(wanted, limit);
  }

  async frequent(limit: number): Promise<readonly PersonSuggestion[]> {
    return this.ranked([], limit);
  }

  /** ADR 0074, from the files the store holds: the same matching, order and dedupe as SQLite. */
  async searchFiles(text: string, limit: number, accountId?: string): Promise<readonly FileHit[]> {
    const query = foldFileName(text);
    const want = Math.max(0, Math.trunc(limit));
    if (query === "" || want === 0 || !this.store) return [];
    const hits: FileHit[] = [];
    const seen = new Set<string>();
    const newestFirst = this.store.withFiles().sort((a, b) => b.message.key - a.message.key);
    for (const { message: m, files } of newestFirst) {
      if (isHiddenMailbox(m.mailboxes ?? 0)) continue;
      if (accountId !== undefined && m.accountId !== accountId) continue;
      for (const f of files) {
        const folded = foldFileName(f.name);
        if (!fileNameMatches(folded, query)) continue;
        const same = `${m.threadId}\u0000${folded}`;
        if (seen.has(same)) continue;
        seen.add(same);
        hits.push({
          messageKey: m.key,
          partId: f.partId,
          fileName: f.name,
          sizeBytes: f.size,
          contentType: f.mimeType,
          threadId: m.threadId,
          accountId: m.accountId,
          sender: m.from,
          dateMs: m.dateMs,
        });
        if (hits.length >= want) return hits;
      }
    }
    return hits;
  }

  private ranked(wanted: readonly string[], limit: number): readonly PersonSuggestion[] {
    return this.rankedRaw(wanted, limit).map(({ lastMs: _, ...p }) => p);
  }

  private rankedRaw(
    wanted: readonly string[],
    limit: number,
  ): readonly (PersonSuggestion & { lastMs: number })[] {
    const people = new Map<
      string,
      { name: string | undefined; nameMs: number; count: number; lastMs: number }
    >();
    for (const { message: m } of this.docs.values()) {
      const seenHere = new Set<string>();
      for (const p of [m.from, ...m.to, ...m.cc]) {
        const address = p.address.trim().toLowerCase();
        if (address === "") continue;
        let e = people.get(address);
        if (e === undefined) {
          e = { name: undefined, nameMs: Number.NEGATIVE_INFINITY, count: 0, lastMs: m.dateMs };
          people.set(address, e);
        }
        if (!seenHere.has(address)) {
          seenHere.add(address);
          e.count++;
        }
        e.lastMs = Math.max(e.lastMs, m.dateMs);
        const name = p.name?.trim();
        if (name && m.dateMs >= e.nameMs) {
          e.name = name;
          e.nameMs = m.dateMs;
        }
      }
    }
    const found: (PersonSuggestion & { lastMs: number })[] = [];
    for (const [address, e] of people) {
      const words = [...new Set(tokenize(`${e.name ?? ""} ${address}`))].slice(0, 16);
      if (tokenize(address).length === 0) continue;
      if (!wanted.every((w) => words.some((x) => x.startsWith(w)))) continue;
      found.push({
        address,
        ...(e.name === undefined ? {} : { name: e.name }),
        count: e.count,
        lastMs: e.lastMs,
      });
    }
    return found
      .sort((a, b) => b.count - a.count || b.lastMs - a.lastMs || (a.address < b.address ? -1 : 1))
      .slice(0, Math.max(0, Math.trunc(limit)));
  }

  /** One full page, with a cursor when it is full: `nextAfterKey` for `oldest`. */
  async searchChunk(query: ParsedQuery, options: SearchOptions): Promise<SearchChunk> {
    const keys = await this.search(query, options);
    const last = keys[keys.length - 1];
    if (keys.length !== Math.trunc(options.limit) || last === undefined) return { keys };
    return options.order === "oldest"
      ? { keys, nextAfterKey: last }
      : { keys, nextBeforeKey: last };
  }

  async matchesAmong(query: ParsedQuery, keys: readonly number[]): Promise<readonly number[]> {
    const among = new Set(keys);
    const all = await this.search(query, { limit: Number.MAX_SAFE_INTEGER });
    return all.filter((key) => among.has(key));
  }
}

/** Reference semantics for `MessageBodyPort`; the SQLite adapter must agree with it. */
export class InMemoryBodyStore implements MessageBodyPort, Snapshottable {
  private byKey = new Map<number, string>();
  private htmlByKey = new Map<number, { html: string; kind: HtmlKind }>();

  snapshot(): () => void {
    const saved = new Map(this.byKey);
    const savedHtml = new Map(this.htmlByKey);
    return () => {
      this.byKey = saved;
      this.htmlByKey = savedHtml;
    };
  }

  async removeBodies(keys: readonly number[]): Promise<void> {
    for (const k of keys) {
      this.byKey.delete(k);
      this.htmlByKey.delete(k);
    }
  }

  async putBodies(batch: readonly MessageBody[]): Promise<void> {
    for (const b of batch) {
      this.byKey.set(b.key, b.text);
      if (b.html !== undefined) {
        this.htmlByKey.set(b.key, { html: b.html, kind: b.htmlKind ?? "simple" });
      }
    }
  }

  async getHtmlKinds(keys: readonly number[]): Promise<ReadonlyMap<number, HtmlKind>> {
    const out = new Map<number, HtmlKind>();
    for (const k of keys) {
      const stored = this.htmlByKey.get(k);
      if (stored) out.set(k, stored.kind);
    }
    return out;
  }

  async getHtml(key: number): Promise<string | undefined> {
    return this.htmlByKey.get(key)?.html;
  }

  async getBodies(keys: readonly number[]): Promise<ReadonlyMap<number, string>> {
    const out = new Map<number, string>();
    for (const k of keys) {
      const text = this.byKey.get(k);
      if (text !== undefined) out.set(k, text);
    }
    return out;
  }
}

export class InMemoryCursorStore implements CursorPort, Snapshottable {
  private cursors = new Map<string, SyncCursor>();

  snapshot(): () => void {
    const saved = new Map(this.cursors);
    return () => {
      this.cursors = saved;
    };
  }

  async get(accountId: string, folderId: string): Promise<SyncCursor | null> {
    return this.cursors.get(`${accountId}\u0000${folderId}`) ?? null;
  }

  async set(accountId: string, folderId: string, cursor: SyncCursor): Promise<void> {
    this.cursors.set(`${accountId}\u0000${folderId}`, { ...cursor });
  }

  async deleteAccount(accountId: string): Promise<void> {
    for (const id of [...this.cursors.keys()]) {
      if (id.startsWith(`${accountId}\u0000`)) this.cursors.delete(id);
    }
  }
}

export class InMemoryAccountStore implements AccountStorePort, Snapshottable {
  private accounts = new Map<string, StoredAccount>();

  snapshot(): () => void {
    const saved = new Map(this.accounts);
    return () => {
      this.accounts = saved;
    };
  }

  async list(): Promise<readonly StoredAccount[]> {
    return [...this.accounts.values()].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || compareText(a.id, b.id),
    );
  }

  async get(id: string): Promise<StoredAccount | null> {
    return this.accounts.get(id) ?? null;
  }

  async add(account: StoredAccount): Promise<void> {
    const address = account.address.toLowerCase();
    for (const a of this.accounts.values()) {
      if (a.id === account.id || a.address.toLowerCase() === address) {
        throw new AccountExistsError(account.address);
      }
    }
    this.accounts.set(account.id, account);
  }

  async remove(id: string): Promise<boolean> {
    return this.accounts.delete(id);
  }

  async setMessageLimit(accountId: string, bytes: number | null): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    const { messageLimitBytes: _old, ...rest } = account;
    this.accounts.set(accountId, bytes === null ? rest : { ...rest, messageLimitBytes: bytes });
  }
}

/** A vault in memory that can pretend to be unusable, like `safeStorage` without a keyring. */
export class InMemoryCredentialStore implements CredentialPort {
  private readonly secrets = new Map<string, Credential>();
  unavailableReason: string | null = null;

  async availability(): Promise<CredentialAvailability> {
    return this.unavailableReason === null
      ? { available: true }
      : { available: false, reason: this.unavailableReason };
  }

  async get(accountId: string): Promise<Credential | null> {
    return this.secrets.get(accountId) ?? null;
  }

  async set(accountId: string, credential: Credential): Promise<void> {
    if (this.unavailableReason !== null)
      throw new CredentialsUnavailableError(this.unavailableReason);
    this.secrets.set(accountId, credential);
  }

  async delete(accountId: string): Promise<void> {
    this.secrets.delete(accountId);
  }
}

/**
 * Reference semantics for `UnitOfWorkPort`: snapshots every participant when a unit opens and
 * restores them if `work` throws. Units are serialized; a `run` from inside a unit's own async
 * call chain joins it flat. Unlike the SQLite adapter it does not hold back plain writes made
 * outside a unit while one is open.
 */
export class InMemoryUnitOfWork implements UnitOfWorkPort {
  private readonly participants: readonly Snapshottable[];
  private readonly context = new AsyncLocalStorage<{ open: boolean }>();
  private tail: Promise<void> = Promise.resolve();

  constructor(participants: readonly Snapshottable[]) {
    this.participants = participants;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.open) return work();
    const result = this.tail.then(async () => {
      const token = { open: true };
      const restores = this.participants.map((p) => p.snapshot());
      try {
        return await this.context.run(token, work);
      } catch (error) {
        for (const restore of restores) restore();
        throw error;
      } finally {
        token.open = false;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface InMemoryStorage {
  readonly drafts: InMemoryDraftStore;
  readonly views: InMemorySavedViewStore;
  readonly imageRules: InMemoryImageRuleStore;
  readonly outbox: InMemoryOutbox;
  readonly attachments: InMemoryAttachmentStore;
  readonly flagOps: InMemoryFlagOutbox;
  readonly moveOps: InMemoryMoveOutbox;
  readonly accounts: InMemoryAccountStore;
  readonly store: InMemoryMessageStore;
  readonly index: InMemorySearchIndex;
  readonly bodies: InMemoryBodyStore;
  readonly cursors: InMemoryCursorStore;
  /** The index again, as the port the people requests read. */
  readonly people: InMemorySearchIndex;
  /** The index again, as the port the file requests read (ADR 0074). */
  readonly fileSearch: InMemorySearchIndex;
  readonly uow: InMemoryUnitOfWork;
}

/** All in-memory ports wired to one unit of work. */
export function createInMemoryStorage(): InMemoryStorage {
  const store = new InMemoryMessageStore();
  const index = new InMemorySearchIndex(store);
  const bodies = new InMemoryBodyStore();
  const cursors = new InMemoryCursorStore();
  const accounts = new InMemoryAccountStore();
  const imageRules = new InMemoryImageRuleStore();
  const flagOps = new InMemoryFlagOutbox();
  const moveOps = new InMemoryMoveOutbox();
  const attachments = new InMemoryAttachmentStore();
  return {
    drafts: new InMemoryDraftStore(),
    views: new InMemorySavedViewStore(),
    imageRules,
    attachments,
    outbox: new InMemoryOutbox(attachments),
    flagOps,
    moveOps,
    accounts,
    store,
    index,
    people: index,
    fileSearch: index,
    bodies,
    cursors,
    uow: new InMemoryUnitOfWork([
      store,
      index,
      bodies,
      cursors,
      accounts,
      imageRules,
      flagOps,
      moveOps,
    ]),
  };
}
