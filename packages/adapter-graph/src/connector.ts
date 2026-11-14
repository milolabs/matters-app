import type {
  MailConnection,
  MailConnectorPort,
  MailTarget,
  MailWatch,
  MailWatchHandlers,
  MimeParserPort,
} from "@matters/core";
import {
  defaultSchedule,
  GRAPH_BASE,
  GraphClient,
  loopbackGraphBase,
  type Schedule,
} from "./client.ts";
import { GraphRequestError, RefusedTokens } from "./errors.ts";
import { GraphFolders } from "./folders.ts";
import { GraphAttachments, GraphFlags, GraphMoves, GraphSentFolder } from "./mailbox.ts";
import { GraphMailSync } from "./sync.ts";
import { watchInbox } from "./watch.ts";

export interface GraphConnectorOptions {
  /** Parses the MIME of each new message, as for IMAP mail (rule 5). */
  readonly parser: MimeParserPort;
  /** Tests only: a loopback http address in place of Graph's (rule 12). */
  readonly baseUrl?: string;
  /** Share one with `GraphSubmitter`, so both count the same refused tokens (rule 11). */
  readonly refusedTokens?: RefusedTokens;
  /** The waits of `Retry-After` and of the inbox watch; tests pass a manual clock. */
  readonly schedule?: Schedule;
  readonly now?: () => number;
  /** Rows per delta page (default 50). */
  readonly pageSize?: number;
}

/** A connection to Graph: one token and the clients that use it, nothing held open. */
export interface GraphConnection extends MailConnection {
  readonly sync: GraphMailSync;
}

/**
 * `MailConnectorPort` over Microsoft Graph (ADR 0136, rule 4). A "connection" is a token and the
 * clients that use it; `abort` stops every request of it. Only a Graph target is taken, with a
 * browser sign-in's token: anything else throws.
 */
export class GraphConnector implements MailConnectorPort {
  private readonly parser: MimeParserPort;
  private readonly base: string;
  private readonly refused: RefusedTokens;
  private readonly schedule: Schedule;
  private readonly now: () => number;
  private readonly pageSize: number;

  constructor(options: GraphConnectorOptions) {
    this.parser = options.parser;
    this.base = options.baseUrl === undefined ? GRAPH_BASE : loopbackGraphBase(options.baseUrl);
    this.refused = options.refusedTokens ?? new RefusedTokens();
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.pageSize = options.pageSize ?? 50;
  }

  private client(target: MailTarget, signal?: AbortSignal): GraphClient {
    if (target.transport !== "graph") {
      throw new GraphRequestError("This account's mail does not move over Microsoft Graph");
    }
    if (target.credential.kind !== "oauth2") {
      throw new GraphRequestError("Microsoft Graph takes only a browser sign-in", "credentials");
    }
    return new GraphClient({
      base: this.base,
      token: target.credential.accessToken,
      refused: this.refused,
      schedule: this.schedule,
      pageSize: this.pageSize,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async connect(target: MailTarget): Promise<GraphConnection> {
    const controller = new AbortController();
    const client = this.client(target, controller.signal);
    const folders = new GraphFolders(client);
    const sync = new GraphMailSync({ client, folders, parser: this.parser, now: this.now });
    return {
      sync,
      sent: new GraphSentFolder(client),
      flags: new GraphFlags(client),
      moves: new GraphMoves(client, folders),
      attachments: new GraphAttachments(client),
      close: async () => controller.abort(),
      abort: () => controller.abort(),
    };
  }

  watchInbox(target: MailTarget, handlers: MailWatchHandlers): Promise<MailWatch> {
    return watchInbox(this.client(target), this.schedule, handlers, this.now());
  }
}
