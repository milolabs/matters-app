import type {
  Account,
  FolderSyncContext,
  Label,
  MailSyncPort,
  MimeParserPort,
  ProviderCapability,
  SyncBatch,
  SyncCursor,
} from "@matters/core";
import { ImapAttachments } from "./attachments.ts";
import { type ImapConnectionOptions, type OpenConnection, openConnection } from "./connection.ts";
import { ImapFlags } from "./flags.ts";
import { roleOfFolder } from "./folders.ts";
import { ImapMoves } from "./moves.ts";
import { ImapSentFolder } from "./sentFolder.ts";
import { type SyncEnv, type SyncStats, syncFolder } from "./sync.ts";

export type { SyncStats } from "./sync.ts";

export interface ImapMailSyncOptions extends ImapConnectionOptions {
  /** Parses downloaded sources. Injected: this adapter does not know which MIME library runs. */
  readonly parser: MimeParserPort;
  /** UIDs per batch; default 200. */
  readonly batchSize?: number;
  /** Maps a host to its registrable domain; with it, sync trusts the account's own authserv-ids (ADR 0048). */
  readonly registrableDomain?: (host: string) => string | undefined;
}

const GMAIL_FOLDER_USES = new Set(["\\all", "\\trash", "\\junk"]);

/**
 * `MailSyncPort` over one IMAP connection (ADR 0008). Create with `ImapMailSync.connect`, always
 * `close()` when done. Folders must be synced one after another: they share the connection.
 */
export class ImapMailSync implements MailSyncPort {
  readonly capabilities: ReadonlySet<ProviderCapability>;
  readonly stats: SyncStats = {
    sourcesDownloaded: 0,
    fullUidSearches: 0,
    replyToFetches: 0,
    automatedFetches: 0,
    attachmentFetches: 0,
  };
  /** Sent folder operations on this same connection (ADR 0020). */
  readonly sent: ImapSentFolder;
  /** Flag writes on this same connection (ADR 0039); sync itself never writes. */
  readonly flags: ImapFlags;
  /** Moves and deletions on this same connection (ADR 0044). */
  readonly moves: ImapMoves;
  /** Received files fetched on this same connection (ADR 0043). */
  readonly attachments: ImapAttachments;
  private readonly connection: OpenConnection;
  private readonly options: ImapMailSyncOptions;

  private constructor(connection: OpenConnection, options: ImapMailSyncOptions) {
    this.connection = connection;
    this.options = options;
    this.capabilities = connection.capabilities;
    this.sent = new ImapSentFolder(connection);
    const secrets = "pass" in options.auth ? [options.auth.pass] : [options.auth.accessToken];
    this.flags = new ImapFlags(connection, secrets);
    this.moves = new ImapMoves(connection, secrets);
    this.attachments = new ImapAttachments(connection, secrets);
  }

  static async connect(options: ImapMailSyncOptions): Promise<ImapMailSync> {
    return new ImapMailSync(await openConnection(options), options);
  }

  async listFolders(account: Account): Promise<readonly Label[]> {
    const { client, gmail } = this.connection;
    const entries = await client.list();
    const selectable = entries.filter(
      (e) => e.listed && !e.flags.has("\\Noselect") && !e.flags.has("\\NonExistent"),
    );
    // Gmail: every message is in All Mail; the other folders would only duplicate it (ADR 0008).
    const wanted = gmail
      ? selectable.filter((e) => GMAIL_FOLDER_USES.has((e.specialUse ?? "").toLowerCase()))
      : selectable;
    return wanted.map((e) => ({
      id: e.path,
      accountId: account.id,
      name: e.name,
      role: roleOfFolder(e.path, e.name, e.specialUse),
      exclusive: !gmail,
    }));
  }

  syncFolder(
    account: Account,
    folder: Label,
    cursor: SyncCursor | null,
    context: FolderSyncContext,
  ): AsyncIterable<SyncBatch> {
    const env: SyncEnv = {
      client: this.connection.client,
      parser: this.options.parser,
      ...(this.options.registrableDomain
        ? {
            authServ: {
              imapHost: this.options.host,
              registrableDomain: this.options.registrableDomain,
            },
          }
        : {}),
      gmail: this.connection.gmail,
      objectId: this.connection.objectId,
      batchSize: this.options.batchSize ?? 200,
      stats: this.stats,
    };
    return syncFolder(env, account, folder, cursor, context);
  }

  /** Drops the socket without a goodbye: a download in flight fails at once. */
  abort(): void {
    this.connection.client.close();
  }

  /** Logs out; falls back to dropping the socket when the server does not answer. */
  async close(): Promise<void> {
    const { client } = this.connection;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
