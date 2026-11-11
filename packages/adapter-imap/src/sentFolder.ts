import type { Account, SentCopy, SentFolderPort, SentMatch } from "@matters/core";
import type { ImapFlow } from "imapflow";
import type { OpenConnection } from "./connection.ts";
import { ImapConnectionError } from "./errors.ts";
import { roleOfFolder } from "./folders.ts";
import { providerIdOf } from "./providerId.ts";

function dateMsOf(value: Date | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The Sent folder over one IMAP connection (ADR 0020, rules 8 and 10). Gmail never gets an
 * APPEND: it files what it accepted itself, and its copy is found by `X-GM-RAW rfc822msgid:`.
 */
export class ImapSentFolder implements SentFolderPort {
  private readonly connection: OpenConnection;

  constructor(connection: OpenConnection) {
    this.connection = connection;
  }

  async append(account: Account, raw: Uint8Array): Promise<SentCopy> {
    const { client, gmail } = this.connection;
    if (gmail) throw new ImapConnectionError("Gmail keeps its own copy of sent mail");
    const path = await this.folderOfUse(client, "\\Sent", "sent");
    const stored = await client.append(path, Buffer.from(raw), ["\\Seen"], new Date());
    if (!stored) throw new ImapConnectionError(`The server did not store the message in ${path}`);
    const uidValidity = String(stored.uidValidity ?? "");
    let uid = stored.uid;
    const messageId = headerValue(raw, "message-id");
    // Without UIDPLUS the server does not say where the message went: look for it.
    if (uid === undefined || uidValidity === "") {
      const found = messageId ? await this.searchHeader(path, messageId) : undefined;
      if (found === undefined) throw new ImapConnectionError("The stored copy was not found");
      uid = found;
    }
    const providerId = await this.providerIdOfStored(path, uidValidity, uid);
    return {
      providerId,
      location: { accountId: account.id, folderId: path, uidValidity, uid },
    };
  }

  async findByMessageId(account: Account, messageId: string): Promise<SentMatch | null> {
    const { client, gmail } = this.connection;
    if (gmail) {
      const path = await this.folderOfUse(client, "\\All", "archive");
      return this.inFolder(path, async () => {
        const found = await client.search({ gmraw: `rfc822msgid:${messageId}` }, { uid: true });
        const uid = Array.isArray(found) ? found[0] : undefined;
        if (uid === undefined) return null;
        const meta = await client.fetchOne(String(uid), { emailId: true }, { uid: true });
        const emailId = meta ? meta.emailId : undefined;
        return emailId ? { providerId: `gm:${emailId}` } : null;
      });
    }
    const path = await this.folderOfUse(client, "\\Sent", "sent");
    const uid = await this.searchHeader(path, messageId);
    if (uid === undefined) return null;
    const mailbox = await this.inFolder(path, async () => client.mailbox);
    const uidValidity = mailbox ? String(mailbox.uidValidity) : "";
    return {
      providerId: await this.providerIdOfStored(path, uidValidity, uid),
      // The server's own copy is recorded where it is, as an appended one is (ADR 0092).
      ...(uidValidity === ""
        ? {}
        : { location: { accountId: account.id, folderId: path, uidValidity, uid } }),
    };
  }

  private async inFolder<T>(path: string, work: () => Promise<T>): Promise<T> {
    const lock = await this.connection.client.getMailboxLock(path, { readOnly: true });
    try {
      return await work();
    } finally {
      lock.release();
    }
  }

  private async searchHeader(path: string, messageId: string): Promise<number | undefined> {
    const { client } = this.connection;
    return this.inFolder(path, async () => {
      const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
      return Array.isArray(found) ? found[0] : undefined;
    });
  }

  /** The id sync will give this very message, computed from what the server reports about it. */
  private async providerIdOfStored(
    path: string,
    uidValidity: string,
    uid: number,
  ): Promise<string> {
    const { client, objectId } = this.connection;
    return this.inFolder(path, async () => {
      const meta = await client.fetchOne(
        String(uid),
        { envelope: true, size: true, emailId: true },
        { uid: true },
      );
      if (!meta) throw new ImapConnectionError("The stored copy was not found");
      return providerIdOf({
        folderId: path,
        uidValidity,
        uid,
        emailId: meta.emailId,
        emailIdKind: objectId ? "objectId" : "none",
        messageId: meta.envelope?.messageId,
        dateMs: dateMsOf(meta.envelope?.date),
        size: meta.size,
      });
    });
  }

  private async folderOfUse(
    client: ImapFlow,
    use: string,
    role: "sent" | "archive",
  ): Promise<string> {
    const entries = await client.list();
    const folder =
      entries.find((e) => (e.specialUse ?? "").toLowerCase() === use.toLowerCase()) ??
      entries.find(
        (e) => !e.flags.has("\\Noselect") && roleOfFolder(e.path, e.name, e.specialUse) === role,
      );
    if (!folder) throw new ImapConnectionError(`No ${role} folder on the server`);
    return folder.path;
  }
}

/** First `name:` header of a raw message, unfolded; enough to find the Message-ID. */
function headerValue(raw: Uint8Array, name: string): string | undefined {
  const head = Buffer.from(raw.subarray(0, 8192)).toString("latin1");
  const end = head.search(/\r?\n\r?\n/);
  const block = (end < 0 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(block);
  return m?.[1]?.trim();
}
