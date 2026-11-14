// The words and numbers of Erase everything (ADR 0138, rules 9 to 11): what goes, with sizes
// measured just then, what stays or is out of reach, and the result. The words promise only what
// is true: nothing here says "securely" or "shredded".
import type { EraseReviewInfo, HoldingBytes, MainEraseOverview } from "@matters/contracts";
import { count, storageSize } from "./storageView.ts";

export type GroupId = keyof HoldingBytes;

/** The review's groups, in its order, with the words that say what each holds. */
export const GROUP_COPY: readonly {
  readonly id: GroupId;
  readonly label: string;
  readonly detail: string;
}[] = [
  {
    id: "signIns",
    label: "Saved passwords and sign-ins",
    detail: "And the key that protects them in the Keychain",
  },
  {
    id: "mail",
    label: "Mail and the search index",
    detail: "Messages, drafts, and mail waiting to be sent",
  },
  {
    id: "files",
    label: "Attachments and files",
    detail: "Kept attachments, downloaded copies, the text agents read from them",
  },
  {
    id: "agents",
    label: "What agents wrote",
    detail: "Their notes on your mail, the journal, talks, your instructions and rules",
  },
  {
    id: "settings",
    label: "Views, people and settings",
    detail: "Saved views, image rules, notifications, your themes, window placement",
  },
  { id: "caches", label: "Caches", detail: "What the app builds to start and draw faster" },
];

export const labelOf = (id: GroupId) => GROUP_COPY.find((g) => g.id === id)?.label ?? id;

/** The word the person types to confirm (rule 10): exactly this, nothing around it. */
export const CONFIRM_WORD = "erase";
export const confirms = (typed: string) => typed === CONFIRM_WORD;

export interface ReviewRow {
  readonly id: GroupId;
  readonly label: string;
  readonly detail: string;
  /** What the right-hand column says: a size, or for sign-ins a count of accounts. */
  readonly amount: string;
}

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** The rows of "What goes", from the database's measurement and main's. */
export function reviewRows(
  db: EraseReviewInfo,
  main: MainEraseOverview | null,
): readonly ReviewRow[] {
  const bytes = (id: GroupId) => db.groups[id] + (main?.groups[id] ?? 0);
  return GROUP_COPY.map((g) => {
    if (g.id === "signIns") {
      return {
        ...g,
        detail: `For ${plural(db.accounts, "account", "accounts")}, and the key that protects them in the Keychain`,
        amount: plural(db.accounts, "account", "accounts"),
      };
    }
    if (g.id === "mail") {
      return {
        ...g,
        detail: `${plural(db.messages, "message", "messages")}, drafts, and mail waiting to be sent`,
        amount: storageSize(bytes(g.id)),
      };
    }
    return { ...g, amount: storageSize(bytes(g.id)) };
  });
}

export function reviewTotal(db: EraseReviewInfo, main: MainEraseOverview | null): number {
  return GROUP_COPY.reduce((n, g) => n + db.groups[g.id] + (main?.groups[g.id] ?? 0), 0);
}

/** "2 messages are still waiting to be sent." or null when none is (rule 10). */
export function unsentWarning(unsent: number): string | null {
  if (unsent <= 0) return null;
  return `${plural(unsent, "message is", "messages are")} still waiting to be sent. Erasing drops ${unsent === 1 ? "it" : "them"} unsent.`;
}

/** "kept as a backup since 10 Nov" or nothing when the date is not known. */
export function earlierSince(sinceMs: number | null): string {
  if (sinceMs === null) return "kept as a backup";
  const day = new Date(sinceMs).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `kept as a backup since ${day}`;
}

/** Why a thing was left, in plain words, and what the person can do (rule 11). */
export function leftReason(reason: string, kind: "key" | "path"): string {
  switch (reason) {
    case "busy":
      return "Another program has it open. Close it, then try again.";
    case "inUse":
      return "Another copy of Matters has this mailbox open, so it was not touched. Quit that copy, then try again.";
    case "refused":
      return "The system did not allow it to be deleted. Check its permissions, then try again.";
    // Nothing here says the key protects nothing: the saved passwords it locks may be left too.
    case "keychainRefused":
      return "The Keychain refused to delete this key. You can delete it in Keychain Access.";
    case "keychainUnsupported":
      return "Matters cannot delete this key from here. It is in your system's keyring, under the app's name.";
    case "outsideReach":
      return "It lies outside the folders Matters may erase, so it was not touched.";
    default:
      return kind === "key" ? "The key could not be deleted." : "It could not be deleted.";
  }
}

/** "8.3 GB erased in 11 seconds" with the earlier copy named when it went. */
export function erasedLine(bytes: number, ms: number, earlierCopy: boolean): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${storageSize(bytes)} erased in ${plural(seconds, "second", "seconds")}${earlierCopy ? ", the earlier copy included" : ""}.`;
}

/** "Checked: the folders and the Keychain key are gone." as far as it was checked. */
export function checkedLine(keys: number): string {
  if (keys === 0) return "Checked: the folders are gone.";
  return `Checked: the folders and ${keys === 1 ? "the Keychain key are" : `${count(keys)} Keychain keys are`} gone.`;
}

/** The heading of a partial result. */
export function partialHeading(left: number): string {
  if (left === 1) return "Almost all of it is gone. One thing is still here.";
  return `Almost all of it is gone. ${left < 10 ? ["", "", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][left] : count(left)} things are still here.`;
}

/**
 * Why the data folder could not be read, in plain words (ADR 0138, Notes after review): the start
 * could not tell whether an erase was ordered, so it did nothing.
 */
export function unreadableReason(code: string | null): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "The system does not allow Matters to open it. Check its permissions, then try again.";
    case "EIO":
      return "The disk it is on could not be read. Check that the disk is connected, then try again.";
    case "EBUSY":
      return "Another program has it open. Close it, then try again.";
    default:
      return code
        ? `The system gave an error (${code}). Try again in a moment.`
        : "The system gave an error. Try again in a moment.";
  }
}
