import type { DiscoveredServers, MailServerSettings, StoredAccount } from "../domain/accounts.ts";
import type {
  AgentConsent,
  AgentEffort,
  AgentInstruction,
  AgentInstructionInput,
  AgentRule,
  AgentRuleInput,
  AgentRuntimeId,
  AgentRuntimeInfo,
  AgentRuntimeRecord,
  AgentSettings,
  AgentSettingsPatch,
  JournalEntry,
  JournalMemo,
  LedgerEntry,
  NewTalkEntry,
  PlanLimits,
  PreparedRecord,
  TalkEntry,
  ThingFeedback,
} from "../domain/agent.ts";
import type {
  AttachmentState,
  OfferingCarrier,
  SendLane,
  StoredAttachment,
} from "../domain/attachment.ts";
import type { Draft } from "../domain/draft.ts";
import type {
  Account,
  HtmlKind,
  Label,
  Message,
  MessageDocument,
  MessageFlags,
  MessageLocation,
  Participant,
  ProviderCapability,
  SenderAuth,
  Thread,
} from "../domain/entities.ts";
import type { FileHit } from "../domain/fileHit.ts";
import type {
  ExtractedText,
  KeptFileText,
  ReadableKind,
  WholeMediaType,
} from "../domain/fileText.ts";
import type { GeneralImages, ImageRule, ImageRuleScope } from "../domain/imageRules.ts";
import type {
  MoveAction,
  MoveOperation,
  MoveTarget,
  NewMoveOperation,
  Placement,
} from "../domain/move.ts";
import type { ArrivalMark, ArrivalSpan } from "../domain/notifications.ts";
import type { PromptSearch, PromptVerdict } from "../domain/prompts.ts";
import type {
  AttachmentAnswer,
  CachedFile,
  MessageAttachments,
  ReceivedAttachment,
} from "../domain/received.ts";
import type { WrittenTo } from "../domain/relation.ts";
import type { NewSeenIntent, SeenIntent } from "../domain/seen.ts";
import type { SendOperation, SendStateKind } from "../domain/send.ts";
import type { FailureDetail } from "../domain/signIn.ts";
import type { TalkSummary, TalkTitleBy } from "../domain/talks.ts";
import type { SavedView } from "../domain/views.ts";
import type { CandidateThread } from "../usecases/agentRequests.ts";
import type { ParsedQuery } from "../usecases/parseQuery.ts";

/** Opaque, adapter-defined JSON (e.g. UIDVALIDITY / UID / MODSEQ for IMAP). */
export type SyncCursor = Readonly<Record<string, string | number | boolean | null>>;

/** A message the provider announced for the first time, with the place it was found. */
export interface SyncedDocument {
  readonly document: MessageDocument;
  readonly location: MessageLocation;
}

/**
 * A copy of a message the store already has (`knownProviderIds` said so): a move or a copy
 * costs a location, not a download (ADR 0016).
 */
export interface KnownLocation {
  readonly providerId: string;
  readonly location: MessageLocation;
  readonly flags: MessageFlags;
  /** Provider labels (Gmail); omitted when labels come from locations. */
  readonly labelIds?: readonly string[];
}

/** New flags (and provider labels) of a message that is already stored, without a document. */
export interface FlagUpdate {
  readonly location: MessageLocation;
  readonly flags: MessageFlags;
  readonly labelIds?: readonly string[];
}

/** What the server said about `Reply-To` for the message at this location (ADR 0042, rule 7). */
export interface ReplyToAnswer {
  readonly location: MessageLocation;
  /** Already normalized: empty when there is none or it is the same as `From`. */
  readonly replyTo: readonly Participant[];
}

/**
 * What the headers said about whether the message at this location is from a list or a program
 * (ADR 0066, rule 6). Written only where the store still does not know.
 */
export interface AutomatedAnswer {
  readonly location: MessageLocation;
  readonly automated: boolean;
}

export interface SyncBatch {
  readonly documents: readonly SyncedDocument[];
  readonly knownLocations: readonly KnownLocation[];
  readonly flagUpdates: readonly FlagUpdate[];
  /** Locations that no longer exist on the server. */
  readonly removedLocations: readonly MessageLocation[];
  /**
   * UIDVALIDITY of the folder changed: its locations from other UIDVALIDITY values are dropped
   * (those this batch announces again survive), messages left without a location are deleted.
   */
  readonly resetFolder?: true;
  /**
   * `Reply-To` of messages already stored that did not know it. Applied only where the store
   * still has no answer, in the same unit of work as the cursor (ADR 0042, rule 7).
   */
  readonly replyTos?: readonly ReplyToAnswer[];
  /**
   * Whether stored messages that did not know it are from a list or a program, read from four
   * headers (ADR 0066, rule 6). Applied only where the store still has no answer, in the same unit
   * of work as the cursor.
   */
  readonly automatedAnswers?: readonly AutomatedAnswer[];
  /**
   * What `BODYSTRUCTURE` said about the files of messages in this batch: the new ones, and stored
   * ones that did not know yet (ADR 0043, rule 2). Committed with the cursor.
   */
  readonly attachmentAnswers?: readonly AttachmentAnswer[];
  /** Persist after the batch is stored; resuming from it must not lose messages. */
  readonly cursor: SyncCursor;
  /** Messages of this folder the run still has to fetch after this batch (progress only). */
  readonly pending?: number;
}

