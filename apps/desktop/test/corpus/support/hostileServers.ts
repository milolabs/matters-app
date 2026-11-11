// Servers that misbehave on purpose, for the transport tier (ADR 0047). Real sockets, real TLS,
// written from scratch: they only speak as much IMAP and SMTP as a client needs to log in. Each
// records every line it received, apart for what arrived before TLS and what arrived over it.
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import type { KeyPair } from "./certs.ts";

export interface Behaviour {
  readonly protocol: "imap" | "smtp";
  /** TLS from the first byte. */
  readonly implicit?: boolean;
  readonly pki?: KeyPair;
  readonly tlsVersions?: {
    minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2";
    maxVersion?: "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
    ciphers?: string;
  };
  /** Offer STARTTLS in the capability list. */
  readonly offerStarttls?: boolean;
  /** What the server does when asked. */
  readonly starttlsAnswer?: "ok" | "refuse";
  /** Bytes put in the same write as the STARTTLS "go ahead". */
  readonly injectWithStarttlsOk?: string;
  /** Offer password login before TLS (what a stripped server would still do). */
  readonly offerPlainLogin?: boolean;
  /** Greet and answer in plaintext although the port is meant for implicit TLS. */
}

export interface ServerLog {
  readonly plain: string[];
  readonly secure: string[];
  connections: number;
  handshakeFailures: number;
}

export interface HostileServer {
  readonly port: number;
  readonly log: ServerLog;
  stop(): Promise<void>;
}

type Writer = (text: string) => void;

function imapSession(
  b: Behaviour,
  log: ServerLog,
  secure: boolean,
  write: Writer,
  upgrade: (inject: string) => void,
) {
  let awaitingCredentials: string | null = null;
  return (line: string) => {
    (secure ? log.secure : log.plain).push(line);
    if (awaitingCredentials !== null) {
      write(`${awaitingCredentials} OK authenticated\r\n`);
      awaitingCredentials = null;
      return;
    }
    const [tag = "*", command = "", ...rest] = line.split(" ");
    const verb = command.toUpperCase();
    const caps = () =>
      `IMAP4rev1${b.offerStarttls && !secure ? " STARTTLS" : ""}${secure || b.offerPlainLogin ? " AUTH=PLAIN" : " LOGINDISABLED"}`;
    switch (verb) {
      case "CAPABILITY":
        write(`* CAPABILITY ${caps()}\r\n${tag} OK done\r\n`);
        break;
      case "STARTTLS":
        if (b.starttlsAnswer === "refuse") write(`${tag} NO STARTTLS is not available\r\n`);
        else upgrade(`${tag} OK Begin TLS negotiation now\r\n`);
        break;
      case "LOGIN":
        write(`${tag} OK logged in\r\n`);
        break;
      case "AUTHENTICATE":
        if (rest[1]) write(`${tag} OK authenticated\r\n`);
        else {
          awaitingCredentials = tag;
          write("+ \r\n");
        }
        break;
      case "LOGOUT":
        write(`* BYE bye\r\n${tag} OK logout\r\n`);
        break;
      default:
        write(`${tag} OK done\r\n`);
    }
  };
}

