// A sync worker over a scripted mail source, for the crash test. Same runtime as the real
// worker (syncRuntime.ts), a fake connector, and a hook that holds one batch open inside its
// unit of work so the test can kill the thread while the writer has uncommitted rows.
import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type {
  Account,
  Label,
  MailConnectorPort,
  MailSyncPort,
  MessageBody,
  SyncBatch,
  SyncCursor,
} from "@matters/core";
import {
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailAttachments,
  FakeMailFlags,
  FakeMailMoves,
  FakeMailSubmit,
  FakeMessageComposer,
  FakeSentFolder,
  makeDocument,
  makeLocation,
} from "@matters/testkit";
import type { FromWorker, ToWorker, WorkerChannel } from "../../src/backend/protocol.ts";
import { startSyncRuntime } from "../../src/backend/syncRuntime.ts";

export interface CrashWorkerConfig {
  readonly dbPath: string;
  readonly accountId: string;
  readonly batches: number;
  readonly batchSize: number;
  /** Hold this batch (1-based) open inside its unit of work until the thread is killed. */
  readonly stallBatch: number | null;
}

/** Posted to the parent while a batch is open and its rows are written but not committed. */
export interface InUnitSignal {
  readonly type: "test:inUnit";
  readonly batch: number;
}

const config = workerData as CrashWorkerConfig;
const port = parentPort;
if (!port) throw new Error("crashWorker must run as a worker thread");

const folder = (accountId: string): Label => ({
  id: "INBOX",
  accountId,
  name: "INBOX",
  role: "inbox",
  exclusive: true,
});

/** Oldest first: batch b holds UIDs (b-1)*size+1 .. b*size; the cursor is the last UID. */
const source: MailSyncPort = {
  capabilities: new Set(),
  listFolders: async (account: Account) => [folder(account.id)],
  async *syncFolder(account, _folder, cursor: SyncCursor | null): AsyncIterable<SyncBatch> {
    const from = Number(cursor?.lastUid ?? 0);
    const size = config.batchSize;
    for (let b = Math.floor(from / size) + 1; b <= config.batches; b++) {
      const documents = [];
      for (let uid = (b - 1) * size + 1; uid <= b * size; uid++) {
        documents.push({
          document: makeDocument(
            {
              accountId: account.id,
              providerId: `crash-${uid}`,
              threadId: `thread-${uid}`,
              subject: `Crash test ${uid}`,
              dateMs: Date.UTC(2024, 0, 1) + uid * 60_000,
            },
            `body of message ${uid} lorem ipsum`,
          ),
          location: makeLocation(uid, "INBOX", "1", account.id),
        });
      }
      yield {
        documents,
        knownLocations: [],
        flagUpdates: [],
        removedLocations: [],
        cursor: { uidValidity: "1", lastUid: String(b * size) },
      };
    }
  },
};

const connector: MailConnectorPort = {
  connect: async () => ({
    sync: source,
    sent: new FakeSentFolder(),
    flags: new FakeMailFlags(),
    moves: new FakeMailMoves(),
    attachments: new FakeMailAttachments(),
    close: async () => {},
    abort: () => {},
  }),
  watchInbox: async () => ({ close: async () => {} }),
};

const storage = createSqliteStorage(config.dbPath, { reader: false });

// Bodies are written inside the unit, after the message rows: stall here.
let batchNo = 0;
const putBodies = storage.bodies.putBodies.bind(storage.bodies);
storage.bodies.putBodies = async (batch: readonly MessageBody[]) => {
  await putBodies(batch);
  if (batch.length === 0) return;
  batchNo++;
  if (batchNo === config.stallBatch) {
    port.postMessage({ type: "test:inUnit", batch: batchNo } satisfies InUnitSignal);
    // Hold the writer thread busy so no JavaScript ends the transaction; the test terminates it.
    for (const end = Date.now() + 60_000; Date.now() < end; );
  }
};

const channel: WorkerChannel = {
  post: (message: FromWorker) => port.postMessage(message),
  onMessage: (handler) => port.on("message", (m: ToWorker) => handler(m)),
};

await startSyncRuntime({
  storage,
  connector,
  channel,
  discovery: { discover: async () => null },
  registrableDomain,
  files: new FakeFileWork(),
  sending: {
    renderer: new FakeComposeRenderer(),
    composer: new FakeMessageComposer(),
    submit: new FakeMailSubmit(),
    sha256: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
  },
  testAccount: {
    id: config.accountId,
    address: "crash@example.com",
    displayName: "Crash",
    imap: { host: "127.0.0.1", port: 1, security: "none", username: "crash" },
    createdAtMs: 1,
  },
});