/** What the use case lends an adapter while it syncs one folder. */
export interface FolderSyncContext {
  /** The subset of `ids` the store already has for this account. Ask before downloading sources. */
  knownProviderIds(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** UIDs the store holds as locations of this folder at this UIDVALIDITY, ascending. */
  storedUids(uidValidity: string): Promise<readonly number[]>;
  /**
   * At most `limit` UIDs of this folder at this UIDVALIDITY whose message does not know its
   * `Reply-To` yet, newest messages first (ADR 0042, rule 7). Empty once there is nothing to learn.
   */
  unknownReplyToUids(uidValidity: string, limit: number): Promise<readonly number[]>;
  /**
   * At most `limit` UIDs of this folder at this UIDVALIDITY whose message does not know whether it
   * is automated, newest messages first (ADR 0066, rule 6). Empty once there is nothing to learn.
   */
  unknownAutomatedUids(uidValidity: string, limit: number): Promise<readonly number[]>;
  /**
   * At most `limit` UIDs of this folder at this UIDVALIDITY whose message claims attachments but
   * has not had its structure read, newest first (ADR 0043, rule 2). Empty once there is nothing
   * to learn.
   */
  unknownAttachmentUids(uidValidity: string, limit: number): Promise<readonly number[]>;
}

export interface MailSyncPort {
  readonly capabilities: ReadonlySet<ProviderCapability>;
  listFolders(account: Account): Promise<readonly Label[]>;
  /**
   * Batches come newest first. Additions come before the last batch; the last batch carries
   * flag updates, removals and the final cursor, because the use case applies batches with
   * removals only after every folder had its additions (a move must find its message again).
   */
  syncFolder(
    account: Account,
    folder: Label,
    cursor: SyncCursor | null,
    context: FolderSyncContext,
  ): AsyncIterable<SyncBatch>;
}

export interface ParsedAttachment {
  readonly filename?: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentId?: string;
  /** Embedded in the HTML body (e.g. a logo), not something the user attached. */
  readonly inline: boolean;
}

export interface ParsedMessage {
  readonly subject: string;
  readonly from?: Participant;
  readonly to: readonly Participant[];
  readonly cc: readonly Participant[];
  /** From the `Date` header; absent when missing or unparsable. */
  readonly dateMs?: number;
  /** As in the header, with angle brackets; empty when absent. */
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
  /** Plain text: the text/plain part, else HTML converted to text. */
  readonly text: string;
  /** The HTML part, with inline images embedded. Untrusted. */
  readonly html?: string;
  readonly htmlKind?: HtmlKind;
  readonly attachments: readonly ParsedAttachment[];
  readonly senderAuth: SenderAuth;
  /** The `Reply-To` header, normalized (`normalizeReplyTo`): empty when absent or the same as `From`. */
  readonly replyTo: readonly Participant[];
  /**
   * `List-Unsubscribe`, `List-Id`, `Auto-Submitted` other than `no`, or `Precedence: bulk|list|junk`
   * (ADR 0052, rule 4). Absent: not known.
   */
  readonly automated?: boolean;
}

/** What the caller knows about the account that received the message (ADR 0048). */
export interface ParseContext {
  /**
   * Is this authserv-id (lower case, no trailing dot) one the account's own receiving server
   * writes? The parser reads only an `Authentication-Results` header whose id passes, the
   * topmost such header. Absent: no id is trusted and `senderAuth` is "unknown" (RFC 8601
   * section 7.1: the list starts empty).
   */
  readonly isTrustedAuthServ?: (id: string) => boolean;
}

export interface MimeParserPort {
  /**
   * Never rejects because of the message's bytes. A message that cannot be read comes back as a
   * valid `ParsedMessage` with no sender, no subject, no addresses, no HTML and no files,
   * `senderAuth` "unknown", and `text` a notice for the reader. A caller may fill the gaps from
   * what the server said about the message (the IMAP ENVELOPE). The result is a message like any
   * other: it is stored once and not parsed again.
   *
   * `senderAuth` is "unknown" unless `context.isTrustedAuthServ` names the header that holds the
   * receiving server's verdict.
   */
  parse(raw: Uint8Array, context?: ParseContext): Promise<ParsedMessage>;
}

export interface UpsertResult {
  /** Change sequence after the batch; unchanged for an empty batch. */
  readonly changeSeq: number;
  /**
   * The effective key of each input message, in input order. It differs from
   * `message.key` when the identity was stored earlier under another key.
   */
  readonly keys: readonly number[];
}

export interface ThreadView {
  readonly thread: Thread;
  /** Ascending by key. */
  readonly messages: readonly Message[];
  /** The files of each message, read with the thread in one go (ADR 0043, rule 1). Every key is there. */
  readonly attachments: ReadonlyMap<number, MessageAttachments>;
}

export interface GetThreadOptions {
  /**
   * Leave out the messages in Trash or Spam (ADR 0044): what a thread shows when it is not being
   * looked at from there. Default: every message.
   */
  readonly visibleOnly?: boolean;
}

export interface ListNewestOptions {
  readonly labelId?: string;
  /** Keyset pagination: only messages with `key < beforeKey`. */
  readonly beforeKey?: number;
  readonly limit: number;
}

export interface Changes {
  readonly changeSeq: number;
  /** Keys upserted after the given sequence and still stored. */
  readonly changedKeys: readonly number[];
  /** Keys removed after the given sequence and not stored again since. */
  readonly removedKeys: readonly number[];
}

/** What `setSeen` did: the sequence after it, and the messages whose flag really changed. */
export interface SetSeenResult {
  /** Change sequence after the call; unchanged when nothing changed. */
  readonly changeSeq: number;
  readonly changedKeys: readonly number[];
}

/** What `setPlacement` did, in the shape of `setSeen`'s. */
export type SetPlacementResult = SetSeenResult;

export interface MessageStorePort {
  /**
   * Identity is (accountId, providerId) (ADR 0014). The first upsert of an
   * identity fixes its key for life; later upserts update the fields and keep
   * the stored key, even if `message.key` differs (e.g. the date changed).
   * Index and cache with `UpsertResult.keys`, not with the input keys.
   * A key already owned by a different identity rejects the whole batch.
   */
  upsertMessages(batch: readonly Message[]): Promise<UpsertResult>;
  /** Same order as `keys`; unknown keys are skipped. */
  getByKeys(keys: readonly number[]): Promise<readonly Message[]>;
  getThread(threadId: string, options?: GetThreadOptions): Promise<ThreadView | null>;
  /**
   * Newest first. Without `labelId` this is `All mail`, which leaves out messages in Trash and
   * Spam (ADR 0044, rule 3); naming a label is asking for it.
   */
  listNewest(options: ListNewestOptions): Promise<readonly Message[]>;
  /**
   * Deletes the messages of `accountId` with these provider ids, with their locations; unknown ids
   * are skipped.
   * Returns the removed keys in input order and bumps the change sequence when any were
   * removed. Key owners are the index and the body store: remove those keys there too.
   */
  removeByProviderIds(
    accountId: string,
    providerIds: readonly string[],
  ): Promise<readonly number[]>;
  /** Reads one consistent snapshot: `changeSeq` matches the keys reported. */
  changesSince(seq: number): Promise<Changes>;

  /** Store key of each provider id the account has; unknown ids are absent. */
  findByProviderIds(
    accountId: string,
    providerIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  /**
   * Unused chronological keys (`messageKey`) for new messages, one per date, in input order and
   * distinct from each other. Valid until the next write: call inside the unit of work that
   * upserts them. Throws when a millisecond has no free sequence number left.
   */
  allocateKeys(dateMs: readonly number[]): Promise<readonly number[]>;

  /** Idempotent. Adding an existing location again points it at the given key. */
  addLocations(entries: readonly LocationEntry[]): Promise<void>;
  /**
   * Removes these locations (unknown ones are skipped). A message left without any location is
   * deleted from the store like `removeByProviderIds` does, and its key is reported in
   * `deletedKeys`; the index and the body store are the caller's.
   */
  removeLocations(locations: readonly MessageLocation[]): Promise<LocationRemoval>;
  /**
   * Removes the locations of one folder, except those at `keepUidValidity`; messages left
   * without a location are deleted as in `removeLocations`.
   */
  removeFolderLocations(
    accountId: string,
    folderId: string,
    keepUidValidity?: string,
  ): Promise<LocationRemoval>;
  /** UIDs of this folder's locations at this UIDVALIDITY, ascending. */
  listLocationUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
  ): Promise<readonly number[]>;
  getLocations(key: number): Promise<readonly MessageLocation[]>;
  /**
   * Sets flags (and labels when given) of the messages at these locations; unknown locations
   * are skipped, unchanged messages are not touched. Returns the keys that changed.
   */
  updateFlags(updates: readonly FlagUpdate[]): Promise<readonly number[]>;
  /**
   * UIDs of this folder's locations at this UIDVALIDITY whose message has no `replyTo` yet, at
   * most `limit`, newest messages first, ascending in the result (ADR 0042).
   */
  listUnknownReplyToUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]>;
  /**
   * Sets `replyTo` on the messages at these locations, only where it is still unknown; a value
   * already there is never replaced. Unknown locations are skipped. A change is announced
   * (change sequence, returned keys) only when the list has someone in it, since an empty one
   * shows nothing different. Returns the keys whose value was set, announced or not.
   */
  setReplyTo(answers: readonly ReplyToAnswer[]): Promise<readonly number[]>;
  /**
   * UIDs of this folder's locations at this UIDVALIDITY whose message has no `automated` flag yet,
   * at most `limit`, newest messages first, ascending in the result (ADR 0066, rule 6).
   */
  listUnknownAutomatedUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]>;
  /**
   * Sets `automated` on the messages at these locations, only where it is still unknown; a value
   * already there is never replaced. Unknown locations are skipped. Nothing is announced: the flag
   * shows nothing different to anyone who holds the message. Returns the keys whose value was set.
   */
  setAutomated(answers: readonly AutomatedAnswer[]): Promise<readonly number[]>;
  /**
   * UIDs of this folder's locations at this UIDVALIDITY whose message has attachments that are
   * not known yet, at most `limit`, newest messages first, ascending in the result (ADR 0043).
   */
  listUnknownAttachmentUids(
    accountId: string,
    folderId: string,
    uidValidity: string,
    limit: number,
  ): Promise<readonly number[]>;
  /**
   * Replaces the rows of the messages at these locations with what the server said, and marks
   * them known. `hasAttachments` is corrected to whether a listed (not inline) file exists. A
   * change is announced (change sequence, returned keys) when that flag flipped or the message
   * now lists a file, since the open thread has something new to show. Unknown locations are
   * skipped. Returns the keys that were set, announced or not.
   */
  setAttachments(answers: readonly AttachmentAnswer[]): Promise<readonly number[]>;
  /** One file of a message; null when the message or the part is not stored. */
  getAttachment(key: number, partId: string): Promise<ReceivedAttachment | null>;
  /**
   * Sets `seen` on these messages by key (all other flags stay); unknown keys are skipped.
   * Bumps the change sequence once, and only when a message really changed, which are the keys
   * returned (ADR 0039).
   */
  setSeen(keys: readonly number[], seen: boolean): Promise<SetSeenResult>;
  /**
   * Gives these messages exactly these labels and mailboxes (a move, or taking one back; ADR
   * 0044, rules 8 and 10). Unknown keys and messages that already hold them are skipped. Bumps
   * the change sequence once, and only for the messages that changed, which are the keys returned.
   */
  setPlacement(
    entries: readonly (Placement & { readonly key: number })[],
  ): Promise<SetPlacementResult>;
  /**
   * Replaces the account's folders with this list (ADR 0044, rule 1) and sets the mailboxes of
   * its messages again if what a folder is changed. Messages are announced only when theirs did.
   */
  setFolders(accountId: string, folders: readonly Label[]): Promise<readonly number[]>;
  /** The folders last stored for the account, or for every account; by account, then id. */
  listFolders(accountId?: string): Promise<readonly Label[]>;
  /**
   * For accounts without provider labels: replaces each message's labels with the folders of
   * its locations. Messages without locations and unknown keys are skipped, unchanged
   * messages are not touched.
   */
  deriveLabelsFromLocations(keys: readonly number[]): Promise<void>;
  /**
   * Deletes every message of the account with its locations and labels. Returns the removed
   * keys and bumps the change sequence when any were removed; the index and the body store are
   * the caller's, as with `removeByProviderIds`.
   */
  removeAccountMessages(accountId: string): Promise<readonly number[]>;
  /** Distinct folded label names across all accounts, sorted, at most 500 (ADR 0026). */
  listLabels(): Promise<readonly string[]>;
  /**
   * Threads with a message dated at or after `sinceMs`, newest activity first, at most `limit`,
   * for choosing what agents read (ADR 0052). Messages in Trash and Spam are left out as `All
   * mail` leaves them out, so a thread whose only recent messages are deleted does not appear and
   * a deleted message is not a candidate's last. Each thread carries all its visible messages
   * (oldest first) as sender and `automated` flag only: no text. Cost follows the window, not the
   * mailbox: it walks the visible messages from the newest down to `sinceMs`.
   * `lastFromOwn` is true when the newest visible message is in a Sent mailbox.
   */
  listThreadsSince(sinceMs: number, limit: number): Promise<readonly CandidateThread[]>;
  /**
   * Lowercase addresses named in To or Cc of the person's Sent mail, with how many messages named
   * them and when the newest did (ADR 0057, 0058, 0066). Cost follows what was sent, not the
   * mailbox. Empty also while no Sent folder has been synced.
   */
  listWrittenTo(): Promise<ReadonlyMap<string, WrittenTo>>;
  /**
   * The person's Sent mail, newest first, as much as a list needs to know about who it went to (ADR
   * 0070, rule 1). Mail in Trash and Spam does not count. Cost follows what was sent.
   */
  listSentMail(): Promise<readonly SentMail[]>;
  /**
   * Mail that reached the person at or after `sinceMs`, newest first (ADR 0070, rule 1). The person's
   * own Sent mail and mail in Trash and Spam do not count. Cost follows the window.
   */
  listReceivedMail(sinceMs: number): Promise<readonly ReceivedMail[]>;
  /**
   * Who wrote the most mail that reached the person at or after `sinceMs` (ADR 0102): one row per
   * sender (lowercase address) or per domain (lowercase, what follows the `@`), most messages
   * first, then the newest, at most `limit`. Only mail of `accountIds`; the person's own Sent mail,
   * mail in Trash and Spam, and copies of a message do not count. No text. Cost follows the window:
   * it walks the visible messages from the newest down to `sinceMs`, and groups them.
   */
  listSenderCounts(
    sinceMs: number,
    options: {
      readonly accountIds: readonly string[];
      readonly by: "sender" | "domain";
      readonly limit: number;
    },
  ): Promise<readonly SenderCount[]>;
}

