import type { QueryNode } from "../usecases/parseQuery.ts";
import type { Label, LabelRole } from "./entities.ts";
import { MAILBOX_BIT, roleOfLabel } from "./mailbox.ts";
import { foldText } from "./text.ts";

/** The four names for moving a thread (ADR 0044, rule 5), and the one that cannot be undone. */
export type MoveAction = "archive" | "delete" | "spam" | "move";
export type MoveKind = MoveAction | "purge";

/** Where a thread goes: a place with a role, or one of the account's folders. */
export type MoveTarget =
  | { readonly role: "inbox" | "archive" | "trash" | "spam" }
  | { readonly folderId: string };

/** The target of each named action; `move` carries its own. */
export function targetOf(action: MoveAction, chosen?: MoveTarget): MoveTarget {
  switch (action) {
    case "archive":
      return { role: "archive" };
    case "delete":
      return { role: "trash" };
    case "spam":
      return { role: "spam" };
    case "move":
      if (chosen === undefined) throw new Error("Move needs a target");
      return chosen;
  }
}

/** Text for a column: `role:archive` or `folder:<id>`. */
export function encodeTarget(target: MoveTarget): string {
  return "role" in target ? `role:${target.role}` : `folder:${target.folderId}`;
}

export function decodeTarget(text: string): MoveTarget | null {
  if (text.startsWith("folder:")) return { folderId: text.slice("folder:".length) };
  const role = text.slice("role:".length);
  return text.startsWith("role:") &&
    (role === "inbox" || role === "archive" || role === "trash" || role === "spam")
    ? { role }
    : null;
}

/** Quiet time before a move goes to the server, and the time ⌘Z has (ADR 0044, rule 10). */
export const MOVE_UNDO_WINDOW_MS = 10_000;
/** The longest wait between two pushes of a move the server could not take yet. */
export const MOVE_BACKOFF_CAP_MS = 5 * 60_000;

/**
 * What the reader asked of one message, kept until the server has it (ADR 0044, rule 8). One per
 * message: a newer request replaces the older one but keeps the first "before", so an undo (or a
 * refusal) goes back to what the server has.
 */
export interface MoveOperation {
  /** Store key of the message. */
  readonly key: number;
  readonly accountId: string;
  /** Shared by every message of one action: what the tray shows and ⌘Z takes back. */
  readonly operationId: string;
  readonly action: MoveKind;
  /** `encodeTarget`; empty for a `purge`. */
  readonly target: string;
  /** The labels and mailboxes before the first request that is still unpushed. */
  readonly labelsBefore: readonly string[];
  readonly mailboxesBefore: number;
  /** Failed pushes so far; drives the backoff. */
  readonly attempts: number;
  readonly nextAttemptMs: number;
  readonly createdAtMs: number;
  /** Grows with every replacement, so a push can tell that a newer request arrived meanwhile. */
  readonly rev: number;
}

/** A request to record; the "before" is kept from the existing operation of the same message. */
export type NewMoveOperation = Omit<MoveOperation, "attempts" | "rev">;

/** What a message holds locally: its labels and its mailboxes. */
export interface Placement {
  readonly labelIds: readonly string[];
  readonly mailboxes: number;
}

/** A target made concrete for one account. */
export interface Place {
  readonly role: LabelRole;
  /** The folder (or, with labels, the label) the message ends up in. */
  readonly id: string;
  readonly name: string;
  /** The account has this folder; if not, the push creates it (rule 14). */
  readonly exists: boolean;
}

/** What a missing Archive, Trash or Junk folder is created as (rule 14). */
const DEFAULT_FOLDER: Readonly<Record<"inbox" | "archive" | "trash" | "spam", string>> = {
  inbox: "INBOX",
  archive: "Archive",
  trash: "Trash",
  spam: "Junk",
};

/** The account's folder for a role: the first by id, so the choice does not move between syncs. */
export function folderOfRole(folders: readonly Label[], role: LabelRole): Label | undefined {
  return folders
    .filter((f) => f.role === role)
    .reduce<Label | undefined>((a, b) => (a === undefined || b.id < a.id ? b : a), undefined);
}

/** True where labels, not folders, say where mail is (Gmail). */
export const labelStyle = (folders: readonly Label[]): boolean => folders.some((f) => !f.exclusive);

export function resolvePlace(folders: readonly Label[], target: MoveTarget): Place {
  if ("folderId" in target) {
    const folder = folders.find((f) => f.id === target.folderId);
    return {
      role: folder?.role ?? "other",
      id: target.folderId,
      name: folder?.name ?? target.folderId,
      exists: folder !== undefined,
    };
  }
  const folder = folderOfRole(folders, target.role);
  if (folder) return { role: target.role, id: folder.id, name: folder.name, exists: true };
  // With labels the inbox is the label of that name and an archive is no folder at all.
  const name = DEFAULT_FOLDER[target.role];
  const id = labelStyle(folders) && target.role === "inbox" ? "inbox" : name;
  return { role: target.role, id, name, exists: false };
}

/** Whether a `label:` value (folded) names this folder, by its id or its name. */
export function folderNamed(folder: Label, folded: string): boolean {
  return foldText(folder.id) === folded || foldText(folder.name) === folded;
}

/** The roles of an account's folders by id, for `roleOfLabel`. */
export function folderRoles(folders: readonly Label[]): ReadonlyMap<string, LabelRole> {
  return new Map(folders.map((f) => [f.id, f.role]));
}

