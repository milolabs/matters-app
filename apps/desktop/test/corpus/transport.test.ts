// Corpus, transport tier (ADR 0047): the real IMAP connection, SMTP submission, server prober and
// autoconfig adapter against hostile servers on real local sockets with real TLS. Certificates are
// made at test time. A control case per mode proves the servers work before any refusal counts.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { connect as connectTls } from "node:tls";
import { fileURLToPath } from "node:url";
import { AutoconfigDiscovery, probeServer } from "@matters/adapter-autoconfig";
import { openConnection } from "@matters/adapter-imap";
import { NodemailerSubmit } from "@matters/adapter-smtp";
import type { TransportSecurity } from "@matters/core";
import type { Check, CorpusCase } from "@matters/testkit/corpus";
import { afterAll, beforeAll, describe } from "vitest";
import { makePki, type TestPki } from "./support/certs.ts";
import {
  type Behaviour,
  type HostileServer,
  startHostileServer,
} from "./support/hostileServers.ts";
import { runTier } from "./support/run.ts";
import { tlsApi } from "./support/tlsApi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const USER = "corpus-user";
const PASSWORD = "corpus-password-not-real";
const b64 = (s: string) => Buffer.from(s).toString("base64");

let pki: TestPki;
let restoreTrust: () => void = () => {};
beforeAll(() => {
  pki = makePki();
  // The control cases need a CA the process trusts: this process only, and put back afterwards.
  const before = tlsApi.getCACertificates("default");
  tlsApi.setDefaultCACertificates([...before, pki.caPem]);
  restoreTrust = () => tlsApi.setDefaultCACertificates(before);
});
afterAll(() => {
  restoreTrust();
  pki.dispose();
});

type Mode = "tls" | "starttls" | "none" | "probe";
interface Outcome {
  connected: boolean;
  /** Why the client gave up, when it did. */
  error: string;
  /** The client reached the server at all. */
  socketOpened: boolean;
  server: HostileServer;
}

const credentialLine = /^(?:\S+ )?(?:login|authenticate|auth)\b/i;
const mailLine = /^(?:mail|rcpt|data)\b/i;
const sawPassword = (lines: readonly string[]) =>
  lines.some(
    (l) =>
      credentialLine.test(l) ||
      l.includes(PASSWORD) ||
      l.includes(b64(PASSWORD)) ||
      l.includes(b64(`\0${USER}\0${PASSWORD}`)),
  );

/** One client against one hostile server. The client is the product's own code. */
async function attempt(
  protocol: "imap" | "smtp",
  mode: Exclude<Mode, "probe">,
  behaviour: Omit<Behaviour, "protocol">,
): Promise<Outcome> {
  const server = await startHostileServer({ protocol, ...behaviour });
  const security: TransportSecurity = mode;
  let connected = false;
  let error = "";
  try {
    if (protocol === "imap") {
      const run = openConnection({
        host: "127.0.0.1",
        port: server.port,
        security,
        auth: { user: USER, pass: PASSWORD },
      });
      const guarded = await Promise.race([
        run.then(
          (c) => c,
          (e: unknown) => {
            error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            return null;
          },
        ),
        new Promise<null>((r) =>
          setTimeout(() => {
            error ||= "timed out";
            r(null);
          }, 8000),
        ),
      ]);
      if (guarded) {
        connected = true;
        await guarded.client.logout().catch(() => guarded.client.close());
      }
    } else {
      const check = await new NodemailerSubmit({
        connectionTimeoutMs: 5000,
        greetingTimeoutMs: 5000,
        socketTimeoutMs: 5000,
      }).verify({
        server: { host: "127.0.0.1", port: server.port, security, username: USER },
        credential: { kind: "password", username: USER, password: PASSWORD },
      });
      connected = check.ok;
      if (!check.ok) error = `${check.kind}: ${check.reason}`;
    }
  } finally {
    // Let the server see the last bytes before it is judged.
    await new Promise((r) => setTimeout(r, 100));
    await server.stop();
  }
  return { connected, error, socketOpened: server.log.connections > 0, server };
}

