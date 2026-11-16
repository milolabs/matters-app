import type {
  MailAttachmentPort,
  MessageLocation,
  PartDownload,
  SourceDownload,
} from "@matters/core";
import type { OpenConnection } from "./connection.ts";
import { ImapUnreachableError, safeError } from "./errors.ts";

/**
 * Fetches the parts of messages over one IMAP connection (ADR 0043, rule 6). The caller gives it
 * a connection of its own, so a download of minutes never holds up a sync.
 *
 * The folder is opened read-only and ImapFlow fetches with `BODY.PEEK`, so the message is not
 * marked as read. The part comes decoded (base64 or quoted-printable removed) and unconverted:
 * `decodeText: false` keeps a text file's own bytes and charset, since this is a file to save
 * and not a letter to read.
 */
export class ImapAttachments implements MailAttachmentPort {
  private readonly connection: OpenConnection;
  private readonly secrets: readonly string[];

  constructor(connection: OpenConnection, secrets: readonly string[] = []) {
    this.connection = connection;
    this.secrets = secrets;
  }

  async download(
    location: MessageLocation,
    partId: string,
    signal?: AbortSignal,
  ): Promise<PartDownload> {
    const { client } = this.connection;
    let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
    try {
      lock = await client.getMailboxLock(location.folderId, { readOnly: true });
    } catch (error) {
      // A folder that is gone holds no copy: the message is not there any more.
      if ((error as { mailboxMissing?: boolean }).mailboxMissing === true) return { kind: "gone" };
      throw safeError(error, this.secrets);
    }
    try {
      const mailbox = client.mailbox;
      if (!mailbox)
        throw new ImapUnreachableError("The connection closed before the folder opened");
      // The folder was rebuilt: its UIDs now number other messages, so this one is not there.
      if (String(mailbox.uidValidity) !== location.uidValidity) {
        lock.release();
        return { kind: "gone" };
      }
      const found = await client.download(String(location.uid), partId, {
        uid: true,
        decodeText: false,
      });
      if (!found.content) {
        lock.release();
        return { kind: "gone" };
      }
      const content = found.content;
      const release = () => lock.release();
      return {
        kind: "found",
        content: this.stream(content, release, signal),
      };
    } catch (error) {
      lock.release();
      throw error instanceof ImapUnreachableError ? error : safeError(error, this.secrets);
    }
  }

  /**
   * The whole message as the server keeps it (ADR 0145, rule 2). With no part, ImapFlow asks for
   * `BODY.PEEK[]` in pieces of 64 KB (`BODY.PEEK[]<start.length>`) and passes them on as they
   * come, with no transfer or charset decoding: the bytes are the server's. `PEEK` leaves
   * `\Seen` alone, and the folder is opened read-only besides.
   */
  async source(location: MessageLocation, signal?: AbortSignal): Promise<SourceDownload> {
    const { client } = this.connection;
    let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
    try {
      lock = await client.getMailboxLock(location.folderId, { readOnly: true });
    } catch (error) {
      if ((error as { mailboxMissing?: boolean }).mailboxMissing === true) return { kind: "gone" };
      throw safeError(error, this.secrets);
    }
    try {
      const mailbox = client.mailbox;
      if (!mailbox)
        throw new ImapUnreachableError("The connection closed before the folder opened");
      if (String(mailbox.uidValidity) !== location.uidValidity) {
        lock.release();
        return { kind: "gone" };
      }
      const found = await client.download(String(location.uid), undefined, { uid: true });
      if (!found.content) {
        lock.release();
        return { kind: "gone" };
      }
      const size = (found.meta as { expectedSize?: unknown } | undefined)?.expectedSize;
      return {
        kind: "found",
        content: this.stream(found.content, () => lock.release(), signal),
        ...(typeof size === "number" && size > 0 ? { size } : {}),
      };
    } catch (error) {
      lock.release();
      throw error instanceof ImapUnreachableError ? error : safeError(error, this.secrets);
    }
  }

  /** Passes the chunks on and lets go of the folder when the last one is read or the reader gives up. */
  private async *stream(
    content: AsyncIterable<unknown> & { destroy(error?: Error): unknown },
    release: () => void,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Uint8Array> {
    const stop = () => content.destroy(new Error("The download was stopped"));
    signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const chunk of content) yield chunk as Uint8Array;
    } catch (error) {
      // A socket that died mid-part is trouble to retry, not a verdict about the message.
      throw this.connection.client.usable
        ? safeError(error, this.secrets)
        : new ImapUnreachableError("The connection closed during the download");
    } finally {
      signal?.removeEventListener("abort", stop);
      content.destroy();
      release();
    }
  }
}
