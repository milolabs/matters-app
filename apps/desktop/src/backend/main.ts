// Backend utility process, router thread (ADR 0005, 0019). It serves every renderer read on
// its own read-only SQLite connection and never writes or talks to a mail server: that work
// runs in the sync worker thread (syncWorker.ts), which this thread supervises. Passwords are
// not here either: they live in the main process and pass through the router untouched, over
// the dedicated port main hands over.
import "./traceStart.ts";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { AutoconfigDiscovery } from "@matters/adapter-autoconfig";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import type { RpcPort } from "@matters/adapter-secrets";
import { createSqliteReader, createSqliteReaderIfCurrent } from "@matters/adapter-sqlite";
import type { BackendEvent, NoticeToMain } from "@matters/contracts";
import { ANALYZER_VERSION, type SyncStatus } from "@matters/core";
import { shownReading } from "./agentReads.ts";
import { toAttachmentInfo } from "./attachmentInfo.ts";
import {
  BOOT_STAGE_MESSAGE,
  BOOT_START,
  type BootEvent,
  type BootReport,
  nextBootReport,
} from "./bootStage.ts";
import { CredentialRelay } from "./credentialRelay.ts";
import { type Grant, GrantBook } from "./grantBook.ts";
import { type BackendDeps, FINISHED_VISIBLE_MS, handle } from "./handler.ts";
import { serveHeavyRead } from "./heavyReads.ts";
import { LimitProbe } from "./limitProbe.ts";
import { summariseMoves } from "./moveSummary.ts";
import { Notifier } from "./notifier.ts";
import { promptFits } from "./promptFits.ts";
import type { WorkerConfig } from "./protocol.ts";
import { ChangePublisher } from "./publisher.ts";
import { ReadThread } from "./readThread.ts";
import { RemoteAccounts } from "./remoteAccounts.ts";
import { RemoteAgent } from "./remoteAgent.ts";
import { RemoteAttachments } from "./remoteAttachments.ts";
import { RemoteCounts } from "./remoteCounts.ts";
import { RemoteImageRules } from "./remoteImageRules.ts";
import { RemoteMoves } from "./remoteMoves.ts";
import { RemoteReceived } from "./remoteReceived.ts";
import { RemoteSeen } from "./remoteSeen.ts";
import { RemoteSend } from "./remoteSend.ts";
import { RemoteViews } from "./remoteViews.ts";
import { StorageService } from "./storageService.ts";
import { SyncHost } from "./syncHost.ts";
import { mark } from "./trace.ts";

