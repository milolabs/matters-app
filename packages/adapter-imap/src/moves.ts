import type {
  ExpungeOutcome,
  ExpungeResult,
  LabelRole,
  MailMovePort,
  MessageLocation,
  MoveAction,
  MoveOutcome,
  MoveResult,
  MoveTarget,
} from "@matters/core";
import type { ListResponse } from "imapflow";
import type { OpenConnection } from "./connection.ts";
import { ImapUnreachableError, safeError } from "./errors.ts";
import { roleOfFolder } from "./folders.ts";

/** UIDs per command: the command line stays short however large the thread is. */
const UIDS_PER_COMMAND = 500;

/** What a missing folder of a role is created as (ADR 0044, rule 14). */
const CREATED_AS: Readonly<Record<"inbox" | "archive" | "trash" | "spam", string>> = {
  inbox: "INBOX",
  archive: "Archive",
  trash: "Trash",
  spam: "Junk",
};

type Mailbox = ListResponse;
const selectable = (e: Mailbox) => !e.flags.has("\\Noselect") && !e.flags.has("\\NonExistent");
const roleOf = (e: Mailbox): LabelRole => roleOfFolder(e.path, e.name, e.specialUse);

/**
 * Moves mail over one IMAP connection (ADR 0044, rules 13, 14 and 16). Sync never writes; like
 * the flag writes this opens a mailbox read-write under a lock, so a sync on the same connection
 * is not left with the wrong mode and two users of the connection stay apart.
 *
 * Moving is `UID MOVE`, which ImapFlow turns into COPY, `\Deleted` and expunge on a server
 * without it. That fallback expunges every `\Deleted` message of the folder unless the server
 * has UIDPLUS, and a message somebody else flagged would go with it: a server with neither is
 * refused. The same goes for deleting for good, which is only ever done in the account's Trash.
 *
 * Gmail has no folders to move between, only labels: Archive takes the inbox label off, a label
 * as target puts it on and takes the inbox label off, and Delete and Spam move to the folders of
 * those names. This path has not been run against Gmail (it cannot be in CI).
 */
export class ImapMoves implements MailMovePort {
  private readonly connection: OpenConnection;
  private readonly secrets: readonly string[];

  constructor(connection: OpenConnection, secrets: readonly string[] = []) {
    this.connection = connection;
    this.secrets = secrets;
  }

  async move(
    locations: readonly MessageLocation[],
    action: MoveAction,
    target: MoveTarget,
  ): Promise<readonly MoveResult[]> {
    const outcomes: MoveOutcome[] = locations.map(() => ({ kind: "stale" }));
    const folders = await this.listing();
    const where = await this.destination(folders, action, target);
    const byFolder = group(locations);
    for (const [folder, indexes] of byFolder) {
      const here = folders.find((f) => f.path === folder);
      const done = await this.inFolder(folder, indexes, locations, async (uids) =>
        this.connection.gmail
          ? this.gmailMove(here, uids, action, target, where)
          : this.move_(uids, where?.path ?? null, here),
      );
      indexes.forEach((at, n) => {
        outcomes[at] = this.located(done[n] as UidOutcome, locations[at] as MessageLocation, where);
      });
    }
    return locations.map((location, i) => ({ location, outcome: outcomes[i] as MoveOutcome }));
  }

  async expunge(locations: readonly MessageLocation[]): Promise<readonly ExpungeResult[]> {
    const outcomes: ExpungeOutcome[] = locations.map(() => "stale");
    const folders = await this.listing();
    const { client } = this.connection;
    for (const [folder, indexes] of group(locations)) {
      const entry = folders.find((f) => f.path === folder);
      // Only the account's Trash: anywhere else nothing is sent, whatever the caller believed.
      if (!entry || roleOf(entry) !== "trash") {
        for (const at of indexes) outcomes[at] = "rejected";
        continue;
      }
      const done = await this.inFolder(folder, indexes, locations, async (uids) => {
        if (!this.hasUidPlus()) return uids.map((): UidOutcome => ({ kind: "rejected" }));
        const present = await this.present(uids);
        const goners = uids.filter((u) => present.has(u));
        for (let i = 0; i < goners.length; i += UIDS_PER_COMMAND) {
          const chunk = goners.slice(i, i + UIDS_PER_COMMAND).join(",");
          const ok = await client.messageDelete(chunk, { uid: true });
          if (!ok && !client.usable) {
            throw new ImapUnreachableError("The connection closed while mail was being deleted");
          }
        }
        // The server's own word: what is still there was not deleted.
        const left = goners.length === 0 ? new Set<number>() : await this.present(goners);
        return uids.map((uid): UidOutcome => {
          if (!present.has(uid)) return { kind: "stale" };
          return left.has(uid) ? { kind: "rejected" } : { kind: "moved" };
        });
      });
      indexes.forEach((at, n) => {
        const d = done[n] as UidOutcome;
        outcomes[at] = d.kind === "moved" ? "done" : d.kind;
      });
    }
    return locations.map((location, i) => ({ location, outcome: outcomes[i] as ExpungeOutcome }));
  }

