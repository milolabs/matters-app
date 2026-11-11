import { isIP } from "node:net";
import { Readable } from "node:stream";
import type {
  MailSubmitPort,
  MailTarget,
  MimeSource,
  OutgoingCheck,
  SubmitEnvelope,
  SubmitResult,
  SubmitWatch,
} from "@matters/core";
import { scrubSecrets } from "@matters/core";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import { smtpFailureDetail } from "./errors.ts";

export interface SmtpSubmitOptions {
  /**
   * Allows `security: "none"`. Default: true only when `MATTERS_ALLOW_INSECURE_SMTP=1`, which
   * tests set and nothing else.
   */
  readonly allowInsecure?: boolean;
  readonly connectionTimeoutMs?: number;
  readonly greetingTimeoutMs?: number;
  /**
   * Silence on the socket, also while waiting for the answer after the message data. One second
   * per megabyte of the message is added, since a server may scan a large one before it answers
   * (ADR 0041, rule 17).
   */
  readonly socketTimeoutMs?: number;
  /** Name given in EHLO. */
  readonly clientName?: string;
  /** Extra `tls.connect` options; tests trust a self-signed certificate here, nothing else does. */
  readonly tls?: { readonly rejectUnauthorized?: boolean };
}

interface SmtpError extends Error {
  code?: string;
  /** The system error's code when nodemailer replaced it with its own (`ETLS`). */
  originalCode?: string;
  responseCode?: number;
  response?: string;
}

function kindOfSmtpError(e: SmtpError): "auth" | "tls" | "unreachable" | "other" {
  if (e.code === "EAUTH" || e.responseCode === 535 || e.responseCode === 534) return "auth";
  if (e.code === "ETLS" || /certificate|self.signed|\bTLS\b|\bSSL\b/i.test(e.message ?? "")) {
    return "tls";
  }
  if (["ECONNECTION", "ETIMEDOUT", "EDNS", "ESOCKET"].includes(e.code ?? "")) return "unreachable";
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(e.code ?? e.message ?? "")) {
    return "unreachable";
  }
  return "other";
}

/** Nodemailer keeps what EHLO announced in `SIZE` here; 0 means the server named no limit. */
function announcedLimit(connection: SMTPConnection): number | null {
  const bytes = (connection as unknown as { _maxAllowedSize?: number })._maxAllowedSize;
  return typeof bytes === "number" && bytes > 0 ? bytes : null;
}

/** Thrown into the race of steps when the caller aborts; never leaves this file. */
const ABORTED = Symbol("aborted");

const insecureAllowed = (o: SmtpSubmitOptions) =>
  o.allowInsecure ?? process.env.MATTERS_ALLOW_INSECURE_SMTP === "1";

/**
 * Submits over TLS or STARTTLS (required unless the test opt-in is set) with one nodemailer
 * `SMTPConnection` per message. It tells a definite refusal from an open outcome (ADR 0020,
 * rule 7, narrowed by ADR 0041, rule 13) by how far the message got:
 * - A reply code from the server, and anything that goes wrong before the server asked for the
 *   data, is `rejected`.
 * - A connection lost while the data was going out is `interrupted`: the end-of-data marker was
 *   never written, so nothing was delivered.
 * - Lost after the last byte was handed over, or a timeout while waiting for the answer, is
 *   `unknown`.
 * The message is streamed from its source with backpressure, never held whole.
 */
export class NodemailerSubmit implements MailSubmitPort {
  private readonly options: SmtpSubmitOptions;

  constructor(options: SmtpSubmitOptions = {}) {
    this.options = options;
  }

  async verify(target: MailTarget): Promise<OutgoingCheck> {
    const { server, credential } = target;
    if (credential.kind !== "password") {
      return { ok: false, kind: "auth", reason: "Only password sign-in is supported" };
    }
    if (server.security === "none" && !insecureAllowed(this.options)) {
      return {
        ok: false,
        kind: "tls",
        reason: `Refusing to send through ${server.host}:${server.port} without TLS.`,
      };
    }
    const connection = this.connectionTo(server);
    const dead = new Promise<never>((_, fail) => connection.once("error", fail));
    dead.catch(() => {});
    const step = (start: (done: (error?: Error | null) => void) => void) =>
      Promise.race([
        dead,
        new Promise<void>((resolve, fail) => start((error) => (error ? fail(error) : resolve()))),
      ]);
    try {
      await step((done) => connection.connect(done));
      await step((done) =>
        connection.login({ user: server.username, pass: credential.password }, done),
      );
      return { ok: true, limitBytes: announcedLimit(connection) };
    } catch (error) {
      const e = error as SmtpError;
      const kind = kindOfSmtpError(e);
      const secrets = [credential.password];
      const detail = smtpFailureDetail(kind, server.host, server.username, e, secrets);
      return {
        ok: false,
        kind,
        reason: scrubSecrets(e.message || String(error), secrets),
        ...(detail === undefined ? {} : { detail }),
      };
    } finally {
      connection.close();
    }
  }