/** One row of `listSenderCounts`. */
export interface SenderCount {
  /** A lowercase address, or a lowercase domain. */
  readonly key: string;
  /** The name on the newest message of a sender; absent for a domain and for no name. */
  readonly name?: string;
  readonly messages: number;
  readonly unread: number;
}

/** One message of the person's Sent mail. Addresses are in lower case. */
export interface SentMail {
  readonly subject: string;
  readonly recipients: readonly string[];
}

/** One message that reached the person. The address is in lower case. */
export interface ReceivedMail {
  readonly key: number;
  readonly threadId: string;
  readonly from: string;
}

export interface LocationEntry {
  readonly key: number;
  readonly location: MessageLocation;
}

export interface LocationRemoval {
  /** Messages deleted because their last location is gone. */
  readonly deletedKeys: readonly number[];
  /** Messages that lost a location and still have another. */
  readonly survivingKeys: readonly number[];
}

/** The plain text of one message, stored with the thread it belongs to. */
export interface MessageBody {
  /** Effective store key (`UpsertResult.keys`). */
  readonly key: number;
  /** Lets an adapter keep a thread's bodies together (ADR 0009). */
  readonly threadId: string;
  /** The sender's address: lets an adapter keep a sender's HTML together (ADR 0088). */
  readonly sender?: string;
  readonly text: string;
  /** The message's own HTML, as sent. Untrusted: sanitize before showing it (ADR 0024). */
  readonly html?: string;
  readonly htmlKind?: HtmlKind;
}

export interface MessageBodyPort {
  /** Replaces the text of every key in the batch; keys are effective store keys. */
  putBodies(batch: readonly MessageBody[]): Promise<void>;
  /**
   * Keys without a stored body are absent from the map, so a missing body is
   * distinguishable from an empty one. Iteration order is not specified.
   */
  getBodies(keys: readonly number[]): Promise<ReadonlyMap<number, string>>;
  /**
   * Deletes the bodies of these keys, rewriting the thread blocks that held them; unknown
   * keys are skipped.
   */
  removeBodies(keys: readonly number[]): Promise<void>;
  /** The kind of HTML of each key that has some; cheap enough for every opened thread. */
  getHtmlKinds(keys: readonly number[]): Promise<ReadonlyMap<number, HtmlKind>>;
  getHtml(key: number): Promise<string | undefined>;
}

export interface SearchOptions {
  readonly limit: number;
  /** Only keys below this one (exclusive). */
  readonly beforeKey?: number;
  /** Only keys above this one (exclusive): the cursor of `oldest`. */
  readonly afterKey?: number;
  /**
   * Which way along the key (ADR 0116, rule 4b; ADR 0025). Default `newest`: keys descending,
   * paged by `beforeKey`. `oldest`: ascending, paged by `afterKey`, time windows oldest first.
   */
  readonly order?: "newest" | "oldest";
}

/** One window of a search (ADR 0025): possibly fewer keys than the limit, even none. */
export interface SearchChunk {
  /** In the order asked for: newest first by default. */
  readonly keys: readonly number[];
  /** `newest`: pass as `beforeKey` for the next chunk; absent when nothing older can match. */
  readonly nextBeforeKey?: number;
  /** `oldest`: pass as `afterKey` for the next chunk; absent when nothing newer can match. */
  readonly nextAfterKey?: number;
}

export interface SearchIndexPort {
  /**
   * Re-indexing a key replaces its document. Keys are effective store keys;
   * label, attachment and date filters read the message store, so upsert the
   * messages first.
   */
  indexMessages(batch: readonly MessageDocument[]): Promise<void>;
  /** Drops these keys from the index; unknown keys are skipped. */
  removeMessages(keys: readonly number[]): Promise<void>;
  /** Message keys in `order` (newest first by default): an exact page of `limit` unless the matches run out. */
  search(query: ParsedQuery, options: SearchOptions): Promise<readonly number[]>;
  /**
   * The next window of matches below `beforeKey`. It may hold fewer keys than the limit, or
   * none, and still have a cursor; following cursors until none is left yields exactly what
   * `search` with an unbounded limit would.
   */
  searchChunk(query: ParsedQuery, options: SearchOptions): Promise<SearchChunk>;
  /**
   * Which of these keys match, newest first: one question, whatever the mailbox holds around them,
   * for a list short enough to name its messages (ADR 0056, rule 2).
   */
  matchesAmong(query: ParsedQuery, keys: readonly number[]): Promise<readonly number[]>;
}

/**
 * One message that matched a ranked search (ADR 0080). `relevance` is higher for a better match:
 * the negated bm25 of the text index with weights on the fields, or a fixed value for a file name.
 * It does not hold the age of the message; the caller weighs that.
 */