function smtpSession(
  b: Behaviour,
  log: ServerLog,
  secure: boolean,
  write: Writer,
  upgrade: (inject: string) => void,
) {
  let mode: "command" | "plain-credentials" | "login-user" | "login-pass" | "data" = "command";
  return (line: string) => {
    (secure ? log.secure : log.plain).push(line);
    if (mode === "data") {
      if (line === ".") {
        mode = "command";
        write("250 2.0.0 queued\r\n");
      }
      return;
    }
    if (mode === "plain-credentials" || mode === "login-pass") {
      mode = "command";
      write("235 2.7.0 authenticated\r\n");
      return;
    }
    if (mode === "login-user") {
      mode = "login-pass";
      write("334 UGFzc3dvcmQ6\r\n");
      return;
    }
    const verb = line.split(" ")[0]?.toUpperCase() ?? "";
    switch (verb) {
      case "EHLO":
      case "HELO": {
        const extra = [
          ...(b.offerStarttls && !secure ? ["STARTTLS"] : []),
          ...(secure || b.offerPlainLogin ? ["AUTH PLAIN LOGIN"] : []),
        ];
        const all = ["corpus.test", ...extra, "8BITMIME"];
        write(
          `${all.map((e, i) => `250${i === all.length - 1 ? " " : "-"}${e}`).join("\r\n")}\r\n`,
        );
        break;
      }
      case "STARTTLS":
        if (b.starttlsAnswer === "refuse") write("454 4.7.0 TLS not available\r\n");
        else upgrade("220 2.0.0 Ready to start TLS\r\n");
        break;
      case "AUTH": {
        const [, method, initial] = line.split(" ");
        if (method?.toUpperCase() === "PLAIN" && initial) write("235 2.7.0 authenticated\r\n");
        else if (method?.toUpperCase() === "PLAIN") {
          mode = "plain-credentials";
          write("334 \r\n");
        } else {
          mode = "login-user";
          write("334 VXNlcm5hbWU6\r\n");
        }
        break;
      }
      case "DATA":
        mode = "data";
        write("354 end with a dot\r\n");
        break;
      case "QUIT":
        write("221 2.0.0 bye\r\n");
        break;
      default:
        write("250 2.0.0 ok\r\n");
    }
  };
}

/** Feeds complete lines (ended by CRLF or LF) of a socket to `onLine`; the rest waits for more. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffered = "";
  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("latin1");
    let at = buffered.indexOf("\n");
    while (at >= 0) {
      onLine(buffered.slice(0, at).replace(/\r$/, ""));
      buffered = buffered.slice(at + 1);
      at = buffered.indexOf("\n");
    }
  });
}

export async function startHostileServer(b: Behaviour): Promise<HostileServer> {
  const log: ServerLog = { plain: [], secure: [], connections: 0, handshakeFailures: 0 };
  const open = new Set<Socket>();
  const tlsOptions = b.pki ? { key: b.pki.key, cert: b.pki.cert, ...b.tlsVersions } : undefined;
  const greeting = (secure: boolean) =>
    b.protocol === "imap"
      ? `* OK [CAPABILITY IMAP4rev1${b.offerStarttls && !secure ? " STARTTLS" : ""}${secure || b.offerPlainLogin ? " AUTH=PLAIN" : " LOGINDISABLED"}] corpus ready\r\n`
      : "220 corpus.test ESMTP ready\r\n";

  const serve = (socket: Socket, secure: boolean): void => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    const write: Writer = (text) => {
      if (!socket.destroyed) socket.write(text, "latin1");
    };
    const upgrade = (answer: string): void => {
      if (!tlsOptions) return;
      socket.removeAllListeners("data");
      // The answer and anything the attacker wants processed go out in one write.
      socket.write(`${answer}${b.injectWithStarttlsOk ?? ""}`, "latin1", () => {
        const wrapped = new TLSSocket(socket, { isServer: true, ...tlsOptions });
        wrapped.on("error", () => {
          log.handshakeFailures++;
        });
        open.add(wrapped);
        wrapped.on("close", () => open.delete(wrapped));
        serve(wrapped, true);
      });
    };
    const handle = (b.protocol === "imap" ? imapSession : smtpSession)(
      b,
      log,
      secure,
      write,
      upgrade,
    );
    lines(socket, handle);
    // A TLS session starts silent for the client (it speaks first after the handshake); the
    // greeting is only for the first, original connection.
    if (!(socket instanceof TLSSocket) || b.implicit) write(greeting(secure));
  };

  const server: Server =
    b.implicit && tlsOptions
      ? createTlsServer(tlsOptions, (socket) => {
          log.connections++;
          serve(socket, true);
        }).on("tlsClientError", () => {
          log.handshakeFailures++;
        })
      : createServer((socket) => {
          log.connections++;
          serve(socket, false);
        });
  server.on("error", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    log,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}
