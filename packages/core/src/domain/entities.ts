/** What a provider adapter can do. Use cases branch on these, never on provider names (ADR 0004). */
export type ProviderCapability =
  | "threads"
  | "labels"
  | "push"
  | "serverSearch"
  | "condstore"
  | "qresync"
  | "compress"
  | "objectId"
  /** The provider keeps a copy of sent mail itself (Gmail): no APPEND, reconcile by search. */
  | "savesSent";

export interface Account {
  readonly id: string;
  readonly address: string;
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];
}

export type LabelRole = "inbox" | "sent" | "drafts" | "trash" | "spam" | "archive" | "other";

/** Everything is a label; an IMAP folder is an exclusive label (ADR 0014). */
export interface Label {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly role: LabelRole;
  readonly exclusive: boolean;
}

/**
 * One copy of a message in one folder at one UIDVALIDITY (ADR 0016). `uidValidity` is a decimal
 * string: IMAP allows 32 bits and the adapter boundary turns bigint into text.
 */
export interface MessageLocation {
  readonly accountId: string;
  readonly folderId: string;
  readonly uidValidity: string;
  readonly uid: number;
}

export interface Participant {
  readonly name?: string;
  readonly address: string;
}

export interface MessageFlags {
  readonly seen: boolean;
  readonly flagged: boolean;
  readonly answered: boolean;
  readonly draft: boolean;
}

/**
 * Whether the receiving server authenticated the sender (ADR 0037), read from the topmost
 * `Authentication-Results` header when parsing. `unknown` also covers mail from before the
 * verdict was kept.
 */
export type SenderAuth = "pass" | "fail" | "unknown";

export interface Message {
  /** Chronological key, see `messageKey`. */
  readonly key: number;
  readonly accountId: string;
  /** Provider-side identity; with `accountId` it identifies the message (ADR 0014). */
  readonly providerId: string;
  readonly threadId: string;
  readonly messageIdHeader: string;
  /**
   * The ids the message points to: `References`, then `In-Reply-To` (ADR 0091). The store joins a
   * local thread to the threads they reach. Absent when not read; empty when there are none.
   */
  readonly parentIds?: readonly string[];
  readonly dateMs: number;
  readonly from: Participant;
  readonly to: readonly Participant[];
  readonly cc: readonly Participant[];
  readonly subject: string;
  readonly snippet: string;
  readonly flags: MessageFlags;
  readonly labelIds: readonly string[];
  readonly hasAttachments: boolean;
  readonly senderAuth: SenderAuth;
  /**
   * The addresses of the `Reply-To` header (ADR 0042). Absent: not known yet (mail stored before
   * the field existed, until a sync asks the server). Empty: none, or the same as `from`.
   */
  readonly replyTo?: readonly Participant[];
  /**
   * The message came from a list or a program (ADR 0052, rule 4), by its headers. Absent: not
   * known (mail stored before the field existed, until a re-parse); it counts as not automated.
   */
  readonly automated?: boolean;
  /**
   * Where the message is, as a bit set of roles (`MAILBOX_BIT`, ADR 0044). Set by the store; absent
   * on a message that has not been stored yet.
   */
  readonly mailboxes?: number;
}

/** `designed`: laid out like a page, shown as sent. `simple`: written by a person, shown as a letter. */
export type HtmlKind = "simple" | "designed";

/** A message plus the plain text that feeds the search index. */
export interface MessageDocument {
  readonly message: Message;
  readonly bodyText: string;
  readonly bodyHtml?: string;
  readonly htmlKind?: HtmlKind;
}

export interface Thread {
  readonly id: string;
  readonly accountId: string;
  readonly subject: string;
  /** Ascending. */
  readonly messageKeys: readonly number[];
  readonly lastMessageKey: number;
  readonly labelIds: readonly string[];
  readonly unreadCount: number;
}
