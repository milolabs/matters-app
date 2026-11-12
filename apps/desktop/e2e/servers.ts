// A real mailbox for the specs that need one: the Dovecot test server (tools/imap-test-server,
// started around the whole run by `bun run test:e2e`) and an SMTP server in this process.
//
// The setup screen offers TLS and STARTTLS and nothing else, and it should: a user never types a
// plaintext server. The test servers speak plaintext. So each test puts a TLS front on both, on
// 127.0.0.1, with a certificate from a throwaway CA made for the test, and the app is told to
// trust that CA through Node's own NODE_EXTRA_CA_CERTS. The app then connects exactly as it would
// to a mail host: TLS from the first byte, the certificate checked against the name typed.
import { writeFileSync } from "node:fs";
import { connect as connectTcp, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { Admin } from "../../../packages/adapter-imap/test/support/admin.ts";
import {
  type SmtpSink,
  startSmtpSink,
} from "../../../packages/adapter-smtp/test/support/smtpSink.ts";
import { type KeyPair, makePki } from "../test/corpus/support/certs.ts";
import { test as base } from "./fixtures.ts";

export { expect } from "./fixtures.ts";

export interface ImapServer {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

/** The test server's address, from the variables `tools/imap-test-server/run.ts` sets. */
function imapServer(): ImapServer | undefined {
  const host = process.env.MATTERS_IMAP_HOST;
  const port = Number(process.env.MATTERS_IMAP_PORT);
  const user = process.env.MATTERS_IMAP_USER;
  const password = process.env.MATTERS_IMAP_PASS;
  return host && port > 0 && user && password ? { host, port, user, password } : undefined;
}

const NO_SERVER =
  "needs the IMAP test server (MATTERS_IMAP_HOST and the rest): run `bun run test:e2e`, which starts it in Docker";

/**
 * Called at the top of a spec file that needs the server. Without the variables the file is
 * skipped locally, with the reason, and fails on CI, where a missing server is a broken job and
 * not a test to leave out.
 */
export function requireImapServer(): void {
  if (imapServer()) return;
  if (process.env.CI) throw new Error(`On CI this spec ${NO_SERVER}.`);
  base.skip(true, NO_SERVER);
}

/** Listens with TLS on 127.0.0.1 and passes every connection on, in plaintext, to `target`. */
async function tlsFront(
  target: { host: string; port: number },
  pair: KeyPair,
): Promise<{ port: number; stop(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createTlsServer({ key: pair.key, cert: pair.cert }, (client) => {
    const upstream = connectTcp(target.port, target.host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  // A client that gives up during the handshake is not a failure of the front.
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface Mailbox {
  /** The address and password a person types on the setup screen. */
  readonly address: string;
  readonly password: string;
  /** What the app connects to: TLS on 127.0.0.1. */
  readonly host: string;
  readonly imapPort: number;
  readonly smtpPort: number;
  /** Add to the app's environment: the CA of the TLS fronts. */
  readonly env: Record<string, string>;
  /** A second IMAP client, straight to the server, to fill it and to check what the app did. */
  readonly admin: Admin;
  /** What the SMTP server was given. */
  readonly sink: SmtpSink;
  stop(): Promise<void>;
}

/**
 * The test server emptied for this test, its TLS front, an SMTP server behind one of its own, and
 * the CA file the app must trust. The SMTP server takes the same name and password as the
 * mailbox, because the setup screen uses the mailbox's for sending unless told otherwise.
 */
export async function openMailbox(server: ImapServer, dir: string): Promise<Mailbox> {
  const pki = makePki();
  const caFile = join(dir, "test-ca.pem");
  writeFileSync(caFile, pki.caPem);
  const admin = await Admin.connect({
    host: server.host,
    port: server.port,
    user: server.user,
    pass: server.password,
  });
  await admin.reset();
  const imap = await tlsFront(server, pki.good);
  const sink = await startSmtpSink({ user: server.user, password: server.password });
  const smtp = await tlsFront(sink, pki.good);
  return {
    address: server.user,
    password: server.password,
    host: "127.0.0.1",
    imapPort: imap.port,
    smtpPort: smtp.port,
    env: { NODE_EXTRA_CA_CERTS: caFile },
    admin,
    sink,
    async stop() {
      await imap.stop();
      await smtp.stop();
      await sink.stop();
      await admin.close();
      pki.dispose();
    },
  };
}

/**
 * The fixtures of a spec on a real account: `mailbox`, and `start` with the mailbox's CA added to
 * the app's environment. `start` depends on `mailbox`, so every app is closed (and its video and
 * trace kept) before the servers it talks to go away.
 */
export const test = base.extend<{ mailbox: Mailbox }>({
  mailbox: async ({ dataDir }, use) => {
    const server = imapServer();
    if (!server) throw new Error(`This test ${NO_SERVER}.`);
    const mailbox = await openMailbox(server, dataDir);
    await use(mailbox);
    await mailbox.stop();
  },
  start: async ({ start, mailbox }, use) => {
    await use((options = {}) => start({ env: { ...mailbox.env, ...options.env } }));
  },
});
