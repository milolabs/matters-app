import type {
  Message,
  MessageDocument,
  MessageLocation,
  Participant,
  SyncBatch,
  SyncedDocument,
} from "@matters/core";
import { computeMailboxes, messageKey } from "@matters/core";

export function person(name: string, address: string): Participant {
  return { name, address };
}

export type MessageOverrides = Partial<Message> & { readonly seq?: number };

let counter = 0;

/** A complete message; override only what the test cares about. */
export function makeMessage(overrides: MessageOverrides = {}): Message {
  const n = ++counter;
  const { seq, ...rest } = overrides;
  const dateMs = rest.dateMs ?? Date.UTC(2024, 0, 1) + n * 60_000;
  const providerId = rest.providerId ?? `p${n}`;
  return {
    key: messageKey(dateMs, seq ?? 0),
    accountId: "acc1",
    providerId,
    threadId: `t-${providerId}`,
    messageIdHeader: `<${providerId}@example.com>`,
    dateMs,
    from: person("Sender", "sender@example.com"),
    to: [person("Me", "me@example.com")],
    cc: [],
    subject: `Subject ${n}`,
    snippet: "",
    flags: { seen: false, flagged: false, answered: false, draft: false },
    labelIds: ["inbox"],
    hasAttachments: false,
    senderAuth: "unknown",
    ...rest,
  };
}

/**
 * The message as a store hands it back: with the mailboxes it sets itself (ADR 0044), which for a
 * message in no known folder come from its labels alone.
 */
export function asStored(m: Message): Message {
  return { ...m, mailboxes: computeMailboxes(m.labelIds, undefined, []) };
}

export function makeDocument(overrides: MessageOverrides = {}, bodyText = ""): MessageDocument {
  return { message: makeMessage(overrides), bodyText };
}

export function makeLocation(
  uid: number,
  folderId = "INBOX",
  uidValidity = "1",
  accountId = "acc1",
): MessageLocation {
  return { accountId, folderId, uidValidity, uid };
}

/** A document found at a location (default: INBOX, UIDVALIDITY 1, account acc1). */
export function syncedDoc(
  document: MessageDocument,
  uid: number,
  folderId = "INBOX",
  uidValidity = "1",
): SyncedDocument {
  return {
    document,
    location: makeLocation(uid, folderId, uidValidity, document.message.accountId),
  };
}

/** A batch with every list empty unless given. */
export function makeSyncBatch(overrides: Partial<SyncBatch> = {}): SyncBatch {
  return {
    documents: [],
    knownLocations: [],
    flagUpdates: [],
    removedLocations: [],
    cursor: { uid: 0 },
    ...overrides,
  };
}