const KEPT = MAILBOX_BIT.sent | MAILBOX_BIT.drafts;
const ALL_MAILBOXES = Object.values(MAILBOX_BIT).reduce((a, b) => a | b, 0);

/**
 * What a message holds after a move, or `null` when there is nothing to move (ADR 0044, rule 5).
 *
 * A move takes the message from every place but Sent and Drafts and puts it in the target; Delete
 * takes it from everything. Messages that are only at the target are left alone. Where folders
 * are the places (IMAP) the labels are those folders, and the result is the kept folders and the
 * target. Where labels are (Gmail) only the inbox label and the Trash and Spam folders are places:
 * the other labels are tags and stay.
 */
export function planMove(
  held: Placement,
  action: MoveAction,
  place: Place,
  folders: readonly Label[],
): Placement | null {
  const roles = folderRoles(folders);
  const kept = action === "delete" ? 0 : KEPT;
  if (labelStyle(folders)) return planWithLabels(held, place, kept, roles);

  const stays = held.labelIds.filter((l) => (MAILBOX_BIT[roleOfLabel(l, roles)] & kept) !== 0);
  const taken = held.labelIds.filter((l) => !stays.includes(l));
  if (taken.length === 0 || taken.every((l) => l === place.id)) return null;
  return {
    labelIds: [...stays, place.id],
    mailboxes: (held.mailboxes & kept) | MAILBOX_BIT[place.role],
  };
}

function planWithLabels(
  held: Placement,
  place: Place,
  kept: number,
  roles: ReadonlyMap<string, LabelRole>,
): Placement | null {
  // The places of an account with labels; the other labels are tags the move leaves alone.
  const takes = ~(kept | MAILBOX_BIT.other) & ALL_MAILBOXES;
  const here = place.role === "other" ? MAILBOX_BIT.archive : MAILBOX_BIT[place.role];
  // A label to put on: the inbox, or the folder the person chose.
  const tag = place.role === "inbox" || place.role === "other" ? place.id : null;
  if ((held.mailboxes & takes & ~here) === 0 && (tag === null || held.labelIds.includes(tag))) {
    return null;
  }
  const labelIds = held.labelIds.filter((l) => roleOfLabel(l, roles) !== "inbox");
  if (tag !== null && !labelIds.includes(tag)) labelIds.push(tag);
  return {
    labelIds,
    mailboxes: (held.mailboxes & ~takes) | here | (place.role === "other" ? MAILBOX_BIT.other : 0),
  };
}

/** The labels a query names by `label:` that stand for a folder of this role. */
export type LabelRoleOf = (foldedLabel: string) => LabelRole | undefined;

/** Does the query, in a positive place, ask for mail of this role? (`in:`, or `label:` naming its folder.) */
export function asksFor(
  root: QueryNode | null,
  role: LabelRole,
  labelRole: LabelRoleOf = () => undefined,
): boolean {
  if (root === null) return false;
  switch (root.kind) {
    case "and":
    case "or":
      return root.children.some((c) => asksFor(c, role, labelRole));
    case "in":
      return root.role === role;
    case "label":
      return labelRole(root.value) === role;
    default:
      return false;
  }
}

/**
 * The query asks for Trash or Spam, so mail there is not left out (rule 3). Also what decides
 * whether an opened thread shows all of its messages.
 */
export function asksForHidden(root: QueryNode | null, labelRole?: LabelRoleOf): boolean {
  return asksFor(root, "trash", labelRole) || asksFor(root, "spam", labelRole);
}

/** True when the query names a place anywhere (`in:` or `label:`), even to exclude it. */
export function namesAPlace(root: QueryNode | null): boolean {
  if (root === null) return false;
  switch (root.kind) {
    case "and":
    case "or":
      return root.children.some(namesAPlace);
    case "not":
      return namesAPlace(root.child);
    case "in":
    case "label":
      return true;
    default:
      return false;
  }
}

/**
 * Whether the rows of a thread leave the list this query fills when the thread is moved (rule 9).
 * One pure function of the query and the action: Delete and Spam leave every view but one that
 * asks for them; Archive and Move leave the views that name a place.
 */
export function leavesView(
  root: QueryNode | null,
  action: MoveAction,
  labelRole?: LabelRoleOf,
): boolean {
  switch (action) {
    case "delete":
      return !asksFor(root, "trash", labelRole);
    case "spam":
      return !asksFor(root, "spam", labelRole);
    case "archive":
    case "move":
      return namesAPlace(root);
  }
}

/** The words the tray uses, past tense, for each action (ADR 0044, rule 10). */
export function describeMove(action: MoveKind, placeName?: string): string {
  switch (action) {
    case "archive":
      return "Archived";
    case "delete":
      return "Moved to Trash";
    case "spam":
      return "Marked as spam";
    case "move":
      return placeName ? `Moved to ${placeName}` : "Moved";
    case "purge":
      return "Deleted forever";
  }
}

/** The same when nothing was left to move (rule 5). */
export function describeNothing(action: MoveAction, placeName?: string): string {
  switch (action) {
    case "archive":
      return "Already archived";
    case "delete":
      return "Already in Trash";
    case "spam":
      return "Already in Spam";
    case "move":
      return placeName ? `Already in ${placeName}` : "Already there";
  }
}
