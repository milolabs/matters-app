import type { LabelRole } from "./entities.ts";
import { foldText } from "./text.ts";

/**
 * Where a message is, as a bit set of roles (ADR 0044, rule 2). Stored beside the labels so that
 * "not in Trash or Spam" is one test of one integer, and an index can answer it.
 */
export const MAILBOX_BIT: Readonly<Record<LabelRole, number>> = {
  inbox: 1,
  sent: 2,
  drafts: 4,
  trash: 8,
  spam: 16,
  archive: 32,
  other: 64,
};

/** A message with any of these bits is left out of `All mail` and of every query that does not ask. */
export const HIDDEN_MAILBOXES = MAILBOX_BIT.trash | MAILBOX_BIT.spam;

/** Roles a person can name with `in:` (`other` is every folder that has no role). */
export const NAMED_ROLES = ["inbox", "archive", "sent", "drafts", "trash", "spam"] as const;
export type NamedRole = (typeof NAMED_ROLES)[number];

export const mailboxBits = (roles: Iterable<LabelRole>): number => {
  let bits = 0;
  for (const role of roles) bits |= MAILBOX_BIT[role];
  return bits;
};

export const hasRole = (bits: number, role: LabelRole): boolean => (bits & MAILBOX_BIT[role]) !== 0;

/** In Trash or Spam: not shown unless asked for. */
export const isHiddenMailbox = (bits: number): boolean => (bits & HIDDEN_MAILBOXES) !== 0;

/**
 * What the system labels of a provider that keeps labels (Gmail) and of a store that has not
 * heard of the account's folders yet are called. Folded.
 */
const SYSTEM_LABELS: Readonly<Record<string, LabelRole>> = {
  inbox: "inbox",
  sent: "sent",
  draft: "drafts",
  drafts: "drafts",
  trash: "trash",
  spam: "spam",
};

/** The role a label stands for: its folder's, else a system label's, else `other`. */
export function roleOfLabel(
  labelId: string,
  folderRoles: ReadonlyMap<string, LabelRole> | undefined,
): LabelRole {
  return folderRoles?.get(labelId) ?? SYSTEM_LABELS[foldText(labelId)] ?? "other";
}

/** A copy of the message on the server, as far as its mailboxes are concerned. */
export interface PlaceOfCopy {
  readonly role: LabelRole;
  /** The folder holds one place for a message (IMAP). A label-style folder (Gmail's All Mail) does not. */
  readonly exclusive: boolean;
}

/**
 * The mailboxes of a message from its labels and the folders its copies are in (ADR 0044,
 * rule 2). Where folders are the places (IMAP), the labels are the folders and say it all. Where
 * labels are (Gmail), Trash and Spam are folders of the copy, and All Mail counts as `archive`
 * only for a message without the inbox label.
 */
export function computeMailboxes(
  labelIds: readonly string[],
  folderRoles: ReadonlyMap<string, LabelRole> | undefined,
  labelCopies: readonly PlaceOfCopy[],
): number {
  let bits = 0;
  let inbox = false;
  for (const label of labelIds) {
    const role = roleOfLabel(label, folderRoles);
    bits |= MAILBOX_BIT[role];
    if (role === "inbox") inbox = true;
  }
  for (const copy of labelCopies) {
    if (copy.role === "trash" || copy.role === "spam") bits |= MAILBOX_BIT[copy.role];
    else if (copy.role === "archive" && !inbox) bits |= MAILBOX_BIT.archive;
  }
  return bits;
}