/** The TLS 1.1 server really speaks 1.1: a client that accepts it connects. Without this the refusal proves nothing. */
async function assertServerSpeaksTls11(): Promise<void> {
  const server = await startHostileServer({
    protocol: "imap",
    implicit: true,
    pki: pki.good,
    tlsVersions: { minVersion: "TLSv1", maxVersion: "TLSv1.1" },
  });
  try {
    const version = await new Promise<string>((resolve, reject) => {
      const socket = connectTls(
        {
          host: "127.0.0.1",
          port: server.port,
          minVersion: "TLSv1",
          maxVersion: "TLSv1.1",
          servername: "localhost",
        },
        () => {
          resolve(socket.getProtocol() ?? "");
          socket.destroy();
        },
      );
      socket.on("error", reject);
    });
    if (version !== "TLSv1.1")
      throw new Error(
        `the test server did not speak TLS 1.1 (${version}); this case cannot run here`,
      );
  } finally {
    await server.stop();
  }
}

/** Control for "no password in plaintext": with the opt-in the same client does send it, and the detector sees it. */
async function assertPlaintextDetectorWorks(protocol: "imap" | "smtp"): Promise<void> {
  const server = await startHostileServer({ protocol, offerPlainLogin: true });
  try {
    if (protocol === "imap") {
      const c = await openConnection({
        host: "127.0.0.1",
        port: server.port,
        security: "none",
        allowInsecure: true,
        auth: { user: USER, pass: PASSWORD },
      });
      await c.client.logout().catch(() => c.client.close());
    } else {
      await new NodemailerSubmit({ allowInsecure: true }).verify({
        server: { host: "127.0.0.1", port: server.port, security: "none", username: USER },
        credential: { kind: "password", username: USER, password: PASSWORD },
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    if (!sawPassword(server.log.plain))
      throw new Error(
        `control failed: the ${protocol} client opted in to plaintext and the server saw no login`,
      );
  } finally {
    await server.stop();
  }
}

const modeKey = (key: string) => key.split(".") as ["imap" | "smtp", Mode];

const good = () => pki.good;
const SCENARIOS: Record<string, (mode: "tls" | "starttls") => Omit<Behaviour, "protocol">> = {
  "transport-tls-valid-control": (m) => ({
    pki: good(),
    implicit: m === "tls",
    offerStarttls: m === "starttls",
  }),
  "transport-tls-self-signed": (m) => ({
    pki: pki.selfSigned,
    implicit: m === "tls",
    offerStarttls: m === "starttls",
  }),
  "transport-tls-wrong-hostname": (m) => ({
    pki: pki.wrongHost,
    implicit: m === "tls",
    offerStarttls: m === "starttls",
  }),
  "transport-tls-expired": (m) => ({
    pki: pki.expired,
    implicit: m === "tls",
    offerStarttls: m === "starttls",
  }),
  "transport-tls-unknown-ca": (m) => ({
    pki: pki.unknownCa,
    implicit: m === "tls",
    offerStarttls: m === "starttls",
  }),
  "transport-tls-below-1-2": (m) => ({
    pki: good(),
    implicit: m === "tls",
    offerStarttls: m === "starttls",
    tlsVersions: { minVersion: "TLSv1", maxVersion: "TLSv1.1" },
  }),
};

const GOOD_XML = (host = "imap.example.org", extra = "") =>
  `<clientConfig><emailProvider id="example.org"><incomingServer type="imap"><hostname>${host}</hostname><port>993</port><socketType>SSL</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer>${extra}</emailProvider></clientConfig>`;

const response = (body: string, url: string, length?: number) => ({
  ok: true,
  url,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "content-length" && length !== undefined ? String(length) : null,
  },
  text: async () => body,
});

/** Discovery with every network step replaced: documents come from `serve`, DNS and probing say nothing. */
function discovery(
  serve: (url: string) => ReturnType<typeof response>,
  srv?: (
    name: string,
  ) => Promise<never[] | { name: string; port: number; priority: number; weight: number }[]>,
) {
  return new AutoconfigDiscovery({
    fetch: async (url) => serve(url),
    resolveSrv: srv ?? (async () => Promise.reject(new Error("no records"))),
    resolveMx: async () => [],
    probe: async () => false,
    timeoutMs: 1000,
  });
}
const summary = (found: Awaited<ReturnType<AutoconfigDiscovery["discover"]>>) =>
  found ? { source: found.source, imap: found.imap, smtp: found.smtp ?? null } : null;

async function autoconfig(c: CorpusCase): Promise<Record<string, unknown>> {
  // Control: the same discovery finds a plain, correct document over HTTPS. Without it a stub that
  // returned nothing would make every refusal below true.
  const control = await discovery((url) => response(GOOD_XML(), url)).discover("example.org");
  if (control?.imap?.security !== "tls")
    throw new Error("control failed: a correct HTTPS document was not discovered");
  switch (c.id) {
    case "transport-autoconfig-http-response":
      return {
        discovered: summary(
          await discovery((url) => response(GOOD_XML(), url.replace(/^https:/, "http:"))).discover(
            "example.org",
          ),
        ),
      };
    case "transport-autoconfig-plaintext-socket": {
      const plain = `<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>plain</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer><outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>25</port><socketType>plain</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></outgoingServer></emailProvider></clientConfig>`;
      return {
        discovered: summary(await discovery((url) => response(plain, url)).discover("example.org")),
      };
    }
    case "transport-autoconfig-hostile-hostname": {
      const hosts = [
        "evil.test/path",
        "evil.test:25",
        "%EMAILADDRESS%",
        "a b.test",
        "user@evil.test",
        "[::1]",
      ];
      const out = [];
      for (const h of hosts)
        out.push(
          summary(await discovery((url) => response(GOOD_XML(h), url)).discover("example.org")),
        );
      return { discovered: out };
    }
    case "transport-autoconfig-xml-entities": {
      const laughs = `<?xml version="1.0"?><!DOCTYPE c [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>${GOOD_XML("&c;.example.org")}`;
      const external = `<?xml version="1.0"?><!DOCTYPE c [<!ENTITY x SYSTEM "file:///etc/hosts">]>${GOOD_XML("&x;")}`;
      const started = performance.now();
      const out = [];
      for (const doc of [laughs, external])
        out.push(summary(await discovery((url) => response(doc, url)).discover("example.org")));
      return { discovered: out, finishesWithinMs: performance.now() - started < 3000 };
    }
    case "transport-autoconfig-oversized": {
      const big = GOOD_XML("imap.example.org", `<!-- ${"x".repeat(3_000_000)} -->`);
      const a = summary(await discovery((url) => response(big, url)).discover("example.org"));
      const b = summary(await discovery((url) => response(big, url, 50)).discover("example.org"));
      return { discovered: [a, b] };
    }
    case "transport-autoconfig-srv-cleartext-only": {
      const found = await discovery(
        (url) => ({ ...response("", url), ok: false }),
        async (name) =>
          name.startsWith("_imap._tcp.")
            ? [{ name: "imap.example.org", port: 143, priority: 0, weight: 0 }]
            : Promise.reject(new Error("none")),
      ).discover("example.org");
      return { securityChosen: found?.imap.security ?? null };
    }
    default:
      throw new Error(`no autoconfig probe for ${c.id}`);
  }
}

function productSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test" || name === "out") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:ts|tsx)$/.test(name)) out.push(p);
    }
  };
  for (const pkg of readdirSync(join(root, "packages"))) {
    try {
      walk(join(root, "packages", pkg, "src"));
    } catch {
      /* package without src */
    }
  }
  walk(join(root, "apps/desktop/src"));
  return out;
}

