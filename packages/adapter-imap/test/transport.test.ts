import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import { PostalMimeParser } from "@matters/adapter-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImapAuthError,
  ImapInsecureTransportError,
  ImapMailSync,
  ImapTlsError,
  ImapUnreachableError,
  safeError,
  watchInbox,
} from "../src/index.ts";
import { Admin } from "./support/admin.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

const PASSWORD = "hunter2-very-secret";
const parser = new PostalMimeParser();

const everything = (e: unknown): string => {
  const error = e as Error;
  return [error.message, error.stack ?? "", JSON.stringify(error)].join("\n");
};

describe("transport policy", () => {
  let started: Awaited<ReturnType<typeof startHoodiecrow>>;
  beforeEach(async () => {
    vi.stubEnv("MATTERS_ALLOW_INSECURE_IMAP", "");
    started = await startHoodiecrow(["QRESYNC"]);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await started.stop();
  });

  const connect = (over: Record<string, unknown>) =>
    ImapMailSync.connect({
      host: started.credentials.host,
      port: started.credentials.port,
      security: "none",
      auth: { user: "testuser", pass: PASSWORD },
      parser,
      ...over,
    });

  it("refuses plaintext by default, before opening any connection", async () => {
    const failure = await connect({ port: 1 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImapInsecureTransportError);
    expect(failure).toMatchObject({ kind: "insecure" });
    expect(everything(failure)).not.toContain(PASSWORD);
  });

  it("allows plaintext when MATTERS_ALLOW_INSECURE_IMAP=1 or the option says so", async () => {
    vi.stubEnv("MATTERS_ALLOW_INSECURE_IMAP", "1");
    const viaEnv = await connect({ auth: { user: "testuser", pass: "testpass" } });
    await viaEnv.close();
    vi.stubEnv("MATTERS_ALLOW_INSECURE_IMAP", "");
    const viaOption = await connect({
      auth: { user: "testuser", pass: "testpass" },
      allowInsecure: true,
    });
    await viaOption.close();
    // only the exact value 1 counts
    vi.stubEnv("MATTERS_ALLOW_INSECURE_IMAP", "true");
    await expect(connect({})).rejects.toBeInstanceOf(ImapInsecureTransportError);
  });

  it("requires STARTTLS when asked to, and says so as a TLS error", async () => {
    const failure = await connect({ security: "starttls" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImapTlsError);
    expect(failure).toMatchObject({ kind: "tls" });
    expect(everything(failure)).not.toContain(PASSWORD);
  });

  it("calls TLS to a plaintext port a TLS error", async () => {
    const failure = await connect({ security: "tls" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImapTlsError);
    expect(everything(failure)).not.toContain(PASSWORD);
  });

  it("types an unreachable host and a wrong password", async () => {
    const down = await connect({ port: 1, allowInsecure: true }).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(ImapUnreachableError);
    expect(down).toMatchObject({ kind: "unreachable" });
    expect(everything(down)).not.toContain(PASSWORD);

    const wrong = await connect({ allowInsecure: true }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ImapAuthError);
    expect(wrong).toMatchObject({ kind: "auth" });
    expect(everything(wrong)).not.toContain(PASSWORD);
  });

  it("classifies raw errors and scrubs secrets from their text", () => {
    const timeout = safeError(
      Object.assign(new Error(`timeout for ${PASSWORD}`), { code: "ETIMEDOUT" }),
      [PASSWORD],
    );
    expect(timeout).toBeInstanceOf(ImapUnreachableError);
    expect(timeout.message).toBe("timeout for ***");
    expect(
      safeError(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), []),
    ).toBeInstanceOf(ImapTlsError);
    expect(safeError(Object.assign(new Error("x"), { tlsFailed: true }), [])).toBeInstanceOf(
      ImapTlsError,
    );
    expect(safeError(new Error("Command failed"), []).kind).toBe("other");
  });
});

const openssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!openssl)("certificate validation", () => {
  let dir: string;
  let server: Server;
  let port = 0;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "matters-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    server = createServer(
      { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) },
      (socket) => {
        socket.on("error", () => {});
        socket.write("* OK IMAP ready\r\n");
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a self-signed certificate as a TLS error", async () => {
    const failure = await ImapMailSync.connect({
      host: "127.0.0.1",
      port,
      security: "tls",
      auth: { user: "u", pass: PASSWORD },
      parser,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImapTlsError);
    expect(everything(failure)).not.toContain(PASSWORD);
  });
});

describe("inbox watch", () => {
  let started: Awaited<ReturnType<typeof startHoodiecrow>>;
  beforeEach(async () => {
    started = await startHoodiecrow(["IDLE"]);
  });
  afterEach(() => started.stop());

  const options = () => ({
    host: started.credentials.host,
    port: started.credentials.port,
    security: "none" as const,
    allowInsecure: true,
    auth: { user: started.credentials.user, pass: started.credentials.pass },
  });

  it("reports mail that arrives while idling, and stays quiet once closed", async () => {
    const admin = await Admin.connect(started.credentials);
    let changes = 0;
    let closed = 0;
    const watch = await watchInbox(options(), {
      onChange: () => changes++,
      onClosed: () => closed++,
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
      await admin.append("INBOX", mail({ id: "w1", subject: "Nowa wiadomość" }));
      await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 3000 });
    } finally {
      await watch.close();
      await admin.close();
    }
    const seen = changes;
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toBe(seen);
    expect(closed).toBe(0);
  });

  it("calls onClosed when the server drops the connection", async () => {
    let closed = 0;
    const watch = await watchInbox(options(), { onChange: () => {}, onClosed: () => closed++ });
    await new Promise((r) => setTimeout(r, 100));
    await started.stop();
    await vi.waitFor(() => expect(closed).toBe(1), { timeout: 3000 });
    await watch.close();
    started = await startHoodiecrow(["IDLE"]);
  });

  it("fails to open with a typed error on a wrong password", async () => {
    const failure = await watchInbox(
      { ...options(), auth: { user: "testuser", pass: PASSWORD } },
      { onChange: () => {}, onClosed: () => {} },
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImapAuthError);
  });
});
