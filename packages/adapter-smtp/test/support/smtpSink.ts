import type { Socket } from "node:net";
import { SMTPServer } from "smtp-server";

export interface Received {
  readonly from: string;
  readonly recipients: readonly string[];
  readonly raw: Buffer;
  readonly user: string;
  /** `SIZE=` the client declared on MAIL FROM; undefined when it declared none. */
  readonly declaredSize: number | undefined;
}

export interface SinkScript {
  /** Reply code for RCPT TO of this address, e.g. 550; undefined accepts. */
  rejectRcpt?: (address: string) => number | undefined;
  /** Reply to the end of the message data instead of accepting it. */
  rejectData?: number;
  /** Close the connection once the whole message arrived, without answering. */
  dropAfterData?: boolean;
  /** Take the message and never answer (the client's timeout decides). */
  stallAfterData?: boolean;
  /** Close the connection at MAIL FROM. */
  dropAtMailFrom?: boolean;
  /** Refuse MAIL FROM with 552 when the client declares a `SIZE=` above this. */
  refuseSizeAbove?: number;
}

export interface SmtpSink {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly received: Received[];
  readonly script: SinkScript;
  /** Bytes of message data seen so far, also of a message that never ended. */
  readonly dataBytes: () => number;
  /** Connections accepted so far, and the ones still open. */
  readonly connections: () => { total: number; open: number };
  /** Destroys every open connection, as a network that went away would. */
  dropConnections(): void;
  stop(): Promise<void>;
}

/** An SMTP server in this process that records what it is given (devDependency `smtp-server`). */
export async function startSmtpSink(
  options: {
    starttls?: boolean;
    user?: string;
    password?: string;
    /** Announced in EHLO as `SIZE`; the server also refuses a larger declaration itself. */
    size?: number;
  } = {},
): Promise<SmtpSink> {
  const user = options.user ?? "me";
  const password = options.password ?? "smtp-test-password";
  const received: Received[] = [];
  const script: SinkScript = {};
  const sockets = new Set<Socket>();
  let dataBytes = 0;
  let total = 0;
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: options.starttls ? [] : ["STARTTLS"],
    hideSTARTTLS: !options.starttls,
    logger: false,
    banner: "matters test sink",
    ...(options.size === undefined ? {} : { size: options.size }),
    onAuth(auth, _session, callback) {
      if (auth.username === user && auth.password === password) callback(null, { user });
      else callback(new Error("535 5.7.8 Authentication credentials invalid"));
    },
    onMailFrom(address, _session, callback) {
      if (script.dropAtMailFrom) {
        for (const s of sockets) s.destroy();
        return;
      }
      const declared = Number((address.args as Record<string, unknown> | undefined)?.SIZE);
      if (script.refuseSizeAbove !== undefined && declared > script.refuseSizeAbove) {
        callback(
          Object.assign(new Error("552 5.3.4 Message size exceeds fixed limit"), {
            responseCode: 552,
          }),
        );
        return;
      }
      callback();
    },
    onRcptTo(address, _session, callback) {
      const code = script.rejectRcpt?.(address.address);
      if (code === undefined) return callback();
      callback(Object.assign(new Error(`${code} Mailbox unavailable`), { responseCode: code }));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => {
        dataBytes += c.length;
        chunks.push(c);
      });
      stream.on("end", () => {
        if (script.rejectData !== undefined) {
          callback(
            Object.assign(new Error(`${script.rejectData} Message refused`), {
              responseCode: script.rejectData,
            }),
          );
          return;
        }
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          recipients: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks),
          user: session.user ? String(session.user) : "",
          declaredSize: declaredSizeOf(session),
        });
        if (script.dropAfterData) {
          for (const s of sockets) s.destroy();
          return;
        }
        if (script.stallAfterData) return;
        callback();
      });
    },
  });
  server.server.on("connection", (socket: Socket) => {
    total++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("error", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    host: "127.0.0.1",
    port,
    user,
    password,
    received,
    script,
    dataBytes: () => dataBytes,
    connections: () => ({ total, open: sockets.size }),
    dropConnections: () => {
      for (const s of sockets) s.destroy();
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function declaredSizeOf(session: { envelope: { mailFrom: unknown } }): number | undefined {
  const from = session.envelope.mailFrom as { args?: Record<string, unknown> } | false;
  const size = from ? Number(from.args?.SIZE) : Number.NaN;
  return Number.isFinite(size) ? size : undefined;
}