  private connectionTo(server: MailTarget["server"], messageBytes = 0): SMTPConnection {
    return new SMTPConnection({
      host: server.host,
      port: server.port,
      secure: server.security === "tls",
      requireTLS: server.security === "starttls",
      ignoreTLS: server.security === "none",
      name: this.options.clientName ?? "matters.local",
      connectionTimeout: this.options.connectionTimeoutMs ?? 20_000,
      greetingTimeout: this.options.greetingTimeoutMs ?? 20_000,
      socketTimeout:
        (this.options.socketTimeoutMs ?? 60_000) + Math.ceil(messageBytes / 1_000_000) * 1000,
      tls: { ...(isIP(server.host) === 0 ? { servername: server.host } : {}), ...this.options.tls },
      logger: false,
    });
  }

  async submit(
    target: MailTarget,
    envelope: SubmitEnvelope,
    source: MimeSource,
    watch?: SubmitWatch,
  ): Promise<SubmitResult> {
    const { server, credential } = target;
    if (credential.kind !== "password") {
      return { kind: "rejected", reason: "Only password sign-in is supported" };
    }
    if (server.security === "none" && !insecureAllowed(this.options)) {
      return {
        kind: "rejected",
        reason: `Refusing to send through ${server.host}:${server.port} without TLS. Use TLS (port 465) or STARTTLS (port 587).`,
      };
    }
    const signal = watch?.signal;
    if (signal?.aborted) return { kind: "aborted" };
    const secrets = [credential.password];
    const reject = (error: unknown): SubmitResult => {
      const e = error as SmtpError;
      const reason = scrubSecrets(e.message || String(error), secrets);
      return {
        kind: "rejected",
        reason,
        ...(e.responseCode ? { code: e.responseCode } : {}),
        // The server's own refusal of the size, or nodemailer's before any byte was sent.
        ...(e.code === "EMESSAGE" || e.responseCode === 552 ? { tooLarge: true } : {}),
      };
    };

    const connection = this.connectionTo(server, source.size);
    // Some failures (a refused connection, a dropped socket) reach us only as an 'error' event.
    const dead = new Promise<never>((_, fail) => connection.once("error", fail));
    dead.catch(() => {});
    // Stop pressed (or the app quitting) before the data ended. After that the answer is awaited.
    const progress = {
      dataStarted: false,
      // From the moment the caller is asked to write its mark: the data ends from here on.
      ending: false,
      ended: false,
      sourceError: undefined as unknown,
    };
    const aborted = new Promise<never>((_, fail) => {
      signal?.addEventListener(
        "abort",
        () => {
          if (!progress.ending) fail(ABORTED);
        },
        { once: true },
      );
    });
    aborted.catch(() => {});
    const step = <T>(start: (done: (error: Error | null, value?: T) => void) => void) =>
      Promise.race([
        dead,
        aborted,
        new Promise<T>((resolve, fail) =>
          start((error, value) => (error ? fail(error) : resolve(value as T))),
        ),
      ]);

    // The stream is read only after the server said "go ahead" to DATA. The mark is persisted
    // by the caller just before the last byte, so `ended` is true only from there on.
    async function* chunks(): AsyncGenerator<Buffer> {
      progress.dataStarted = true;
      try {
        let sent = 0;
        for await (const chunk of source.open()) {
          sent += chunk.byteLength;
          watch?.onProgress?.(sent, source.size);
          yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
        progress.ending = true;
        await watch?.beforeDataEnd?.();
        progress.ended = true;
      } catch (error) {
        progress.sourceError = error;
        throw error;
      }
    }
    const message = Readable.from(chunks(), { objectMode: false });
    try {
      try {
        await step<void>((done) =>
          connection.connect((error?: Error | null) => done(error ?? null)),
        );
        await step<void>((done) =>
          connection.login({ user: server.username, pass: credential.password }, (error) =>
            done(error ?? null),
          ),
        );
        watch?.onServerLimit?.(announcedLimit(connection));
      } catch (error) {
        return error === ABORTED ? { kind: "aborted" } : reject(error);
      }

      try {
        const info = await step<{ response?: string; rejected?: string[] }>((done) =>
          connection.send(
            {
              from: envelope.from,
              to: [...envelope.recipients],
              ...(envelope.size === undefined ? {} : { size: envelope.size }),
            },
            message,
            (error, result) =>
              done(error ?? null, result as { response?: string; rejected?: string[] }),
          ),
        );
        return {
          kind: "accepted",
          response: scrubSecrets(String(info.response ?? ""), secrets),
          ...(info.rejected?.length ? { refused: info.rejected } : {}),
        };
      } catch (error) {
        if (error === ABORTED) return { kind: "aborted" };
        const e = error as SmtpError;
        // Our own source failed (a file, the persisting of the mark): nothing was delivered,
        // and a connection that was fine is no reason to try again by itself.
        if (progress.sourceError !== undefined) {
          const why = progress.sourceError;
          return {
            kind: "rejected",
            reason: scrubSecrets(
              `The message could not be read: ${why instanceof Error ? why.message : String(why)}`,
              secrets,
            ),
          };
        }
        // A reply code is the server's own answer: it did not take the message.
        if (!progress.dataStarted || e.responseCode !== undefined) return reject(error);
        const reason = scrubSecrets(
          e.message || "The connection ended before the server answered",
          secrets,
        );
        return progress.ended ? { kind: "unknown", reason } : { kind: "interrupted", reason };
      }
    } finally {
      connection.close();
      // Lets go of the file the source reads from, whatever ended the send.
      message.destroy();
    }
  }
}