  private hasUidPlus(): boolean {
    return this.connection.client.capabilities.has("UIDPLUS");
  }

  private async listing(): Promise<Mailbox[]> {
    try {
      return await this.connection.client.list();
    } catch (error) {
      throw safeError(error, this.secrets);
    }
  }

  /**
   * Where the mail goes, on this server. A missing Archive, Trash or Junk folder is made (rule
   * 14); `null` for a Gmail label, which is no folder.
   */
  private async destination(
    folders: readonly Mailbox[],
    action: MoveAction,
    target: MoveTarget,
  ): Promise<{ path: string } | null> {
    const { client, gmail } = this.connection;
    if ("folderId" in target) return gmail ? null : { path: target.folderId };
    // Gmail's archive is the inbox label going away, and its inbox the label coming back.
    if (gmail && (action === "archive" || target.role === "inbox")) return null;
    const role: LabelRole = target.role;
    const use = wantedUse(role);
    const found =
      (use === undefined
        ? undefined
        : folders.find((f) => selectable(f) && f.specialUse === use)) ??
      folders.find((f) => selectable(f) && roleOf(f) === role);
    if (found) return { path: found.path };
    try {
      const made = await client.mailboxCreate(CREATED_AS[target.role]);
      return { path: made.path };
    } catch (error) {
      // A folder that cannot be made is a refusal: the rest of the call is answered as such.
      if (!client.usable) throw safeError(error, this.secrets);
      return { path: "" };
    }
  }

  private located(
    done: UidOutcome,
    source: MessageLocation,
    where: { path: string } | null,
  ): MoveOutcome {
    if (done.kind !== "moved") return done;
    if (done.uid === undefined || where === null || done.uidValidity === undefined) {
      return { kind: "moved" };
    }
    return {
      kind: "moved",
      location: {
        accountId: source.accountId,
        folderId: where.path,
        uidValidity: done.uidValidity,
        uid: done.uid,
      },
    };
  }

  /** `UID MOVE` of the copies to `path`; the new UIDs are `uidMap` (UIDPLUS, ADR 0016 rule 5). */
  private async move_(
    uids: readonly number[],
    path: string | null,
    from: Mailbox | undefined,
  ): Promise<UidOutcome[]> {
    const { client } = this.connection;
    if (path === null || path === "") return uids.map((): UidOutcome => ({ kind: "rejected" }));
    // Already there: nothing to move, and sync will say what is where.
    if (from?.path === path) return uids.map((): UidOutcome => ({ kind: "stale" }));
    if (!client.capabilities.has("MOVE") && !this.hasUidPlus()) {
      return uids.map((): UidOutcome => ({ kind: "rejected" }));
    }
    const present = await this.present(uids);
    const out = new Map<number, UidOutcome>();
    const live = uids.filter((u) => present.has(u));
    for (let i = 0; i < live.length; i += UIDS_PER_COMMAND) {
      const chunk = live.slice(i, i + UIDS_PER_COMMAND);
      const result = await client.messageMove(chunk.join(","), path, { uid: true });
      if (!result) {
        if (!client.usable) throw new ImapUnreachableError("The connection closed during the move");
        for (const uid of chunk) out.set(uid, { kind: "rejected" });
        continue;
      }
      const validity = result.uidValidity === undefined ? undefined : String(result.uidValidity);
      for (const uid of chunk) {
        const to = result.uidMap?.get(uid);
        out.set(uid, {
          kind: "moved",
          ...(to === undefined || validity === undefined ? {} : { uid: to, uidValidity: validity }),
        });
      }
    }
    return uids.map((uid) => out.get(uid) ?? { kind: "stale" });
  }

