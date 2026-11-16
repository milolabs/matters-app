// Settings › Storage › Backups (ADR 0145, rules 6 to 10): the words, as pure functions of what
// main says, so they are tested alone and said the same way everywhere.
import type {
  BackupAnswer,
  BackupJobState,
  PendingRestoreInfo,
  RestoreAnswer,
  SetAsideInfo,
} from "@matters/contracts";
import { count, storageSize } from "./storageView.ts";

/** What a backup holds and does not, said before one is written (rule 7). */
export const BACKUP_HOLDS =
  "A backup is one file with all the mail Matters keeps on this Mac (its text, its HTML and the search index), drafts and mail waiting to be sent, views, the settings kept with the mail, and what agents wrote.";
export const BACKUP_LEAVES =
  "It does not hold passwords, sign-ins or API keys, downloaded attachments, your own themes, or the appearance, window and notification settings kept beside the mail. Mail on your servers is not touched.";
export const BACKUP_NOT_ENCRYPTED =
  "The file is not encrypted: anyone who can read it can read your mail. Keep it where only you can.";

/** The busy line while a job runs; null when nothing does. */
export function jobLine(job: BackupJobState): string | null {
  switch (job.kind) {
    case "idle":
      return null;
    case "backingUp":
      return job.writtenBytes > 0
        ? `Backing up… ${storageSize(job.writtenBytes)} written`
        : "Backing up…";
    case "copyingIn":
      return "Copying the backup…";
    case "checking":
      return "Checking the backup…";
  }
}

/** The line after Back Up… ended; `failure` when it is bad news, null when there is nothing to say. */
export function backupLine(answer: BackupAnswer): { text: string; failure: boolean } | null {
  switch (answer.kind) {
    case "done":
      return {
        text: `Backed up to “${answer.name}”, ${storageSize(answer.bytes)}.`,
        failure: false,
      };
    case "failed":
      return { text: answer.text, failure: true };
    case "stopped":
      return { text: "The backup was stopped. Nothing was left behind.", failure: false };
    default:
      return null;
  }
}

/** The line after Restore from a Backup… ended, when it did not end in a restore that waits. */
export function restoreLine(answer: RestoreAnswer): { text: string; failure: boolean } | null {
  switch (answer.kind) {
    case "refused":
    case "failed":
      return { text: answer.text, failure: true };
    case "stopped":
      return { text: "The check was stopped. Nothing will change.", failure: false };
    default:
      return null;
  }
}

/** What the waiting restore will do at the next start (rules 9 and 10). */
export function pendingLines(pending: PendingRestoreInfo): string[] {
  const messages = pending.messages === 1 ? "1 message" : `${count(pending.messages)} messages`;
  const accounts = pending.accounts === 1 ? "1 account" : `${count(pending.accounts)} accounts`;
  const lines = [
    `The backup holds ${messages} of ${accounts}. At the next start it takes the place of what Matters keeps now; that is set aside and kept until you remove it.`,
  ];
  if (pending.heldSends > 0) {
    lines.push(
      pending.heldSends === 1
        ? "1 message was waiting to be sent in the backup. It will wait for you, since it may have gone out since."
        : `${count(pending.heldSends)} messages were waiting to be sent in the backup. They will wait for you, since they may have gone out since.`,
    );
  }
  if (pending.holdAccounts.length > 0) {
    lines.push(
      pending.holdAccounts.length === 1
        ? "1 account of the backup uses another server than here, so it will ask for its password or sign-in again."
        : `${pending.holdAccounts.length} accounts of the backup use other servers than here, so they will ask for their passwords or sign-ins again.`,
    );
  }
  lines.push(
    "Accounts with no password or sign-in saved on this Mac ask for it after the restart.",
  );
  return lines;
}

/** "Set aside 16 Nov 2026, 15:30": when a restore set this database aside. */
export function setAsideLabel(item: SetAsideInfo): string {
  const when = new Date(item.atMs).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Set aside ${when}`;
}
