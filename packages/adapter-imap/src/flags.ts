import type { FlagOutcome, FlagResult, MailFlagsPort, MessageLocation } from "@matters/core";
import type { OpenConnection } from "./connection.ts";
import { ImapUnreachableError, safeError } from "./errors.ts";

/** UIDs per STORE command: the command line stays short however large the thread is. */
const UIDS_PER_COMMAND = 500;

/**
 * Writes `\Seen` over one IMAP connection (ADR 0039). Sync opens mailboxes read-only and never
 * writes; this is the one place that opens a mailbox read-write. `getMailboxLock` re-selects a
 * mailbox whose access mode differs, so a sync on the same connection is not left with a mailbox
 * selected in the wrong mode, and a lock keeps two users of the connection apart. IMAP flags
 * belong to one copy, so the caller names every copy it wants changed.
 */
export class ImapFlags implements MailFlagsPort {
  private readonly connection: OpenConnection;
  private readonly secrets: readonly string[];

  constructor(connection: OpenConnection, secrets: readonly string[] = []) {
    this.connection = connection;
    this.secrets = secrets;
  }

  async setSeen(
    locations: readonly MessageLocation[],
    seen: boolean,
  ): Promise<readonly FlagResult[]> {
    const outcomes: FlagOutcome[] = locations.map(() => "stale");
    const byFolder = new Map<string, number[]>();
    locations.forEach((l, i) => {
      const at = byFolder.get(l.folderId);
      if (at) at.push(i);
      else byFolder.set(l.folderId, [i]);
    });
    for (const [folder, indexes] of byFolder) {
      const done = await this.inFolder(folder, indexes, locations, seen);
      indexes.forEach((at, n) => {
        outcomes[at] = done[n] as FlagOutcome;
      });
    }
    return locations.map((location, i) => ({ location, outcome: outcomes[i] as FlagOutcome }));
  }

  private async inFolder(
    folder: string,
    indexes: readonly number[],
    all: readonly MessageLocation[],
    seen: boolean,
  ): Promise<FlagOutcome[]> {
    const { client } = this.connection;
    let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
    try {
      lock = await client.getMailboxLock(folder, { readOnly: false });
    } catch (error) {
      // A folder that is gone holds none of the copies: sync will notice.
      if ((error as { mailboxMissing?: boolean }).mailboxMissing === true) {
        return indexes.map(() => "stale");
      }
      throw safeError(error, this.secrets);
    }
    try {
      const mailbox = client.mailbox;
      if (!mailbox)
        throw new ImapUnreachableError("The connection closed before the folder opened");
      const live = String(mailbox.uidValidity);
      const outcomes: FlagOutcome[] = indexes.map(() => "stale");
      const current = indexes.flatMap((at, n) =>
        (all[at] as MessageLocation).uidValidity === live ? [n] : [],
      );
      if (current.length === 0) return outcomes;
      // The server decides the access mode: a read-only folder takes no flags.
      if (mailbox.readOnly) {
        for (const n of current) outcomes[n] = "rejected";
        return outcomes;
      }
      const uids = [
        ...new Set(current.map((n) => (all[indexes[n] as number] as MessageLocation).uid)),
      ].sort((a, b) => a - b);
      const taken = new Set<number>();
      for (let i = 0; i < uids.length; i += UIDS_PER_COMMAND) {
        const chunk = uids.slice(i, i + UIDS_PER_COMMAND);
        const ok = await this.store(chunk, seen);
        if (ok) for (const uid of chunk) taken.add(uid);
      }
      for (const n of current) {
        const uid = (all[indexes[n] as number] as MessageLocation).uid;
        outcomes[n] = taken.has(uid) ? "done" : "rejected";
      }
      return outcomes;
    } finally {
      lock.release();
    }
  }

  /**
   * ImapFlow reports a failed STORE as `false`, whether the server said NO or the connection
   * broke. A connection that is no longer usable is trouble to retry; a usable one was refused.
   */
  private async store(uids: readonly number[], seen: boolean): Promise<boolean> {
    const { client } = this.connection;
    const range = uids.join(",");
    const options = { uid: true, silent: true };
    const ok = seen
      ? await client.messageFlagsAdd(range, ["\\Seen"], options)
      : await client.messageFlagsRemove(range, ["\\Seen"], options);
    if (!ok && !client.usable) {
      throw new ImapUnreachableError("The connection closed while the flag was being set");
    }
    return ok;
  }
}
