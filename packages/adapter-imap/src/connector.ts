import type {
  MailConnection,
  MailConnectorPort,
  MailTarget,
  MailWatch,
  MailWatchHandlers,
  MimeParserPort,
} from "@matters/core";
import type { ImapConnectionOptions } from "./connection.ts";
import { ImapAuthError } from "./errors.ts";
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

  watchInbox(target: MailTarget, handlers: MailWatchHandlers): Promise<MailWatch> {
    return watchInbox(this.connectionOptions(target), handlers);
  }

  private connectionOptions(target: MailTarget): ImapConnectionOptions {
    const { server, credential } = target;
    if (credential.kind !== "password") {
      throw new ImapAuthError(
        server.host,
        server.username,
        {},
        "Only password sign-in is supported",
      );
    }
    return {
      host: server.host,
      port: server.port,
      security: server.security,
      auth: { user: server.username, pass: credential.password },
      ...(this.options.allowInsecure === undefined
        ? {}
        : { allowInsecure: this.options.allowInsecure }),
    };
  }
}