  /**
   * Gmail: labels, not folders. Mail in Trash or Spam goes back by being moved; mail in All Mail
   * changes by label.
   */
  private async gmailMove(
    here: Mailbox | undefined,
    uids: readonly number[],
    action: MoveAction,
    target: MoveTarget,
    where: { path: string } | null,
  ): Promise<UidOutcome[]> {
    const { client } = this.connection;
    const role = here ? roleOf(here) : "other";
    // Real folders: Trash and Spam, as targets, and as the places mail is brought back from.
    if (where !== null || role === "trash" || role === "spam") {
      const path = where?.path ?? (await this.gmailHome(target));
      return this.move_(uids, path, here);
    }
    const present = await this.present(uids);
    const live = uids.filter((u) => present.has(u));
    const done = new Set<number>();
    for (let i = 0; i < live.length; i += UIDS_PER_COMMAND) {
      const chunk = live.slice(i, i + UIDS_PER_COMMAND).join(",");
      const options = { uid: true, useLabels: true, silent: true };
      let ok = true;
      if ("folderId" in target) {
        ok = await client.messageFlagsAdd(chunk, [target.folderId], options);
        ok = ok && (await client.messageFlagsRemove(chunk, ["\\Inbox"], options));
      } else if (target.role === "inbox") {
        ok = await client.messageFlagsAdd(chunk, ["\\Inbox"], options);
      } else if (action === "archive") {
        ok = await client.messageFlagsRemove(chunk, ["\\Inbox"], options);
      }
      if (!ok && !client.usable)
        throw new ImapUnreachableError("The connection closed during the move");
      if (ok) for (const u of live.slice(i, i + UIDS_PER_COMMAND)) done.add(u);
    }
    return uids.map((uid): UidOutcome => {
      if (!present.has(uid)) return { kind: "stale" };
      return done.has(uid) ? { kind: "moved" } : { kind: "rejected" };
    });
  }

  /** Where mail in Trash or Spam goes back to: the inbox, or All Mail. */
  private async gmailHome(target: MoveTarget): Promise<string> {
    if ("role" in target && target.role === "inbox") return "INBOX";
    const all = (await this.listing()).find((f) => (f.specialUse ?? "").toLowerCase() === "\\all");
    return all?.path ?? "[Gmail]/All Mail";
  }

  /** Which of these UIDs the open folder still has. */
  private async present(uids: readonly number[]): Promise<Set<number>> {
    const { client } = this.connection;
    const here = new Set<number>();
    for (let i = 0; i < uids.length; i += UIDS_PER_COMMAND) {
      const found = await client.search(
        { uid: uids.slice(i, i + UIDS_PER_COMMAND).join(",") },
        { uid: true },
      );
      if (Array.isArray(found)) for (const u of found) here.add(u);
    }
    return here;
  }

  /**
   * Opens `folder` read-write under a lock and runs `work` on the UIDs of the locations that are
   * still of the folder's present life. A folder that is gone, rebuilt (UIDVALIDITY) or read-only
   * answers for all of them without a command.
   */
  private async inFolder(
    folder: string,
    indexes: readonly number[],
    all: readonly MessageLocation[],
    work: (uids: readonly number[]) => Promise<UidOutcome[]>,
  ): Promise<UidOutcome[]> {
    const { client } = this.connection;
    let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
    try {
      lock = await client.getMailboxLock(folder, { readOnly: false });
    } catch (error) {
      if ((error as { mailboxMissing?: boolean }).mailboxMissing === true) {
        return indexes.map((): UidOutcome => ({ kind: "stale" }));
      }
      throw safeError(error, this.secrets);
    }
    try {
      const mailbox = client.mailbox;
      if (!mailbox)
        throw new ImapUnreachableError("The connection closed before the folder opened");
      const live = String(mailbox.uidValidity);
      const outcomes: UidOutcome[] = indexes.map((): UidOutcome => ({ kind: "stale" }));
      const current = indexes.flatMap((at, n) =>
        (all[at] as MessageLocation).uidValidity === live ? [n] : [],
      );
      if (current.length === 0) return outcomes;
      if (mailbox.readOnly) {
        for (const n of current) outcomes[n] = { kind: "rejected" };
        return outcomes;
      }
      const uids = [
        ...new Set(current.map((n) => (all[indexes[n] as number] as MessageLocation).uid)),
      ].sort((a, b) => a - b);
      const done = await work(uids);
      const byUid = new Map(uids.map((uid, i) => [uid, done[i] as UidOutcome]));
      for (const n of current) {
        const uid = (all[indexes[n] as number] as MessageLocation).uid;
        outcomes[n] = byUid.get(uid) ?? { kind: "stale" };
      }
      return outcomes;
    } catch (error) {
      throw error instanceof ImapUnreachableError ? error : safeError(error, this.secrets);
    } finally {
      lock.release();
    }
  }
}

/** What happened to one UID, and where it went when the server said. */
type UidOutcome =
  | { readonly kind: "moved"; readonly uid?: number; readonly uidValidity?: string }
  | { readonly kind: "stale" }
  | { readonly kind: "rejected" };

function group(locations: readonly MessageLocation[]): Map<string, number[]> {
  const byFolder = new Map<string, number[]>();
  locations.forEach((l, i) => {
    const at = byFolder.get(l.folderId);
    if (at) at.push(i);
    else byFolder.set(l.folderId, [i]);
  });
  return byFolder;
}

/** The SPECIAL-USE flag of the folder that serves a role. */
function wantedUse(role: LabelRole): string | undefined {
  switch (role) {
    case "trash":
      return "\\Trash";
    case "spam":
      return "\\Junk";
    case "archive":
      return "\\Archive";
    case "inbox":
      return undefined;
    default:
      return undefined;
  }
}
