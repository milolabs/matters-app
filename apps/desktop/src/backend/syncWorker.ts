// Entry of the sync worker thread, spawned by the router (main.ts). The one place in this
// thread that names concrete adapters. It never imports electron.

import "./traceStart.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { AutoconfigDiscovery } from "@matters/adapter-autoconfig";
import { ClaudeCodeRuntime } from "@matters/adapter-claude-code";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { createReceivedFiles } from "@matters/adapter-files";
import { ImapConnector } from "@matters/adapter-imap";
import { PostalMimeParser, visibleText } from "@matters/adapter-mime";
import { OllamaRuntime } from "@matters/adapter-ollama";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { NodemailerComposer, NodemailerSubmit } from "@matters/adapter-smtp";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { StoredAccount, TransportSecurity } from "@matters/core";
import { agentEnv } from "./agentEnv.ts";
import { DemoAgentRuntime } from "./demoAgent.ts";
import { DemoMail } from "./demoMail.ts";
import type { FromWorker, ToWorker, WorkerChannel, WorkerConfig } from "./protocol.ts";
import { startSyncRuntime } from "./syncRuntime.ts";
import { ThreadedFileWork } from "./threadedFileWork.ts";
import { mark } from "./trace.ts";

function testAccount(raw: string | null): StoredAccount | null {
  if (!raw) return null;
  const a = JSON.parse(raw) as {
    id: string;
    address: string;
    host: string;
    port: number;
    security: TransportSecurity;
    username: string;
    smtp?: { host: string; port: number; security: TransportSecurity; username: string };
  };
  return {
    id: a.id,
    address: a.address,
    displayName: a.address,
    imap: { host: a.host, port: a.port, security: a.security, username: a.username },
    ...(a.smtp ? { smtp: a.smtp } : {}),
    createdAtMs: Date.now(),
  };
}

const port = parentPort;
if (!port) throw new Error("syncWorker must run as a worker thread");
const config = workerData as WorkerConfig;

const channel: WorkerChannel = {
  post: (message: FromWorker) => port.postMessage(message),
  onMessage: (handler) => port.on("message", (m: ToWorker) => handler(m)),
};

// The first run creates and migrates the database; the router opens its reader after `ready`.
mkdirSync(dirname(config.dbPath), { recursive: true });
mark("worker-imports-done");
// An update of the schema says how far it is, so the window can say so (ADR 0103, rule 1). Two
// integers, no data.
const storage = createSqliteStorage(config.dbPath, {
  reader: false,
  onMigrationStep: (step, total) => port.postMessage({ type: "migrating", step, total }),
});
mark("worker-db-open");
await startSyncRuntime({
  storage,
  connector: new ImapConnector({
    parser: new PostalMimeParser({ registrableDomain }),
    registrableDomain,
  }),
  channel,
  discovery: new AutoconfigDiscovery(),
  registrableDomain,
  sending: {
    renderer: new MarkdownComposeRenderer(),
    composer: new NodemailerComposer(),
    submit: new NodemailerSubmit(),
    sha256: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
  },
  // The file work thread starts with the first attachment and retires when idle (ADR 0041).
  files: new ThreadedFileWork({
    dirs: { attachments: config.attachmentsDir, spool: config.spoolDir },
    spawn: () =>
      new Worker(config.attachmentWorker, {
        workerData: { attachments: config.attachmentsDir, spool: config.spoolDir },
      }),
  }),
  received: createReceivedFiles(config.receivedDir),
  // The demo's downloads have no server to ask; a real database never has this.
  ...(config.seed ? { demo: new DemoMail() } : {}),
  agent: {
    // The runtimes the person chooses from (ADR 0119, rule 2): their own `claude`, found on a
    // PATH that also holds the usual install places, and Ollama on this machine. Only the chosen
    // one ever runs a turn. A seeded demo run answers from canned facts instead, so it needs no
    // model (and never starts a program or asks a server); the seed is guarded in main.ts.
    runtimes: config.seed
      ? [new DemoAgentRuntime()]
      : [new ClaudeCodeRuntime({ env: agentEnv() }), new OllamaRuntime()],
    visibleText,
  },
  seed: config.seed,
  seedImages: config.seedImages,
  testAccount: testAccount(config.testAccount),
});

process.on("unhandledRejection", (reason) => {
  // The message of a rejection can only be ours or an adapter's, which scrub secrets.
  console.error(
    "matters-sync: unhandled rejection:",
    reason instanceof Error ? reason.message : "unknown",
  );
});