export interface RankedMessage {
  readonly messageKey: number;
  readonly threadId: string;
  readonly accountId: string;
  readonly relevance: number;
  readonly via: "text" | "file";
  /**
   * Who the message came from, for the flood control of ADR 0081 (all absent on an adapter that
   * does not know). Lowercase address of the sender.
   */
  readonly sender?: string;
  /** The message is in the person's Sent mail. */
  readonly fromMe?: boolean;
  /** By its headers; absent: not known (mail stored before the field existed). */
  readonly automated?: boolean;
  /** How many messages of the index name the sender (the people index); 0: not known. */
  readonly senderMessages?: number;
  /** First address of `Reply-To`, lowercase, when it differs from the sender (mail relayed by a service). */
  readonly replyTo?: string;
  /** Whether the sender authentication passed; `fail` is never raised by a Reply-To. */
  readonly senderAuth?: "pass" | "fail" | "unknown";
}

/**
 * The search the agent uses (ADR 0080): ranked by relevance, not newest first, and made for
 * recall. The person's own search bar does not use it. Differences from `SearchIndexPort.search`:
 * words in the query are ANDed as prefixes (a dotted or hyphenated word is its parts, ANDed),
 * the names of files received join the matches when the query is plain words, and the best
 * `limit` messages come back whatever their age. `accountIds` narrows to those accounts. Trash and Spam are left out unless asked for.
 */
export interface RankedSearchPort {
  searchRanked(
    query: ParsedQuery,
    options: {
      readonly limit: number;
      readonly accountIds?: readonly string[];
      /**
       * ADR 0081: points of bm25 by which mail the headers call automated sorts lower, and the
       * person's own Sent mail higher, before the best `limit` are chosen, so that a flood of
       * programs cannot fill the window. `relevance` stays the plain bm25.
       */
      readonly automatedPenalty?: number;
      readonly ownBoost?: number;
    },
  ): Promise<readonly RankedMessage[]>;
}

/** A person seen in the mail: the latest name known for an address and how often it appears. */
export interface PersonSuggestion {
  /** Lowercased. */
  readonly address: string;
  readonly name?: string;
  /** Messages that named the address as sender, recipient or cc. A hint, see ADR 0028. */
  readonly count: number;
}

/**
 * People for query suggestions (ADR 0028). The adapter folds `prefix` itself (`tokenize`):
 * the first word is a prefix of a word of the name or the address, every further word is a
 * prefix of another one. Input with no word gives nothing. Only people the index still holds
 * mail for are returned, most messages first, then latest message first.
 */
export interface PeoplePort {
  suggest(prefix: string, limit: number): Promise<readonly PersonSuggestion[]>;
  /** The same ranking with nothing typed yet (ADR 0029). */
  frequent(limit: number): Promise<readonly PersonSuggestion[]>;
}

/**
 * Files received in mail, found by name (ADR 0074). `text` is what the person typed, already
 * trimmed and never blank; the adapter folds it itself (`foldText`): lowercase, no diacritics.
 * A file matches when its name contains the text anywhere, after separators too; with one or two
 * characters only the start of the name or of a word in it counts. Newest message first, the
 * same name in the same thread once (the newest), at most `limit`. Mail in Trash and Spam is
 * left out. `accountId` narrows to one account.
 */
export interface FilesPort {
  searchFiles(text: string, limit: number, accountId?: string): Promise<readonly FileHit[]>;
}

/**
 * Makes everything done through the write ports inside `work` commit together or not at all.
 * An error thrown by `work` rolls everything back and is rethrown.
 *
 * - Units are serialized: a `run` started while another is open waits for it.
 * - A `run` called from inside `work` (same async call chain) joins the outer unit flat: it
 *   adds no boundary of its own, so an error it throws only rolls back if it reaches the outer
 *   `work` uncaught. Do not start nested units concurrently with each other.
 * - Reads through the read paths of an adapter that uses a separate reader see a unit's writes
 *   only after it committed.
 */
