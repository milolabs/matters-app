// The adapters by transport (ADR 0136, rule 4): an account's mail moves over IMAP and SMTP, or
// over Microsoft Graph, and the backend picks the adapter by the target's `transport`. Core use
// cases see one connector and one submitter and never learn that Graph exists.
import type {
  CredentialPort,
  MailConnection,
  MailConnectorPort,
  MailSubmitPort,
  MailTarget,
  MailWatch,
  MailWatchHandlers,
  MimeSource,
  OutgoingCheck,
  SubmitEnvelope,
  SubmitResult,
  SubmitWatch,
} from "@matters/core";

/** One connector per transport; a target without one is IMAP's. */
export class ConnectorByTransport implements MailConnectorPort {
  private readonly imap: MailConnectorPort;
  private readonly graph: MailConnectorPort;

  constructor(adapters: { readonly imap: MailConnectorPort; readonly graph: MailConnectorPort }) {
    this.imap = adapters.imap;
    this.graph = adapters.graph;
  }

  private of(target: MailTarget): MailConnectorPort {
    return target.transport === "graph" ? this.graph : this.imap;
  }

  connect(target: MailTarget): Promise<MailConnection> {
    return this.of(target).connect(target);
  }

  watchInbox(target: MailTarget, handlers: MailWatchHandlers): Promise<MailWatch> {
    return this.of(target).watchInbox(target, handlers);
  }
}

/** One submitter per transport: SMTP's, or Graph's `sendMail`. */
export class SubmitByTransport implements MailSubmitPort {
  private readonly smtp: MailSubmitPort;
  private readonly graph: MailSubmitPort;

  constructor(adapters: { readonly smtp: MailSubmitPort; readonly graph: MailSubmitPort }) {
    this.smtp = adapters.smtp;
    this.graph = adapters.graph;
  }

  private of(target: MailTarget): MailSubmitPort {
    return target.transport === "graph" ? this.graph : this.smtp;
  }

  submit(
    target: MailTarget,
    envelope: SubmitEnvelope,
    source: MimeSource,
    watch?: SubmitWatch,
  ): Promise<SubmitResult> {
    return this.of(target).submit(target, envelope, source, watch);
  }

  verify(target: MailTarget): Promise<OutgoingCheck> {
    return this.of(target).verify(target);
  }
}

/** What the backend asks of the Graph adapter's `RefusedTokens`; it holds hashes, not tokens. */
export interface RefusedTokenBook {
  /** Graph refused this token once. */
  wasRefused(token: string): boolean;
  /** The token renewed in place of a refused one: its first refusal is the second. */
  renewedAfterRefusal(token: string): void;
}

/**
 * The vault as the backend's work reads it, asked again once when Graph refused a token (ADR
 * 0136, rule 11): the token it would hand out is one that `refused` marked, so the vault is asked
 * for a renewed one, which the book notes as the one retry. A `401` on that one is then
 * `signInAgain`. A password, or a token nobody refused, passes as it came.
 */
export function renewingRefused(inner: CredentialPort, refused: RefusedTokenBook): CredentialPort {
  return {
    availability: () => inner.availability(),
    get: async (accountId, options) => {
      const credential = await (options === undefined
        ? inner.get(accountId)
        : inner.get(accountId, options));
      if (
        credential?.kind !== "oauth2" ||
        options?.renew === true ||
        !refused.wasRefused(credential.accessToken)
      ) {
        return credential;
      }
      const renewed = await inner.get(accountId, { renew: true });
      if (renewed?.kind === "oauth2") refused.renewedAfterRefusal(renewed.accessToken);
      return renewed;
    },
    set: (accountId, credential) => inner.set(accountId, credential),
    delete: (accountId) => inner.delete(accountId),
    move: (fromId, toId) => inner.move(fromId, toId),
  };
}