interface MessagePortLike {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
}
// Electron's utility-process global; it is not part of @types/node.
interface ParentPort {
  on(event: "message", listener: (e: { data: unknown; ports: MessagePortLike[] }) => void): void;
  postMessage(message: unknown): void;
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;

/** Main hears how far startup is, for the loading screen (ADR 0103, rule 1); never any data. */
let boot: BootReport = BOOT_START;
function reportBoot(event: BootEvent): void {
  const next = nextBootReport(boot, event);
  if (next === boot) return;
  boot = next;
  parentPort.postMessage({ type: BOOT_STAGE_MESSAGE, ...next });
}

/** The port to main for credentials: it arrives after start, so the client waits for it. */
let provideCredentialPort: (port: RpcPort) => void = () => {};
const credentialPort = new Promise<RpcPort>((resolve) => {
  provideCredentialPort = resolve;
});
/**
 * The port to main for grants (ADR 0041, rule 3): main sends the paths it minted grants for, and
 * hears when a copy ended. It is not the renderer's port and not the credentials' either.
 */
let grantPort: MessagePortLike | null = null;
const rendererPorts = new Set<MessagePortLike>();
/**
 * Main's own line (ADR 0043, rule 10), which also carries the banners and the badge (ADR 0071,
 * rule 8). What comes before main hands it over waits, the latest badge and a few banners.
 */
let mainLine: MessagePortLike | null = null;
let waitingForMain: NoticeToMain[] = [];
const toMain = (event: NoticeToMain) => {
  if (mainLine) {
    mainLine.postMessage(event);
    return;
  }
  if (event.type === "badge") waitingForMain = waitingForMain.filter((e) => e.type !== "badge");
  waitingForMain = [...waitingForMain, event].slice(-10);
};
const broadcast = (event: BackendEvent) => {
  for (const port of rendererPorts) port.postMessage(event);
};

interface Backend {
  /** Read paths only, on the reader connection: the UI never sees an open unit of work. */
  readonly deps: BackendDeps;
  /** What main has granted and the page has not used yet. */
  readonly grants: GrantBook;
  /** Tells every window which moves are still inside their undo window (a window just opened). */
  announceMoves(): void;
  /** A window just opened: a catch-up said a moment ago reaches it too, and only it. */
  windowOpened(send: (event: BackendEvent) => void): void;
  close(): Promise<void>;
}

/** Stop budget for the worker: its own wait for connections is 2.5 s, main waits 6 s. */
const WORKER_STOP_MS = 3000;

/**
 * The only place that names the backend's concrete pieces. Main decides where the database
 * lives and passes the path in `MATTERS_DB_PATH`; this process never imports electron.
 */
async function createBackend(): Promise<Backend> {
  const path = process.env.MATTERS_DB_PATH;
  if (!path) throw new Error("MATTERS_DB_PATH is not set");
  const workerPath = process.env.MATTERS_SYNC_WORKER;
  if (!workerPath) throw new Error("MATTERS_SYNC_WORKER is not set");
  const attachmentWorker = process.env.MATTERS_ATTACHMENT_WORKER;
  if (!attachmentWorker) throw new Error("MATTERS_ATTACHMENT_WORKER is not set");
  const attachmentsDir = process.env.MATTERS_ATTACHMENTS_DIR;
  const spoolDir = process.env.MATTERS_SPOOL_DIR;
  if (!attachmentsDir || !spoolDir) {
    throw new Error("MATTERS_ATTACHMENTS_DIR and MATTERS_SPOOL_DIR are not set");
  }
  const receivedDir = process.env.MATTERS_RECEIVED_DIR;
  if (!receivedDir) throw new Error("MATTERS_RECEIVED_DIR is not set");
  const readWorker = process.env.MATTERS_READ_WORKER;
  if (!readWorker) throw new Error("MATTERS_READ_WORKER is not set");
  const startedAt = performance.now();
  // One line per start; the smoke driver reads it to tell a cold start from a warm one. It is
  // written when the worker is ready, which with an early reader is after reads are served.
  const logReady = (seededCount: number) =>
    console.log(
      `matters-backend: db=${path} seeded=${seededCount} ready=${Math.round(performance.now() - startedAt)}ms`,
    );
  const statuses = new Map<string, SyncStatus>();
  const relay = new CredentialRelay(credentialPort);
  let publisher: ChangePublisher | null = null;
  let notifier: Notifier | null = null;
  // A batch the worker committed before the publisher exists (reads are served before the worker
  // is up, ADR 0046); the publisher starts from the store's sequence, so it announces it at once.
  let committedEarly = false;
  let attachments: RemoteAttachments | null = null;
  let reader: ReturnType<typeof createSqliteReader> | null = null;

  const config: WorkerConfig = {
    dbPath: path,
    // Demo mail exists for the smoke runs only; a real database is never seeded.
    seed: process.env.MATTERS_SEED === "1",
    seedImages: process.env.MATTERS_SEED === "1" && process.env.MATTERS_SMOKE !== "1",
    testAccount: process.env.MATTERS_TEST_ACCOUNT ?? null,
    attachmentsDir,
    spoolDir,
    attachmentWorker,
    receivedDir,
  };
  // A grant that ended (copy done, or never used) lets main delete a pasted image's temp file.
  const grants = new GrantBook({
    onEnd: (grantId) => grantPort?.postMessage({ type: "release", grantId }),
  });
  const expiry = setInterval(() => grants.expire(), 60_000);
  expiry.unref();
  const host = new SyncHost({
    spawn: () => new Worker(workerPath, { workerData: config }),
    handlers: {
      onStatus(accountId, status) {
        statuses.set(accountId, status);
        broadcast({ type: "syncStatus", accountId, status });
      },
      onCommitted: () => {
        if (publisher) publisher.touch();
        else committedEarly = true;
        notifier?.touched();
      },
      onOutbox: () => {
        void publishOutbox();
        // A reply in the outbox takes its thing out of Matters, and an undone or failed one brings
        // it back (ADR 0112): every window reads the list again, and the badge counts again.
        announceAgent();
        notifier?.thingsChanged();
      },
      onMoves: () => void publishMoves(),
      onAgent: () => {
        announceAgent();
        notifier?.agentChanged();
      },
      onAgentTalkStep: (query, threads, kind, note) =>
        broadcast({
          type: "agentTalkStep",
          query,
          threads,
          ...(kind === undefined ? {} : { kind }),
          ...(note === undefined ? {} : { note }),
        }),
      onAgentPrompt: (progress) => {
        broadcast({ type: "agentPromptProgress", ...progress });
        // Verdicts may have landed: mail a view with a prompt holds may notify (ADR 0117, rule 6).
        if (progress.phase === "reading") notifier?.promptsChanged();
      },
      onViews: () => broadcast({ type: "viewsChanged" }),
      onMoveRefused: (action, count) => broadcast({ type: "moveRefused", action, count }),
      onAttachments: (draftId) => void publishAttachments(draftId),
      onAttachmentProgress: (id, fraction) =>
        broadcast({ type: "attachmentProgress", id, fraction }),
      onReceivedProgress: (messageKey, partId, bytes, totalBytes) =>
        broadcast({ type: "receivedProgress", messageKey, partId, bytes, totalBytes }),
      onSendProgress: (operationId, sentBytes, totalBytes) =>
        broadcast({ type: "sendProgress", operationId, sentBytes, totalBytes }),
      onCaptured: (ids) => attachments?.captured(ids),
      onSynced: (accountId, scope, documents, durationMs) => {
        console.log(
          `matters-backend: synced account=${accountId} scope=${scope} documents=${documents} ms=${durationMs}`,
        );
        notifier?.synced(accountId);
      },
      onCredentials: (data, reply) => relay.fromWorker(data, reply),
      onCrash(reason) {
        console.error(`matters-backend: sync worker stopped (${reason}); restarting`);
        void reportSyncDown();
      },
      onRestarted: () => console.log("matters-backend: sync worker restarted"),
      onMigrating: (step, total) => reportBoot({ kind: "migrating", step, total }),
    },
  });

  // The list of sends in progress, read on the reader connection after the worker committed.
  let outboxChain: Promise<void> = Promise.resolve();
  function publishOutbox(): Promise<void> {
    outboxChain = outboxChain
      .then(async () => {
        if (!reader) return;
        const operations = await reader.read.outbox.listVisible(Date.now() - FINISHED_VISIBLE_MS);
        broadcast({ type: "outbox", operations });
      })
      .catch(() => {
        // a failed read only delays the next event
      });
    return outboxChain;
  }

  // Agents wrote something: one event is enough for the page to ask again, so a pass that stores
  // result after result is told at most four times a second. The event carries no data, only
  // whether a request changed the status itself, which is kept while events are held (ADR 0115).
  let agentTimer: ReturnType<typeof setTimeout> | null = null;
  let agentDirty = false;
  let agentStatusDirty = false;
  function announceAgent(status = false): void {
    if (agentTimer) {
      agentDirty = true;
      agentStatusDirty ||= status;
      return;
    }
    broadcast(status ? { type: "agentChanged", status: true } : { type: "agentChanged" });
    agentTimer = setTimeout(() => {
      agentTimer = null;
      if (agentDirty) {
        const held = agentStatusDirty;
        agentDirty = false;
        agentStatusDirty = false;
        announceAgent(held);
      }
    }, 250);
  }

  // The moves still inside their window, read on the reader connection after the worker committed.
  let movesChain: Promise<void> = Promise.resolve();
  function publishMoves(): Promise<void> {
    movesChain = movesChain
      .then(async () => {
        if (!reader) return;
        const [rows, folders] = await Promise.all([
          reader.read.moveOps.listPending(),
          reader.read.store.listFolders(),
        ]);
        broadcast({ type: "moves", operations: summariseMoves(rows, folders) });
      })
      .catch(() => {
        // a failed read only delays the next event
      });
    return movesChain;
  }

  // The files of a draft, read on the reader connection after the worker committed.
  let attachmentsChain: Promise<void> = Promise.resolve();
  function publishAttachments(draftId: string): Promise<void> {
    attachmentsChain = attachmentsChain
      .then(async () => {
        if (!reader) return;
        const rows = await reader.read.attachments.forDraft(draftId);
        broadcast({ type: "attachments", draftId, attachments: rows.map(toAttachmentInfo) });
      })
      .catch(() => {
        // a failed read only delays the next event
      });
    return attachmentsChain;
  }

  // Reads keep working while the worker is down; the accounts show why nothing syncs.
  async function reportSyncDown(): Promise<void> {
    const message = "The sync process stopped unexpectedly and is restarting";
    for (const a of (await reader?.read.accounts.list()) ?? []) {
      const status: SyncStatus = { state: "error", kind: "other", message };
      statuses.set(a.id, status);
      broadcast({ type: "syncStatus", accountId: a.id, status });
    }
  }

  // ADR 0046, rule 1. A database that exists and is at this build's schema needs nothing from the
  // worker before it can be read, so the reader opens at once and the worker starts beside it.
  // Anything else (no file yet, an older schema to migrate, a newer one to refuse) waits for the
  // worker, which creates and migrates the database; only then can a reader open it.
  mark("backend-imports-done");
  // The benchmark can take the slow path on purpose (dev builds only: the trace file is never set
  // in a packaged app), to measure the wait for the worker on a database that needs none.
  const forceWait = !!process.env.MATTERS_TRACE_FILE && process.env.MATTERS_TRACE_WAIT === "1";
  const early = forceWait ? null : createSqliteReaderIfCurrent(path);
  mark(early ? "reader-open-early" : "reader-wait");
  reportBoot({ kind: "open" });
  const started = host.start();
  // The thread for long reads (ADR 0070, rule 2). It opens the database itself, so it starts once the
  // database can be read: beside the worker when it can already, after it when the worker must make it.
  const agentReads = (from: NonNullable<typeof reader>["read"]) => ({
    insights: from.agentInsights,
    settings: from.agentSettings,
    store: from.store,
    accounts: from.accounts,
    sends: { outbox: from.outbox, drafts: from.drafts },
    storage: from.storageUsage,
  });
  const heavy = new ReadThread({
    spawn: () => new Worker(readWorker, { workerData: { dbPath: path } }),
    local: (read, nowMs) => {
      if (!reader) throw new Error("the database is not open");
      // Reading the whole database here would hold every list and thread for seconds.
      if (read.name === "storageMeasure") throw new Error("the read thread is not running");
      return serveHeavyRead(agentReads(reader.read), read, nowMs);
    },
    onDown: (reason) => {
      if (!closing) console.error(`matters-backend: read thread stopped (${reason})`);
    },
  });
  let closing = false;
  if (early) heavy.start();
  let seeded = 0;
  if (early) {
    reader = early;
    void started.then(
      (worker) => {
        mark("worker-ready");
        logReady(worker.seeded);
      },
      (error: unknown) => {
        // The worker owns the database file; without it nothing can be written.
        console.error("matters-backend: failed to start:", error);
        void shutdown(1);
      },
    );
  } else {
    seeded = (await started).seeded;
    mark("worker-ready");
    reader = createSqliteReader(path);
    mark("reader-open");
    heavy.start();
  }
  const initial = new ChangePublisher(reader.read.store, broadcast);
  await initial.init();
  publisher = initial;
  if (committedEarly) initial.touch();
  mark("publisher-ready");
  // Notifications (ADR 0071, 0106): the settings and what the watch knows live next to the
  // database, as files of this computer.
  const readNow = reader.read;
  const notices = new Notifier({
    read: {
      index: readNow.index,
      store: readNow.store,
      arrivals: readNow.arrivals,
      views: readNow.views,
      accounts: readNow.accounts,
    },
    prefsPath: path === ":memory:" ? null : join(dirname(path), "notifications.json"),
    statePath: path === ":memory:" ? null : join(dirname(path), "notifications-state.json"),
    things: {
      readings: (threadIds) => readNow.agentInsights.listAnalyses(ANALYZER_VERSION, threadIds),
      shown: (threadId) => shownReading(agentReads(readNow), threadId),
      // The Matters tab's own read, on the read thread; no row is filled (ADR 0109).
      count: async () => (await heavy.ask({ name: "things", limit: 0 })).total,
    },
    prompts: {
      fits: (query, threadIds) =>
        promptFits({ store: readNow.store, insights: readNow.agentInsights }, query, threadIds),
      // On the worker, where the kept search is walked (ADR 0117, rule 4).
      badge: (query) => host.command({ name: "agentPromptBadge", query }),
    },
    toMain,
    broadcast,
  });
  notifier = notices;
  // It goes on from what it kept, or takes what is there now as seen; the window does not wait.
  void notices.start();
  const accounts = new RemoteAccounts({
    accounts: reader.read.accounts,
    discovery: new AutoconfigDiscovery(),
    host,
    statuses,
    onChanged: () => {
      broadcast({ type: "accountsChanged" });
      publisher?.touch();
    },
  });

  attachments = new RemoteAttachments(host, grants);
  const limits = new LimitProbe(
    (accountId) => host.command({ name: "probeMessageLimit", accountId }),
    (accountId, limitBytes) => broadcast({ type: "messageLimit", accountId, limitBytes }),
  );

  if (!early) logReady(seeded);
  const { read } = reader;
  // Settings › Storage (ADR 0089): read on the read thread, kept by the worker, once a day too.
  const storage = new StorageService(heavy, host);
  const stopStorageSamples = storage.startDaily((error) =>
    console.error(
      "matters-backend: storage sample:",
      error instanceof Error ? error.message : "unknown",
    ),
  );
  mark("backend-ready");
  reportBoot({ kind: "ready" });
  return {
    deps: {
      ...read,
      accountStore: read.accounts,
      renderer: new MarkdownComposeRenderer(),
      accounts,
      send: new RemoteSend(host),
      attachmentWrites: attachments,
      attachmentRows: read.attachments,
      limits,
      received: new RemoteReceived(host),
      savedViews: read.views,
      viewWrites: new RemoteViews(host),
      imageRules: read.imageRules,
      images: new RemoteImageRules(host, () => broadcast({ type: "imageRulesChanged" })),
      seen: new RemoteSeen(host),
      moves: new RemoteMoves(host),
      registrableDomain,
      counts: new RemoteCounts(host),
      agent: new RemoteAgent(host, agentReads(read), heavy, () => announceAgent(true)),
      notifications: notices,
      storage,
    },
    grants,
    announceMoves: () => void publishMoves(),
    windowOpened: (send) => notifier?.windowOpened(send),
    async close() {
      stopStorageSamples();
      clearInterval(expiry);
      if (agentTimer) clearTimeout(agentTimer);
      closing = true;
      notifier?.stop();
      await heavy.stop();
      // The worker closes its connections and the writer first, then the reader goes.
      await host.stop(WORKER_STOP_MS);
      publisher?.stop();
      reader?.close();
    },
  };
}

/** A grant as main sent it; anything else is not a grant and is dropped by the book's checks. */
function grantFrom(data: unknown): Grant {
  const g = (data ?? {}) as Partial<Record<keyof Grant, unknown>>;
  return {
    grantId: typeof g.grantId === "string" ? g.grantId : "",
    path: typeof g.path === "string" ? g.path : "",
    name: typeof g.name === "string" ? g.name : "",
    size: typeof g.size === "number" ? g.size : 0,
  };
}

const ready = createBackend();

/** Closes everything once; safe to call from every exit path. */
let closed = false;
async function shutdown(code: number): Promise<never> {
  if (!closed) {
    closed = true;
    try {
      await (await ready).close();
    } catch {
      // never opened, or already closed: nothing left to release
    }
  }
  process.exit(code);
}

parentPort.on("message", ({ data, ports }) => {
  const type = (data as { type?: unknown } | null)?.type;
  if (type === "shutdown") {
    void shutdown(0);
    return;
  }
  const port = ports[0];
  if (!port) return;
  if (type === "grants") {
    grantPort = port;
    port.on("message", ({ data: grant }) => {
      if ((grant as { type?: unknown } | null)?.type !== "grant") return;
      void ready.then((backend) => backend.grants.put(grantFrom(grant)));
    });
    port.start();
    return;
  }
  if (type === "credentials") {
    provideCredentialPort({
      postMessage: (m) => port.postMessage(m),
      onMessage: (handler) => port.on("message", ({ data: d }) => handler(d)),
    });
    port.start();
    return;
  }
  if (type === "rpc") {
    // Main's own line (ADR 0043, rule 10): requests and answers, none of the renderer's events,
    // and the banners and badge for main to show (ADR 0071, rule 8).
    port.on("message", async ({ data: request }) => {
      port.postMessage(await handle((await ready).deps, request));
    });
    port.start();
    mainLine = port;
    for (const event of waitingForMain) port.postMessage(event);
    waitingForMain = [];
    return;
  }
  if (type !== "port") return;
  rendererPorts.add(port);
  // A page that was reloaded inside an undo window still has its line.
  void ready.then((backend) => {
    backend.announceMoves();
    backend.windowOpened((event) => port.postMessage(event));
  });
  // A window that closes (settings) must not keep receiving events.
  port.on("close", () => rendererPorts.delete(port));
  let firstRequest = true;
  port.on("message", async ({ data: request }) => {
    if (firstRequest) {
      firstRequest = false;
      mark("first-request");
    }
    port.postMessage(await handle((await ready).deps, request));
  });
  port.start();
});

// Main normally asks politely; a signal must not leave the WAL behind either.
process.on("SIGTERM", () => void shutdown(0));
process.on("unhandledRejection", (reason) => {
  // The message of a rejection can only be ours or an adapter's, which scrub secrets.
  console.error(
    "matters-backend: unhandled rejection:",
    reason instanceof Error ? reason.message : "unknown",
  );
});
ready.catch((error) => {
  console.error("matters-backend: failed to start:", error);
  void shutdown(1);
});
