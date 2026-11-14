import type {
  MailConnection,
  MailConnectorPort,
  MailTarget,
  MailWatch,
  MailWatchHandlers,
  MimeParserPort,
} from "@matters/core";
import type { ImapConnectionOptions } from "./connection.ts";
import { ImapMailSync } from "./mailSync.ts";
import { watchInbox } from "./watch.ts";

export interface ImapConnectorOptions {
  readonly parser: MimeParserPort;
  readonly batchSize?: number;
  /** See `ImapConnectionOptions.allowInsecure`. */
  readonly allowInsecure?: boolean;
  /** See `ImapMailSyncOptions.registrableDomain`. */
  readonly registrableDomain?: (host: string) => string | undefined;
}

/** `MailConnectorPort` over IMAP: one connection per sync, one more per inbox watch. */
export class ImapConnector implements MailConnectorPort {
  private readonly options: ImapConnectorOptions;

  constructor(options: ImapConnectorOptions) {
    this.options = options;
  }

  async connect(target: MailTarget): Promise<MailConnection> {
    const imap = await ImapMailSync.connect({
      ...this.connectionOptions(target),
      parser: this.options.parser,
      ...(this.options.registrableDomain === undefined
        ? {}
        : { registrableDomain: this.options.registrableDomain }),
      ...(this.options.batchSize === undefined ? {} : { batchSize: this.options.batchSize }),
    });
    return {
      sync: imap,
      sent: imap.sent,
      flags: imap.flags,
      moves: imap.moves,
      attachments: imap.attachments,
      close: () => imap.close(),
      abort: () => imap.abort(),
    };
  }

  async watchInbox(target: MailTarget, handlers: MailWatchHandlers): Promise<MailWatch> {
    return watchInbox(this.connectionOptions(target), handlers);
  }

  private connectionOptions(target: MailTarget): ImapConnectionOptions {
    const { server, credential } = target;
    // A Graph account is reached through its own adapter (ADR 0136, rule 4).
    if (server === undefined) throw new Error("This account's mail does not move over IMAP");
    return {
      host: server.host,
      port: server.port,
      security: server.security,
      // A browser sign-in logs in with XOAUTH2 as the server's user name from the account's
      // settings (ADR 0133, rule 9); the vault has made sure the token still works (rule 7).
      auth:
        credential.kind === "password"
          ? { user: server.username, pass: credential.password }
          : { user: server.username, accessToken: credential.accessToken },
      ...(this.options.allowInsecure === undefined
        ? {}
        : { allowInsecure: this.options.allowInsecure }),
    };
  }
}
