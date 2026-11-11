import type { ProviderCapability, TransportSecurity } from "@matters/core";
import { AuthenticationFailure, ImapFlow } from "imapflow";
import { ImapInsecureTransportError, refusedSignIn, safeError } from "./errors.ts";

export type ImapAuth =
  | { readonly user: string; readonly pass: string }
  | { readonly user: string; readonly accessToken: string };

export interface ImapConnectionOptions {
  readonly host: string;
  readonly port: number;
  /**
   * `tls`: TLS from the first byte (993). `starttls`: upgrade is required; a server that does
   * not offer it is refused. `none`: plaintext, only with the opt-in below (ADR 0018).
   */
  readonly security: TransportSecurity;
  readonly auth: ImapAuth;
  /**
   * Allows `security: "none"`. Default: true only when `MATTERS_ALLOW_INSECURE_IMAP=1`, which
   * is set for the test server and nowhere else.
   */
  readonly allowInsecure?: boolean;
  /** Skip COMPRESS=DEFLATE even when the server offers it. */
  readonly disableCompression?: boolean;
  /** Restart IDLE this often (ms); only for a connection that idles. */
  readonly maxIdleTime?: number;
}

export interface OpenConnection {
  readonly client: ImapFlow;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  /** Server has X-GM-EXT-1 (Gmail): message ids, thread ids and labels. */
  readonly gmail: boolean;
  readonly objectId: boolean;
}

const secretsOf = (auth: ImapAuth): string[] => ("pass" in auth ? [auth.pass] : [auth.accessToken]);

export function insecureAllowed(options: Pick<ImapConnectionOptions, "allowInsecure">): boolean {
  return options.allowInsecure ?? process.env.MATTERS_ALLOW_INSECURE_IMAP === "1";
}

/**
 * Connects and logs in. Plaintext is refused unless allowed. Errors are rewritten so they carry
 * no secret and say what happened: `ImapAuthError` (with why, ADR 0114), `ImapTlsError`,
 * `ImapUnreachableError`, `ImapInsecureTransportError`, else `ImapConnectionError`.
 */
export async function openConnection(options: ImapConnectionOptions): Promise<OpenConnection> {
  if (options.security === "none" && !insecureAllowed(options)) {
    throw new ImapInsecureTransportError(options.host, options.port);
  }
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.security === "tls",
    // Required means refused, not "plaintext after a warning"; see ImapFlow's doSTARTTLS.
    doSTARTTLS:
      options.security === "starttls" ? true : options.security === "none" ? false : undefined,
    auth: { ...options.auth },
    logger: false,
    // Sync needs QRESYNC when the server has it; a watching connection starts IDLE itself.
    qresync: true,
    disableAutoIdle: true,
    ...(options.maxIdleTime ? { maxIdleTime: options.maxIdleTime } : {}),
    ...(options.disableCompression ? { disableCompression: true } : {}),
    clientInfo: { name: "Matters" },
  });
  // An unhandled 'error' event would crash the process; the failing command reports it anyway.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    client.close();
    if (
      error instanceof AuthenticationFailure ||
      (error as { authenticationFailed?: boolean }).authenticationFailed
    ) {
      const raw = error as { response?: unknown; serverResponseCode?: unknown };
      throw refusedSignIn(
        options.host,
        options.auth.user,
        {
          ...(typeof raw.serverResponseCode === "string" ? { code: raw.serverResponseCode } : {}),
          ...(typeof raw.response === "string" ? { text: raw.response } : {}),
        },
        secretsOf(options.auth),
      );
    }
    throw safeError(error, secretsOf(options.auth));
  }

  const has = (name: string) => client.capabilities.has(name);
  const gmail = has("X-GM-EXT-1");
  const objectId = has("OBJECTID");
  const capabilities = new Set<ProviderCapability>();
  if (gmail) {
    capabilities.add("threads");
    capabilities.add("labels");
    capabilities.add("savesSent");
  }
  if (objectId) capabilities.add("objectId");
  if (client.enabled.has("CONDSTORE")) capabilities.add("condstore");
  if (client.enabled.has("QRESYNC")) capabilities.add("qresync");
  if (has("COMPRESS=DEFLATE") && !options.disableCompression) capabilities.add("compress");
  return { client, capabilities, gmail, objectId };
}
