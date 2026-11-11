import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TransportSecurity } from "@matters/core";

export type ProbeProtocol = "imap" | "smtp";

/** True when `host:port` speaks the protocol with that security. Nothing is logged in to. */
export type Prober = (
  protocol: ProbeProtocol,
  host: string,
  port: number,
  security: TransportSecurity,
  timeoutMs: number,
) => Promise<boolean>;

const MAX_ANSWER = 16_384;

/** Everything the server said until `done` accepts it; rejects on a close or a timeout. */
function answer(socket: Socket, done: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (done(text) || text.length > MAX_ANSWER) {
        socket.off("data", onData);
        socket.off("close", onClose);
        resolve(text);
      }
    };
    const onClose = () => reject(new Error("closed"));
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

const line = (text: string) => text.includes("\n");
const imapDone = (text: string) => /^a OK|^a (NO|BAD)/m.test(text);
// The last line of a multi-line SMTP reply has a space after the code.
const smtpDone = (text: string) => /^\d{3} .*\r?\n/m.test(text);

async function speaks(
  socket: Socket,
  protocol: ProbeProtocol,
  security: TransportSecurity,
): Promise<boolean> {
  const greeting = await answer(socket, line);
  if (protocol === "imap") {
    if (!/^\* (OK|PREAUTH)/.test(greeting)) return false;
    if (security === "tls") return true;
    socket.write("a CAPABILITY\r\n");
    return /\bSTARTTLS\b/i.test(await answer(socket, imapDone));
  }
  if (!greeting.startsWith("220")) return false;
  if (security === "tls") return true;
  socket.write("EHLO matters.local\r\n");
  return /^250[ -]STARTTLS/im.test(await answer(socket, smtpDone));
}

/**
 * Real sockets. With TLS the certificate has to be valid for the host, as it must for the login
 * later. With STARTTLS this only asks whether it is offered; the login test does the upgrade.
 */
export const probeServer: Prober = async (protocol, host, port, security, timeoutMs) => {
  const socket =
    security === "tls"
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true })
      : netConnect({ host, port });
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  socket.on("error", () => {});
  try {
    return await speaks(socket, protocol, security);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
};