async function source(c: CorpusCase): Promise<Record<string, unknown>> {
  if (c.id === "transport-plaintext-opt-in-in-a-packaged-app") {
    // Whether main takes the plaintext opt-in out of the environment of a packaged app, as it does for the trace file.
    return {
      mainDropsOptInWhenPackaged: /ALLOW_INSECURE/.test(
        readFileSync(join(root, "apps/desktop/src/main/index.ts"), "utf8"),
      ),
    };
  }
  const dangerous =
    /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity|certificate-error|ignore-certificate-errors|ignoreCertificateErrors|setCertificateVerifyProc|allowInsecureCerts/;
  const hits: string[] = [];
  for (const file of productSources()) {
    if (dangerous.test(readFileSync(file, "utf8"))) hits.push(relative(root, file));
  }
  return { occurrencesOutsideTests: hits };
}

async function measure(c: CorpusCase, checks: readonly Check[]): Promise<Record<string, unknown>> {
  const spec = c.tiers.transport;
  const protocols = spec?.protocols ?? [];
  if (protocols[0] === "autoconfig") return autoconfig(c);
  if (protocols[0] === "source") return source(c);

  const connected: Record<string, boolean> = {};
  const plaintext: Record<string, boolean> = {};
  const overTls: Record<string, boolean> = {};
  const opened: Record<string, boolean> = {};
  const beforeTls: Record<string, string[]> = {};
  const probed: Record<string, string[]> = {};
  const errors: Record<string, string> = {};
  for (const key of protocols) {
    const [protocol, mode] = modeKey(key);
    if (mode === "probe") {
      const server = await startHostileServer({
        protocol,
        offerStarttls: true,
        starttlsAnswer: "refuse",
        pki: pki.good,
      });
      try {
        await probeServer(protocol, "127.0.0.1", server.port, "starttls", 1500);
      } finally {
        await new Promise((r) => setTimeout(r, 100));
        await server.stop();
      }
      probed[key] = server.log.plain.filter((l) => credentialLine.test(l) || mailLine.test(l));
      plaintext[key] = sawPassword(server.log.plain);
      continue;
    }
    let outcome: Outcome;
    if (c.id === "transport-starttls-stripped") {
      outcome = await attempt(protocol, "starttls", {
        offerStarttls: false,
        offerPlainLogin: true,
      });
    } else if (c.id === "transport-starttls-refused") {
      outcome = await attempt(protocol, "starttls", {
        pki: pki.good,
        offerStarttls: true,
        starttlsAnswer: "refuse",
        offerPlainLogin: true,
      });
    } else if (c.id === "transport-login-after-probe-claiming-starttls") {
      const server = await startHostileServer({
        protocol,
        offerStarttls: true,
        starttlsAnswer: "refuse",
        pki: pki.good,
      });
      await probeServer(protocol, "127.0.0.1", server.port, "starttls", 1500);
      await server.stop();
      outcome = await attempt(protocol, "starttls", {
        pki: pki.good,
        offerStarttls: true,
        starttlsAnswer: "refuse",
        offerPlainLogin: true,
      });
    } else if (c.id === "transport-starttls-response-injection") {
      outcome = await attempt(protocol, "starttls", {
        pki: pki.good,
        offerStarttls: true,
        injectWithStarttlsOk:
          protocol === "imap" ? "* BYE injected plaintext\r\n" : "421 4.3.2 injected shutdown\r\n",
      });
    } else if (c.id === "transport-implicit-tls-port-speaks-plaintext") {
      outcome = await attempt(protocol, "tls", { offerPlainLogin: true });
    } else if (c.id === "transport-plaintext-refused-without-opt-in") {
      await assertPlaintextDetectorWorks(protocol);
      outcome = await attempt(protocol, "none", { offerPlainLogin: true });
    } else {
      const scenario = SCENARIOS[c.id];
      if (!scenario || (mode !== "tls" && mode !== "starttls"))
        throw new Error(`no transport scenario for ${c.id} ${key}`);
      outcome = await attempt(protocol, mode, scenario(mode));
      // A refusal for the wrong reason (a timeout, a crashed test server) would pass for the right one.
      if (
        c.id !== "transport-tls-valid-control" &&
        !outcome.connected &&
        !/tls|ssl|certificate|self.signed|self-signed|altname|hostname|expired|verify|protocol|alert|handshake|version/i.test(
          outcome.error,
        )
      ) {
        throw new Error(`${key} was refused, but not for a TLS reason: ${outcome.error}`);
      }
      if (c.id === "transport-tls-below-1-2") await assertServerSpeaksTls11();
    }
    errors[key] = outcome.error;
    connected[key] = outcome.connected;
    opened[key] = outcome.socketOpened;
    plaintext[key] = sawPassword(outcome.server.log.plain);
    overTls[key] = sawPassword(outcome.server.log.secure);
    beforeTls[key] = outcome.server.log.plain
      .filter((l) => credentialLine.test(l) || mailLine.test(l))
      .map((l) => l.split(" ").slice(0, 2).join(" ").toLowerCase());
    // The injection case is "processed" when the client did not carry on.
  }
  void checks;
  const keys = (m: Record<string, unknown>) => m;
  return {
    connected: keys(connected),
    passwordSeenInPlaintext: keys(plaintext),
    passwordSeenOverTls: keys(overTls),
    socketOpened: keys(opened),
    commandsBeforeTlsOtherThanDiscovery: keys(beforeTls),
    // Refusing the session (imapflow detects it) and ignoring the bytes are both fine: what counts is whether the client acted on them.
    injectedPlaintextProcessed: Object.fromEntries(
      Object.entries(errors).map(([k, e]) => [k, /injected (?:plaintext|shutdown)/i.test(e)]),
    ),
    credentialCommandsSent: keys(probed),
  };
}

void createHash;
describe("corpus transport tier", () => {
  runTier("transport", measure, { timeoutMs: 120_000 });
});
