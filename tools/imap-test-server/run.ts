// Builds and runs the throw-away Dovecot test server, then stops it.
//
//   electron tools/imap-test-server/run.ts -- <command> [args...]
//     starts the server on a free port, runs the command with MATTERS_IMAP_HOST / _PORT / _USER /
//     _PASS / _SECURITY, MATTERS_ALLOW_INSECURE_IMAP=1 and MATTERS_IMAP_TEST=1 in its
//     environment, stops the server, exits with the command's code.
//   electron tools/imap-test-server/run.ts
//     starts the server, prints the variables and keeps it running until Ctrl-C.
//
// Run with ELECTRON_RUN_AS_NODE=1 (see the root package.json scripts). Needs Docker.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const IMAGE = "matters-imap-test:dev";
export const TEST_USER = "test@example.test";
export const TEST_PASSWORD = "test-password";

function docker(args: readonly string[], options: { quiet?: boolean } = {}): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "inherit"],
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** True once the server answers with an IMAP greeting. */
function greeting(port: number): Promise<boolean> {
  return new Promise((resolveGreeting) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolveGreeting(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("error", () => done(false));
    // The published port accepts connections before Dovecot listens, then hangs up.
    socket.once("close", () => done(false));
    socket.once("data", (d) => done(d.toString().startsWith("* OK")));
  });
}

export interface ImapTestServer {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  stop(): void;
}

export async function startImapTestServer(): Promise<ImapTestServer> {
  docker(["build", "--quiet", "-t", IMAGE, here]);
  const port = await freePort();
  const name = `matters-imap-test-${process.pid}`;
  docker(["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:143`, IMAGE], {
    quiet: true,
  });
  const stop = () => {
    try {
      docker(["stop", "-t", "1", name], { quiet: true });
    } catch {
      // already gone
    }
  };
  const deadline = Date.now() + 30_000;
  while (!(await greeting(port))) {
    if (Date.now() > deadline) {
      stop();
      throw new Error(`IMAP test server did not answer on port ${port} within 30 s`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { host: "127.0.0.1", port, user: TEST_USER, password: TEST_PASSWORD, stop };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const dashes = process.argv.indexOf("--");
  const command = dashes === -1 ? [] : process.argv.slice(dashes + 1);
  const server = await startImapTestServer();
  const env = {
    MATTERS_IMAP_TEST: "1",
    MATTERS_IMAP_HOST: server.host,
    MATTERS_IMAP_PORT: String(server.port),
    // Plaintext, on a container bound to 127.0.0.1: allowed explicitly (ADR 0018).
    MATTERS_IMAP_SECURITY: "none",
    MATTERS_ALLOW_INSECURE_IMAP: "1",
    MATTERS_IMAP_USER: server.user,
    MATTERS_IMAP_PASS: server.password,
  };
  let child: ChildProcess | undefined;
  const shutdown = (code: number) => {
    child?.kill("SIGTERM");
    server.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));

  const [program, ...args] = command;
  if (!program) {
    // Test credentials of a container on 127.0.0.1; the password is public in the repo.
    for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${v}`);
    console.error("IMAP test server running; Ctrl-C stops it.");
    await new Promise(() => {});
  } else {
    child = spawn(program, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  }
}