export interface UnitOfWorkPort {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface CursorPort {
  get(accountId: string, folderId: string): Promise<SyncCursor | null>;
  set(accountId: string, folderId: string, cursor: SyncCursor): Promise<void>;
  /** Forgets every folder cursor of the account. */
  deleteAccount(accountId: string): Promise<void>;
}

/**
 * What arrived, by the order the server gave it (ADR 0106, rule 1). A folder's mark comes from
 * its sync cursor, which is committed with the mail it covers.
 */
export interface ArrivalPort {
  /** The mark of every folder whose cursor names its UIDVALIDITY and highest synced UID. */
  marks(): Promise<readonly ArrivalMark[]>;
  /** Keys of the unread messages with a location in these spans, newest key first, at most `limit`. */
  unreadIn(spans: readonly ArrivalSpan[], limit: number): Promise<readonly number[]>;
}

/**
 * The send queue (ADR 0020). One record per `SendOperation`; the state machine lives in the
 * domain, the port only stores it. The built MIME is kept apart so listings stay small.
 */
export interface OutboxPort {
  enqueue(operation: SendOperation): Promise<void>;
  get(id: string): Promise<SendOperation | null>;
  /** Replaces the record with this id; the stored MIME is not touched. Unknown ids are skipped. */
  update(operation: SendOperation): Promise<void>;
  /**
   * Atomically starts the earliest pending operation of this lane whose `notBeforeMs` has come
   * (as `startSend` does) and returns it; null when none can start. An operation whose draft has
   * a file still `reading` is skipped, and in the large lane so is any account that already has
   * a large operation running (ADR 0041, rules 7 and 11).
   */
  claimNext(nowMs: number, lane: SendLane): Promise<SendOperation | null>;
  /**
   * `notBeforeMs` of the earliest pending operation of this lane; null when none is pending.
   * One waiting for a file to be read is not counted: the file's end wakes the runner instead.
   */
  nextDueMs(lane: SendLane): Promise<number | null>;
  /** Operations in one of these states, oldest first. */
  listByState(kinds: readonly SendStateKind[]): Promise<readonly SendOperation[]>;
  /**
   * What the UI shows: every active operation, and succeeded or voided ones updated at or after
   * `finishedSinceMs`. Cancelled operations never appear. Oldest first.
   */
  listVisible(finishedSinceMs: number): Promise<readonly SendOperation[]>;
  /** Operations of one draft that are not finished (pending, held, running, failed, unknown). */
  activeForDraft(draftId: string): Promise<readonly SendOperation[]>;
  /** Stores the message as built, together with its `Message-ID`; every attempt sends these bytes. */
  setMime(id: string, messageId: string, mime: Uint8Array): Promise<void>;
  getMime(id: string): Promise<Uint8Array | null>;
  /**
   * The same for a message too large to keep in the database: it is a file on disk, written
   * before this call (ADR 0041, rule 9). `bytes` is its size.
   */
  setSpool(id: string, messageId: string, path: string, bytes: number): Promise<void>;
  getSpool(id: string): Promise<{ readonly path: string; readonly bytes: number } | null>;
  /** Deletes finished operations (succeeded, voided, cancelled) last updated before this time. */
  pruneFinished(beforeMs: number): Promise<number>;
  /** Drops every entry of the account, whatever its state. */
  discardAccount(accountId: string): Promise<void>;
}

/**
 * Requests to set or clear `\Seen` that the server does not have yet (ADR 0039). A table of its
 * own, separate from the send queue: one row per message, the latest request wins, and nothing
 * here is ever sent twice with a different meaning.
 */
export interface FlagOutboxPort {
  /**
   * Inserts the request, or replaces the message's earlier one: then the wanted state, the
   * revision and the time change, attempts start again and `previousSeen` stays what it was.
   */
  put(intents: readonly NewSeenIntent[]): Promise<void>;
  /** Every request of the account, or of all accounts without an id. */
  listPending(accountId?: string): Promise<readonly SeenIntent[]>;
  /** Requests whose time has come, earliest first. */
  listDue(nowMs: number, limit: number): Promise<readonly SeenIntent[]>;
  /** `nextAttemptMs` of the earliest request; null when none waits. */
  nextDueMs(): Promise<number | null>;
  /**
   * Deletes the requests that are still the revision given: one replaced meanwhile stays.
   * Returns the ones deleted.
   */
  settle(intents: readonly SeenIntent[]): Promise<readonly SeenIntent[]>;
  /** For requests still at the revision given: one more attempt counted, the next at this time. */
  defer(
    entries: readonly { readonly intent: SeenIntent; readonly nextAttemptMs: number }[],
  ): Promise<void>;
  /** Drops every request of the account. */
  discardAccount(accountId: string): Promise<void>;
}

/**
 * Moves the server does not have yet (ADR 0044, rule 8), shaped like `FlagOutboxPort`: one row per
 * message, the latest request wins and keeps the first "before". A row is not due until the undo
 * window is over, which is also what makes a late undo detectable.
 */
export interface MoveOutboxPort {
  /**
   * Inserts the requests, or replaces a message's earlier one: then the operation, action, target,
   * revision and time change, attempts start again and the "before" stays what it was.
   */
  put(operations: readonly NewMoveOperation[]): Promise<void>;
  /** Every operation of the account, or of all accounts without an id. */
  listPending(accountId?: string): Promise<readonly MoveOperation[]>;
  /** Operations whose time has come, earliest first. */
  listDue(nowMs: number, limit: number): Promise<readonly MoveOperation[]>;
  /** `nextAttemptMs` of the earliest operation; null when none waits. */
  nextDueMs(): Promise<number | null>;
  /**
   * Takes an action back: deletes its rows if all of them are still inside the window (not due,
   * not tried) and returns them. When any row is past it nothing is deleted and `late` is set;
   * rows replaced by a newer action are no longer the action's.
   */
  cancel(
    operationId: string,
    nowMs: number,
  ): Promise<{ readonly removed: readonly MoveOperation[]; readonly late: boolean }>;
  /**
   * Deletes the operations that are still the revision given: one replaced meanwhile stays.
   * Returns the ones deleted.
   */
  settle(operations: readonly MoveOperation[]): Promise<readonly MoveOperation[]>;
  /** For operations still at the revision given: one more attempt counted, the next at this time. */
  defer(
    entries: readonly { readonly operation: MoveOperation; readonly nextAttemptMs: number }[],
  ): Promise<void>;
  /** Drops every operation of the account. */
  discardAccount(accountId: string): Promise<void>;
}

/** Drafts being written (ADR 0020). */
export interface DraftStorePort {
  get(id: string): Promise<Draft | null>;
  /** Inserts or replaces by id. */
  put(draft: Draft): Promise<void>;
  /** Returns whether the draft existed. */
  delete(id: string): Promise<boolean>;
  /** Most recently changed first. */
  list(): Promise<readonly Draft[]>;
  /** The draft answering this thread, if one is in progress. */
  findByThread(accountId: string, threadId: string): Promise<Draft | null>;
  discardAccount(accountId: string): Promise<void>;
}

/** Saved views (ADR 0027). */
export interface SavedViewStorePort {
  /** By position, then creation time, then id. */
  list(): Promise<readonly SavedView[]>;
  get(id: string): Promise<SavedView | null>;
  /** Inserts or replaces by id. */
  put(view: SavedView): Promise<void>;
  /** Returns whether the view existed. Its recent searches go with it. */
  remove(id: string): Promise<boolean>;
  /** The view's searches, latest first (ADR 0030). `viewId` need not be stored: `All mail` is not. */
  recentSearches(viewId: string): Promise<readonly string[]>;
  /** Puts the query first, and forgets what falls past `MAX_RECENT_SEARCHES`. */
  noteSearch(viewId: string, query: string, atMs: number): Promise<void>;
  forgetSearch(viewId: string, query: string): Promise<void>;
  clearSearches(viewId: string): Promise<void>;
  /** Gives `ids[i]` the position `i`, all or nothing; ids that do not exist are skipped. */
  setPositions(ids: readonly string[]): Promise<void>;
}

/**
 * Image rules and the general setting (ADR 0037). Global to the computer: they belong to no
 * account, do not sync and are not part of the change log.
 */
export interface ImageRuleStorePort {
  /** One rule by its unique key; null when there is none. */
  get(scope: ImageRuleScope, value: string): Promise<ImageRule | null>;
  /** Newest first, then by scope and value. */
  list(): Promise<readonly ImageRule[]>;
  /** Inserts or replaces by scope and value. */
  put(rule: ImageRule): Promise<void>;
  /** Inserts the rules whose scope and value are not taken; returns how many went in. */
  putIfAbsent(rules: readonly ImageRule[]): Promise<number>;
  /** Returns whether the rule existed. */
  remove(scope: ImageRuleScope, value: string): Promise<boolean>;
  /** `ask` until set. */
  getGeneral(): Promise<GeneralImages>;
  setGeneral(value: GeneralImages): Promise<void>;
}

export interface SubmitEnvelope {
  /** Address of the sender (SMTP MAIL FROM). */
  readonly from: string;
  /** To, Cc and Bcc together (SMTP RCPT TO). */
  readonly recipients: readonly string[];
  /** Bytes of the message. Sent with MAIL FROM, so a server that will refuse says so before the data. */
  readonly size?: number;
}

/** A message to send, read when the server asks for it and not before (ADR 0041, rule 9). */
export interface MimeSource {
  readonly size: number;
  open(): AsyncIterable<Uint8Array>;
}

/** What a caller wants to know of a submission while it runs, and how it can cut it short. */
export interface SubmitWatch {
  /**
   * Closes the connection when it fires before the end of the data and the submission answers
   * `aborted`. Once the data has ended it is ignored: the answer is awaited (ADR 0041, rule 15).
   */
  readonly signal?: AbortSignal;
  /** Bytes of the message handed to the connection so far. Called often; the caller throttles. */
  onProgress?(sentBytes: number, totalBytes: number): void;
  /**
   * Awaited just before the last byte is handed over (ADR 0041, rule 13). If it throws, nothing
   * more is sent and the submission is `rejected`.
   */
  beforeDataEnd?(): Promise<void>;
  /** What the server announced as its largest message (`SIZE`); null when it announced none. */
  onServerLimit?(bytes: number | null): void;
}

/**
 * How the server answered a submission. `rejected` is definite: the message was not accepted
 * (5xx or 4xx reply, login refused, refused before the message data), a retry is safe.
 * `unknown`: the connection broke or timed out after the message data was sent, so the server
 * may or may not have accepted it.
 */
export type SubmitResult =
  | {
      readonly kind: "accepted";
      readonly response: string;
      /** Recipients the server refused while taking the message for the others. */
      readonly refused?: readonly string[];
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly code?: number;
      /** The message is larger than the server takes; a retry would be refused the same way. */
      readonly tooLarge?: boolean;
    }
  | { readonly kind: "unknown"; readonly reason: string }
  /** The connection was lost before the data ended, so nothing was delivered. */
  | { readonly kind: "interrupted"; readonly reason: string }
  /** `watch.signal` fired before the data ended. */
  | { readonly kind: "aborted" };

export type OutgoingCheck =
  | {
      readonly ok: true;
      /** What the server announced as its largest message; null when it announced none. */
      readonly limitBytes?: number | null;
    }
  | {
      readonly ok: false;
      readonly kind: "auth" | "tls" | "unreachable" | "other";
      readonly reason: string;
      /** What the server's answer told (ADR 0114); its text is for showing, not for `reason`. */
      readonly detail?: FailureDetail;
    };

export interface MailSubmitPort {
  /** Never throws for server or network trouble; errors never contain the password. */
  submit(
    target: MailTarget,
    envelope: SubmitEnvelope,
    source: MimeSource,
    watch?: SubmitWatch,
  ): Promise<SubmitResult>;
  /** Connects and logs in without sending anything. Same promises as `submit`. */
  verify(target: MailTarget): Promise<OutgoingCheck>;
}

export interface ComposeInput {
  readonly from: Participant;
  readonly to: readonly Participant[];
  readonly cc: readonly Participant[];
  readonly subject: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
  readonly html: string;
  readonly text: string;
  readonly dateMs: number;
}

export interface ComposedMessage {
  readonly raw: Uint8Array;
  /** `<uuid@sender-domain>`, with angle brackets. */
  readonly messageId: string;
}

/** Builds the MIME message. Bcc is not a header: the envelope carries it. */
export interface MessageComposerPort {
  compose(input: ComposeInput): Promise<ComposedMessage>;
}

export interface RenderedMessage {
  readonly html: string;
  /** The Markdown source. */
  readonly text: string;
}

/** Markdown to the HTML part of a message. The same function serves the preview. */
export interface ComposeRendererPort {
  render(markdown: string): RenderedMessage;
}

export interface SentCopy {
  /** The provider id sync will compute for this very message (ADR 0016). */
  readonly providerId: string;
  readonly location: MessageLocation;
}

export interface SentMatch {
  /** Provider id of the message found. */
  readonly providerId: string;
  /** Where it is, when the search was in the Sent folder itself (not Gmail's All Mail). */
  readonly location?: MessageLocation;
}

/** The mailbox's Sent folder. Works on the connection it came from. */
export interface SentFolderPort {
  /** Appends the raw message to the Sent folder, marked as read. Throws when there is none. */
  append(account: Account, raw: Uint8Array): Promise<SentCopy>;
  /** Looks for a message by `Message-ID` (with angle brackets); null when it is not there. */
  findByMessageId(account: Account, messageId: string): Promise<SentMatch | null>;
}

export type Credential =
  | { readonly kind: "password"; readonly username: string; readonly password: string }
  | {
      readonly kind: "oauth2";
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresAtMs?: number;
    };

export type CredentialAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface CredentialPort {
  /** Whether secrets can be stored safely here; `set` refuses (and says why) when they cannot. */
  availability(): Promise<CredentialAvailability>;
  get(accountId: string): Promise<Credential | null>;
  set(accountId: string, credential: Credential): Promise<void>;
  delete(accountId: string): Promise<void>;
}

/** Accounts the user added (ADR 0018). Secrets never pass through this port. */
export interface AccountStorePort {
  list(): Promise<readonly StoredAccount[]>;
  get(id: string): Promise<StoredAccount | null>;
  /** Rejects with `AccountExistsError` when the id or the address (any case) is taken. */
  add(account: StoredAccount): Promise<void>;
  /** Returns whether the account existed. */
  remove(id: string): Promise<boolean>;
  /** Keeps what the outgoing server last announced as its largest message; null forgets it. */
  setMessageLimit(accountId: string, bytes: number | null): Promise<void>;
}

/**
 * Finds the servers of an email domain. Only the domain is ever passed in: never an address,
 * never a password.
 */
export interface ServerDiscoveryPort {
  /** Null when no source knew the domain (the user then types the settings). */
  discover(domain: string): Promise<DiscoveredServers | null>;
}

export interface MailTarget {
  readonly server: MailServerSettings;
  readonly credential: Credential;
}

/** How the server took the flag at one copy of a message. */
export type FlagOutcome =
  /** The flag is set (or cleared) there. */
  | "done"
  /** The copy is gone or the folder was rebuilt (UIDVALIDITY): sync will tell what is there now. */
  | "stale"
  /** The server refused (read-only folder, no permission): a retry will not help. */
  | "rejected";

export interface FlagResult {
  readonly location: MessageLocation;
  readonly outcome: FlagOutcome;
}

/**
 * Writes flags to the server (ADR 0039). Works on the connection it came from. A server that
 * says no is an outcome; trouble with the connection throws an error with a `kind`
 * (`mailErrorKind`) and never contains the password, and a repeat is safe.
 */
export interface MailFlagsPort {
  /** One result per location, in input order. */
  setSeen(locations: readonly MessageLocation[], seen: boolean): Promise<readonly FlagResult[]>;
}

/** How the server took the move of one copy of a message. */
export type MoveOutcome =
  /** The copy is in the target now. `location` is where, when the server said (`uidMap`, rule 13). */
  | { readonly kind: "moved"; readonly location?: MessageLocation }
  /** The copy is gone or the folder was rebuilt (UIDVALIDITY): sync will tell what is there now. */
  | { readonly kind: "stale" }
  /** The server refused (no permission, quota, a folder that cannot be made): a retry will not help. */
  | { readonly kind: "rejected" };

export interface MoveResult {
  readonly location: MessageLocation;
  readonly outcome: MoveOutcome;
}

/** How the server took the removal of one copy. */
export type ExpungeOutcome = "done" | "stale" | "rejected";

export interface ExpungeResult {
  readonly location: MessageLocation;
  readonly outcome: ExpungeOutcome;
}

/**
 * Moves mail on the server (ADR 0044, rule 13). Works on the connection it came from. A server
 * that says no is an outcome; trouble with the connection throws an error with a `kind`
 * (`mailErrorKind`) and never contains the password, and a repeat is safe. All the locations of
 * one call are of one account.
 */
export interface MailMovePort {
  /**
   * Puts these copies in the target: `MOVE` (or `COPY` and expunge), or, where labels are the
   * places, the label changes that mean the same. A missing Archive, Trash or Junk folder is made
   * first (rule 14). One result per location, in input order.
   */
  move(
    locations: readonly MessageLocation[],
    action: MoveAction,
    target: MoveTarget,
  ): Promise<readonly MoveResult[]>;
  /**
   * Deletes these copies for good (`\Deleted` and `UID EXPUNGE`), and only in a folder that is the
   * account's Trash: anywhere else the answer is `rejected` without a command (rule 16).
   */
  expunge(locations: readonly MessageLocation[]): Promise<readonly ExpungeResult[]>;
}

/** One part of a message, opened as a stream of its decoded bytes (ADR 0043, rule 6). */
export type PartDownload =
  | {
      readonly kind: "found";
      /**
       * Decoded bytes, read as fast as the consumer takes them. Ends the download when finished or
       * abandoned, so the caller need not close anything else.
       */
      readonly content: AsyncIterable<Uint8Array>;
    }
  /** The message or the folder is not there any more, or the folder was rebuilt. Definite. */
  | { readonly kind: "gone" };

/**
 * Fetches the file parts of messages the server holds (ADR 0043). Works on the connection it came
 * from, so a download that takes minutes never holds up a sync. It reads without marking the
 * message as read. Trouble with the connection throws an error with a `kind` (`mailErrorKind`),
 * never containing the password.
 */
export interface MailAttachmentPort {
  download(location: MessageLocation, partId: string, signal?: AbortSignal): Promise<PartDownload>;
}

/** A logged-in connection for syncing. Always `close()` it. */
export interface MailConnection {
  readonly sync: MailSyncPort;
  readonly sent: SentFolderPort;
  readonly flags: MailFlagsPort;
  readonly moves: MailMovePort;
  readonly attachments: MailAttachmentPort;
  close(): Promise<void>;
  /** Drops the connection now: whatever is waiting on it fails. Still call `close()`. */
  abort(): void;
}

export interface MailWatchHandlers {
  /** The inbox changed on the server: new, flagged or removed mail. */
  onChange(): void;
  /** The connection ended (error given when it was not asked for); `close()` was not called. */
  onClosed(error?: unknown): void;
}

export interface MailWatch {
  close(): Promise<void>;
}

/**
 * Opens connections to an account's mail server. Failures carry a `kind`
 * (`mailErrorKind`) and never contain the password.
 */
export interface MailConnectorPort {
  connect(target: MailTarget): Promise<MailConnection>;
  /** A dedicated connection that waits on the inbox (IMAP IDLE) and reports changes. */
  watchInbox(target: MailTarget, handlers: MailWatchHandlers): Promise<MailWatch>;
}

/** What a carrier needs to know while it carries one file (ADR 0040, rule 5). */
export interface CarryContext {
  readonly accountId: string;
  readonly operationId: string;
  readonly signal?: AbortSignal;
}

/** A file a carrier keeps for us, and what the composer tells the sender about it (rule 11). */
export interface CarriedFile {
  readonly attachmentId: string;
  readonly url: string;
  /** Who can open the link, in words: "Anyone with the link". */
  readonly audience: string;
  /** When the link stops working; null when it does not. */
  readonly expiresAtMs: number | null;
}

/**
 * A way to send a file as a link instead of inside the message (ADR 0040). No adapter exists
 * yet; the testkit's fake keeps the seam exercised.
 */
export interface AttachmentCarrierPort extends OfferingCarrier {
  /** Runs at hand-off only. Throws for a definite failure; never leaves a half result. */
  carry(file: StoredAttachment, context: CarryContext): Promise<CarriedFile>;
}

/** The files of drafts (ADR 0041). Rows only: the bytes are the `FileWorkPort`'s. */
export interface AttachmentStorePort {
  /** Inserts the row; an id that exists is refused. */
  add(attachment: StoredAttachment): Promise<void>;
  get(id: string): Promise<StoredAttachment | null>;
  /** In the order they were added. */
  forDraft(draftId: string): Promise<readonly StoredAttachment[]>;
  /**
   * Replaces the row with this id; unknown ids are skipped. It never changes whose the row is: a
   * copy still running writes a row it read earlier, and only `moveDraft` moves one.
   */
  update(attachment: StoredAttachment): Promise<void>;
  /** Every row of the draft now belongs to this account (its sender changed, ADR 0050). */
  moveDraft(draftId: string, accountId: string): Promise<void>;
  /** Deletes these rows; unknown ids are skipped. */
  remove(ids: readonly string[]): Promise<void>;
  /** Oldest first. */
  listByState(states: readonly AttachmentState[]): Promise<readonly StoredAttachment[]>;
  allIds(): Promise<readonly string[]>;
  /** Drops every row of the account. */
  discardAccount(accountId: string): Promise<void>;
}

export interface CaptureJob {
  readonly attachmentId: string;
  readonly sourcePath: string;
}

export interface CaptureResult {
  readonly sha256: string;
  /** Bytes of the stored copy. */
  readonly size: number;
  /** Modification time of the original when it was read. */
  readonly sourceMtimeMs: number;
}

export interface BuiltMessage {
  readonly messageId: string;
  /** Bytes of the message written to the spool. */
  readonly bytes: number;
  readonly spoolPath: string;
}

/**
 * Everything that touches a user's file, behind one boundary: a real one runs in a worker thread
 * so neither the router nor the sync worker waits for a hash (ADR 0041, rule 4); a fake runs
 * inline. Failures are `FileWorkError`s.
 */
export interface FileWorkPort {
  /**
   * Copies the original into the data directory under the attachment's id, hashing as it goes.
   * `onProgress` gets fractions from 0 to 1. Aborting removes the partial copy.
   * Throws `unreadable`, `noSpace` or `isDirectory`.
   */
  capture(
    job: CaptureJob,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<CaptureResult>;
  /**
   * Builds the message with its files into a spool file (temporary name, synced, renamed). Checks
   * every stored copy against its hash first. Throws `missing`, naming the file, when a copy is
   * gone or does not match.
   */
  buildMessage(
    input: ComposeInput,
    files: readonly {
      readonly attachmentId: string;
      readonly name: string;
      readonly sha256: string;
    }[],
    operationId: string,
  ): Promise<BuiltMessage>;
  openSpool(path: string): MimeSource;
  readSpool(path: string): Promise<Uint8Array>;
  /** Size and modification time of an original; null when it is gone. */
  statSource(path: string): Promise<{ readonly mtimeMs: number; readonly size: number } | null>;
  removeAttachments(ids: readonly string[]): Promise<void>;
  removeSpool(path: string): Promise<void>;
  /** Deletes every stored copy and spool that these lists do not name. */
  sweep(keepAttachmentIds: readonly string[], keepSpoolPaths: readonly string[]): Promise<void>;
}

/**
 * Where the files that arrived by mail are kept once someone asked for them (ADR 0043, rules 6
 * and 8). It is a cache: everything here can be fetched again, so losing it costs only time.
 */
export interface ReceivedFilesPort {
  /**
   * Writes the part to `received/<key>/<part>/<name>` through a temporary name and a rename, so
   * a broken download never looks like a file. Backpressure is respected and no more than a chunk
   * is held. `onBytes` gets the running total. Returns the bytes written. On any failure,
   * including an abort, the temporary file is removed and the error is rethrown.
   */
  write(
    messageKey: number,
    partId: string,
    name: string,
    content: AsyncIterable<Uint8Array>,
    onBytes: (written: number) => void,
    signal?: AbortSignal,
  ): Promise<number>;
  /** Whether a finished copy exists; when it does, its use time is set to now. */
  touch(messageKey: number, partId: string): Promise<boolean>;
  /**
   * Where the finished copy is, to be read by a capture (ADR 0045, rule 7); null when there is
   * none. The path goes to the file work and nowhere else. A copy may be swept at any time, so
   * the answer holds only as long as the caller reads it at once.
   */
  locate(messageKey: number, partId: string): Promise<string | null>;
  /** Deletes the copies of these messages. Unknown keys are skipped. */
  removeMessages(keys: readonly number[]): Promise<void>;
  /** Everything the cache holds, partial files included. */
  list(): Promise<readonly CachedFile[]>;
  remove(files: readonly CachedFile[]): Promise<void>;
}

// --- Agents (ADR 0051, 0052) ---

export interface AgentRunRequest {
  /** A model name the runtime listed in `inspect()`. */
  readonly model: string;
  /** Fixed text written by us. Becomes the system prompt. */
  readonly instructions: string;
  /** Text from mail. Data, never instructions; goes where the runtime keeps user input. */
  readonly untrusted: string;
  /** JSON Schema of the answer. */
  readonly schema: unknown;
  /**
   * How hard the runtime should think: one of the levels it listed in `inspect()`. Absent: the
   * runtime's own default. The person sets it per kind of work (ADR 0118); a level the model
   * refuses fails the turn with `effortRefused`, and is never retried at another level.
   */
  readonly effort?: AgentEffort;
  /**
   * Files with no text, sent whole next to `untrusted` (ADR 0090, rule 2). Data like it. Only for a
   * runtime whose `takesFiles` is true; any other refuses the request.
   */
  readonly files?: readonly AgentFile[];
}

/** One file sent whole: the bytes as they came by mail, and the type it goes as. */
export interface AgentFile {
  readonly name: string;
  readonly mediaType: WholeMediaType;
  readonly bytes: Uint8Array;
}

export interface AgentRunResult {
  /** The answer as the runtime parsed it; its shape is not trusted until validated. */
  readonly value: unknown;
  /** The plan's windows as seen during this run, when the runtime reports them. */
  readonly limits?: PlanLimits;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * A program that answers questions on the person's own plan. No tools, no files, no network of
 * its own: it gets text and returns a value. Failures reject with `AgentRunError`.
 */
/**
 * A read-only tool server of ours that one turn may call (ADR 0083). The turn gets these tools and
 * nothing else: no tool of the runtime's own, no other server.
 */
export interface AgentToolServer {
  /** The server's name; the model sees each tool as `mcp__<name>__<tool>`. */
  readonly name: string;
  /** `http://127.0.0.1:<port>/mcp`, open for this turn only. */
  readonly url: string;
  /** A bearer token made for this turn. */
  readonly token: string;
  /** The tools the turn may call, without the `mcp__<name>__` prefix. */
  readonly tools: readonly string[];
}

/** What a turn with tools does while it runs, as the runtime reports it. */
export type AgentTurnEvent =
  /** A line the model wrote between its steps: its own words, not a fact. */
  | { readonly kind: "text"; readonly text: string }
  /** A call of one of the server's tools, as the model asked for it. */
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown };

export interface AgentToolRunOptions {
  readonly signal?: AbortSignal;
  readonly server: AgentToolServer;
  readonly onEvent?: (event: AgentTurnEvent) => void;
  /** How long the whole turn may take; a turn with tools takes longer than a plain one. */
  readonly timeoutMs?: number;
}

export interface AgentRuntimePort {
  readonly id: AgentRuntimeId;
  readonly name: string;
  /** Whether `run` takes `files` (ADR 0090, rule 7). Absent: it does not, and none are sent. */
  readonly takesFiles?: boolean;
  /** What the runtime is on this machine. Does not send mail and spends nothing from the plan. */
  inspect(): Promise<AgentRuntimeInfo>;
  run(
    request: AgentRunRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentRunResult>;
  /**
   * One turn that may call the tools of `options.server` and no others (ADR 0083). Absent on a
   * runtime that cannot: the caller then uses the turns without tools.
   */
  runWithTools?(request: AgentRunRequest, options: AgentToolRunOptions): Promise<AgentRunResult>;
}

/** What agents found and made, kept locally. Batch-shaped, like the other stores. */
export interface AgentInsightStorePort {
  /** Replaces the work prepared for the same thread and last message. */
  putPrepared(records: readonly PreparedRecord[]): Promise<void>;
  getPrepared(threadId: string, lastMessageKey: number): Promise<PreparedRecord | null>;
  /**
   * Appends; feedback is a log, and the newest entry of a kind for a thing is the one that counts.
   * The journal line (ADR 0054, rule 6) is written in the same transaction, so the two never
   * disagree. Without a memo the actor is the person.
   */
  recordFeedback(feedback: ThingFeedback, memo?: JournalMemo): Promise<void>;
  /** In the order recorded. */
  listFeedback(): Promise<readonly ThingFeedback[]>;
  /**
   * Takes back the newest entry of this kind for the thread, if any (the person pressed Undo). In
   * the same transaction the newest journal line of that thread and action that is not undone is
   * marked undone at `atMs` (the store has no clock; default: now). A thread with no such line
   * is left as it was.
   */
  withdrawFeedback(threadId: string, kind: ThingFeedback["kind"], atMs?: number): Promise<void>;
  /** Newest first (by when written), at most `limit`. */
  listJournal(limit: number): Promise<readonly JournalEntry[]>;
  /**
   * Keeps a rule (ADR 0054, rule 7) and writes its journal line, in one transaction. Idempotent: an
   * active rule with the same scope and subject is returned as it is, and no second line is written.
   * The subject is already normalized by the caller.
   */
  addRule(input: AgentRuleInput, atMs: number): Promise<AgentRule>;
  /**
   * Removes the rule and marks its journal line undone at `atMs`, in one transaction. An unknown or
   * already removed id changes nothing. The same scope and subject can be added again later.
   */
  removeRule(id: number, atMs: number): Promise<void>;
  /** Active rules only, in id order. */
  listRules(): Promise<readonly AgentRule[]>;
  /**
   * Keeps an instruction (ADR 0054, rule 7) and writes its journal line, in one transaction.
   * Idempotent: an active one with the same scope, thread and text is returned as it is, and no
   * second line is written. The text is already trimmed and bounded by the caller.
   */
  addInstruction(input: AgentInstructionInput, atMs: number): Promise<AgentInstruction>;
  /**
   * Removes the instruction and marks its journal line undone at `atMs`, in one transaction. An
   * unknown or already removed id changes nothing.
   */
  removeInstruction(id: number, atMs: number): Promise<void>;
  /** Active instructions only, in id order, thread-scoped ones included. */
  listInstructions(): Promise<readonly AgentInstruction[]>;
  appendLedger(entries: readonly LedgerEntry[]): Promise<void>;
  /** Newest first, at most `limit`. */
  listLedger(limit: number): Promise<readonly LedgerEntry[]>;
  /**
   * Keeps the entries of a talk (ADR 0064, rule 3) in one transaction, in the order given, and
   * returns them with their ids. Ids grow, so a later entry has a larger one.
   */
  appendTalk(entries: readonly NewTalkEntry[]): Promise<readonly TalkEntry[]>;
  /**
   * The newest `limit` entries of the thread's talk, oldest first. `null` is all mail: with
   * `talkId`, that one talk; without it, every entry across all mail. With `beforeId`, only the
   * entries older than that one, for loading upward (ADR 0086, rule 13).
   */
  listTalk(
    threadId: string | null,
    limit: number,
    options?: { readonly talkId?: number; readonly beforeId?: number },
  ): Promise<readonly TalkEntry[]>;
  /**
   * Starts a talk across all mail (ADR 0086). Talks with no entries are removed first, in the same
   * transaction, so there is never more than one empty talk.
   */
  createTalk(atMs: number): Promise<TalkSummary>;
  /** One talk across all mail, or null when there is none of that id. */
  getTalk(id: number): Promise<TalkSummary | null>;
  /** Every talk across all mail, the latest entry first. */
  listTalks(): Promise<readonly TalkSummary[]>;
  /**
   * Names a talk. The model never replaces a name the person gave: then nothing changes and it
   * returns false. An unknown id changes nothing.
   */
  nameTalk(id: number, title: string, by: TalkTitleBy): Promise<boolean>;
  /** Removes the talk and its entries. An unknown id changes nothing. */
  deleteTalk(id: number): Promise<void>;
  /** Removes every talk across all mail and its entries; returns how many talks went. */
  deleteAllTalks(): Promise<number>;
  /**
   * Forgets what was read, prepared, chosen, talked, judged for a prompt (ADR 0116, rule 12) and
   * journaled for these threads, when their mail
   * is removed from the machine. In the talk across all mail, the hits and quotes of these threads go
   * too, and the rest of that talk stays. The ledger stays: it holds counts, never mail. Rules and their journal
   * lines stay too: a rule holds an address and the person's own words, never mail. Instructions of
   * scope `thread` and their journal lines go with the thread; the others stay.
   */
  removeForThreads(threadIds: readonly string[]): Promise<void>;
  /**
   * Keeps the verdicts of one batch of a prompt (ADR 0116, rule 5) in one transaction. Only the
   * newest verdict of a thread for a prompt is kept: one replaces any earlier verdict of the same
   * prompt and thread, whatever its last message or version. Verdicts go with their thread in
   * `removeForThreads`.
   */
  putPromptVerdicts(verdicts: readonly PromptVerdict[]): Promise<void>;
  /**
   * The verdicts of a prompt for these threads as they stand now: of this version and at the
   * `lastMessageKey` given. A thread with a newer message has none (rule 5). In no particular order.
   */
  getPromptVerdicts(
    promptKey: string,
    version: number,
    threads: readonly { readonly threadId: string; readonly lastMessageKey: number }[],
  ): Promise<readonly PromptVerdict[]>;
  /**
   * Drops every verdict of each prompt not in `keep` (the prompts saved views hold) whose newest
   * verdict was made before `beforeMs` (ADR 0116, rule 12), and the kept searches of a prompt not
   * in `keep` made before `beforeMs` that no verdict is left for. Returns how many verdicts went.
   */
  prunePromptVerdicts(keep: readonly string[], beforeMs: number): Promise<number>;
  /**
   * Keeps what the search of a prompt wrote (ADR 0116, rule 4), under the prompt and the mail
   * filters: it replaces an earlier search of the same pair. A thread removed in
   * `removeForThreads` leaves its `threadIds`.
   */
  putPromptSearch(search: PromptSearch): Promise<void>;
  /** The kept search of a prompt with these mail filters, or null when it never ran. */
  getPromptSearch(promptKey: string, filters: string): Promise<PromptSearch | null>;
}

/** The person's choices about agents and their consent, kept locally (ADR 0051, rule 6). */
export interface AgentSettingsPort {
  /** The stored settings; the defaults (AI off) when nothing was stored. */
  get(): Promise<AgentSettings>;
  /**
   * Changes these fields only; `limits` and `usedWeekResetsAtMs` can be cleared with `null`.
   * `models` and `efforts` are kept per runtime, as `patchAgentSettings` says (ADR 0119, rule 4).
   */
  update(patch: AgentSettingsPatch): Promise<AgentSettings>;
  /** Idempotent: granting again keeps the first time. */
  grantConsent(accountId: string, runtimeId: AgentRuntimeId, atMs: number): Promise<void>;
  /** Without `runtimeId`, every runtime of that account. Unknown pairs are skipped. */
  revokeConsent(accountId: string, runtimeId?: AgentRuntimeId): Promise<void>;
  /** Ordered by account, then runtime. */
  listConsents(): Promise<readonly AgentConsent[]>;
  getRuntimeRecord(runtimeId: AgentRuntimeId): Promise<AgentRuntimeRecord | null>;
  putRuntimeRecord(record: AgentRuntimeRecord): Promise<void>;
}

/**
 * What the agent read from attached files (ADR 0087, rule 6): a copy of text that is on the
 * server, so losing it costs only the time to read the file again. Rows go with their message.
 */
export interface FileTextPort {
  get(messageKey: number, partId: string): Promise<KeptFileText | null>;
  /** Keeps the text of a part, replacing an earlier one. */
  put(messageKey: number, partId: string, kept: KeptFileText): Promise<void>;
  /** Empties it (Settings › Storage). Returns how many rows went. */
  clear(): Promise<number>;
  count(): Promise<number>;
}

/**
 * Reads the text of a file on disk, on the file work thread and nowhere else (ADR 0087, rule 3).
 * The path goes to the thread and no further; what comes back is text.
 */
export interface FileTextExtractorPort {
  extractText(job: {
    readonly sourcePath: string;
    readonly kind: ReadableKind;
  }): Promise<ExtractedText>;
}
