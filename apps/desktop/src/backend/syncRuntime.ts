// The sync worker's composition: writer connection, unit of work, mail connector, scheduler and
// the account commands. The adapters come in as parameters so a test can run this over fakes in
// a real worker thread; syncWorker.ts is the entry that picks the real ones.
import { randomUUID } from "node:crypto";
import { readFile as readFileBytes, stat } from "node:fs/promises";
import { RemoteCredentialPort } from "@matters/adapter-secrets";
import type { SqliteStorage } from "@matters/adapter-sqlite";
import type {
  ClockPort,
  ComposeRendererPort,
  DownloadConnection,
  FetchOutcome,
  FetchWatch,
  FileTextExtractorPort,
  FileWorkPort,
  IngestDeps,
  MailConnectorPort,
  MailSubmitPort,
  MessageComposerPort,
  ProcessDeps,
  ReceivedFilesPort,
  RegistrableDomainFn,
  ServerDiscoveryPort,
  Sha256Hex,
  StoredAccount,
} from "@matters/core";
import {
  CopyBook,
  CredentialsUnavailableError,
  countMatches,
  createFileReader,
  draftFor,
  ReceivedDownloads,
  RejectedPasswords,
  receivedId,
  SyncScheduler,
  sortRanked,
  sweepReceived,
} from "@matters/core";
import { AccountService } from "./accounts.ts";
import { type AgentRuntime, AgentService } from "./agentService.ts";
import { AttachmentService } from "./attachmentService.ts";
import type { DemoMail } from "./demoMail.ts";
import { FlagRunner } from "./flagRunner.ts";
import { startHtmlRepack } from "./htmlRepack.ts";
import { ImageRuleService } from "./imageRuleService.ts";
import { MoveService } from "./moveService.ts";
import { OutboxRunner } from "./outboxRunner.ts";
import { ProgressThrottle } from "./progressThrottle.ts";
import type {
  CommandResults,
  FromWorker,
  WireError,
  WorkerChannel,
  WorkerCommand,
} from "./protocol.ts";
import {
  seedAttachmentDemo,
  seedDemoAccount,
  seedDemoFolders,
  seedDemoViews,
  seedIfEmpty,
  seedImageDemo,
  seedMoveDemo,
} from "./seed.ts";
import { SeenService } from "./seenService.ts";
import { SendService } from "./sendService.ts";
import { TransferBook } from "./transfers.ts";
import { ViewService } from "./viewService.ts";

const STOP_WAIT_MS = 2500;

export const systemClock: ClockPort = {
  now: () => Date.now(),
  setTimeout(run, delayMs) {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  random: () => Math.random(),
};

/** What building and sending a message needs besides the stores (ADR 0020). */
export interface MailSendAdapters {
  readonly renderer: ComposeRendererPort;
  readonly composer: MessageComposerPort;
  readonly submit: MailSubmitPort;
  readonly sha256: Sha256Hex;
}

export interface SyncRuntimeOptions {
  /** Opened with `reader: false`; this thread is the only one that writes. */
  readonly storage: SqliteStorage;
  readonly connector: MailConnectorPort;
  readonly channel: WorkerChannel;
  readonly discovery: ServerDiscoveryPort;
  readonly sending: MailSendAdapters;
  /**
   * Everything that touches a user's file (ADR 0041). The app passes a `ThreadedFileWork`; it is
   * disposed when the runtime stops.
   */
  readonly files: FileWorkPort & Partial<FileTextExtractorPort> & { dispose?(): Promise<void> };
  /**
   * The cache of received files (ADR 0043). Without it a download answers `failed`, and nothing is
   * removed with a message.
   */
  readonly received?: ReceivedFilesPort;
  /**
   * The demo server's answers for the seed's account, in a run with no server (see demoMail.ts).
   * Only the seed's worker is given one; it is consulted for no other account.
   */
  readonly demo?: DemoMail;
  /** Public Suffix List lookup for image rules (ADR 0037). */
  readonly registrableDomain: RegistrableDomainFn;
  /**
   * Agents (ADR 0051): the runtimes the person chooses from (ADR 0119, rule 2) and the conversion
   * of HTML to what the reader sees. Without it every agent command fails and nothing reads mail.
   */
  readonly agent?: {
    readonly runtimes: readonly AgentRuntime[];
    readonly visibleText: (html: string) => string;
    readonly kickDebounceMs?: number;
    readonly stepThreads?: number;
  };
  /** Undo window in ms; default 10 s. Only tests change it. */
  readonly undoWindowMs?: number;
  readonly clock?: ClockPort;
  /** Demo mail for the smoke runs; a real database is never seeded. */
  readonly seed?: boolean;
  /** With `seed`: one mail for each state of the image bar (demo runs). */
  readonly seedImages?: boolean;
  /** An account to start with besides the stored ones (smoke runs). */
  readonly testAccount?: StoredAccount | null;
}

export interface SyncRuntime {
  /** Stops the sync (connections first), then closes the writer connection. Idempotent. */
  stop(): Promise<void>;
}

function wireError(error: unknown): WireError {
  const e = error as { name?: unknown; message?: unknown; kind?: unknown } | null;
  return {
    name: typeof e?.name === "string" ? e.name : "Error",
    message: typeof e?.message === "string" ? e.message : String(error),
    ...(typeof e?.kind === "string" ? { kind: e.kind } : {}),
  };
}

export async function startSyncRuntime(options: SyncRuntimeOptions): Promise<SyncRuntime> {
  const { storage, connector, channel, discovery } = options;
  const clock = options.clock ?? systemClock;
  const started = performance.now();
  const post = (message: FromWorker) => channel.post(message);

  const writers: IngestDeps = {
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    uow: storage.uow,
  };
  const seeded = options.seed ? await seedIfEmpty(writers) : 0;
  if (options.seed) await seedDemoAccount(storage.accounts);
  if (options.seed) await seedDemoFolders(storage.store);
  // Only with a fresh mailbox: a restart must not bring back views the demo user deleted.
  if (options.seed && seeded > 0) await seedDemoViews(storage.views);
  if (options.seedImages && seeded > 0) {
    await seedImageDemo(writers);
    await seedAttachmentDemo(writers);
    await seedMoveDemo(writers);
  }

  const credentials = new RemoteCredentialPort({
    postMessage: (data) => post({ type: "credentials", data }),
    onMessage: (handler) =>
      channel.onMessage((m) => {
        if (m.type === "credentials") handler(m.data);
      }),
  });
  // A password the server refused is not used again by work that logs in on its own; the
  // scheduler and the account requests read the vault itself (ADR 0113, rule 4).
  const rejected = new RejectedPasswords();
  const vaultUnlessRejected = rejected.guard(credentials);
  let agentService: AgentService | null = null;
  const scheduler = new SyncScheduler({
    connector,
    accounts: storage.accounts,
    credentials,
    sync: {
      ...writers,
      cursors: storage.cursors,
      flagOps: storage.flagOps,
      moveOps: storage.moveOps,
      ...(options.received ? { received: options.received } : {}),
    },
    clock,
    onStatus: (accountId, status) => {
      rejected.note(accountId, status);
      post({ type: "status", accountId, status });
    },
    onBatchApplied: () => {
      post({ type: "committed" });
      // New mail may be worth reading; the service debounces, so a burst of batches is one pass.
      agentService?.kick();
    },
    onSynced: (accountId, run) =>
      post({
        type: "synced",
        accountId,
        scope: run.scope,
        documents: run.documents,
        durationMs: run.durationMs,
      }),
  });
  const accounts = new AccountService({
    accounts: storage.accounts,
    add: {
      accounts: storage.accounts,
      credentials,
      connector,
      outgoing: options.sending.submit,
      newId: () => `acc-${randomUUID()}`,
      now: () => Date.now(),
    },
    remove: {
      ...writers,
      accounts: storage.accounts,
      cursors: storage.cursors,
      outbox: storage.outbox,
      flagOps: storage.flagOps,
      moveOps: storage.moveOps,
      drafts: storage.drafts,
      attachments: storage.attachments,
      files: options.files,
      ...(options.received ? { received: options.received } : {}),
      credentials,
    },
    discovery,
    scheduler,
    rejected,
    // The router hears about the result and announces it; it reads the committed state itself.
    onChanged: () => post({ type: "committed" }),
  });

  const announceOutbox = () => post({ type: "outbox" });
  // Progress is shown, not stored: four reports a second per item at most (ADR 0041, rule 5).
  const attachmentProgress = new ProgressThrottle<number>(clock, (id, fraction) =>
    post({ type: "attachmentProgress", id, fraction }),
  );
  const sendProgress = new ProgressThrottle<{ sent: number; total: number }>(
    clock,
    (operationId, v) =>
      post({ type: "sendProgress", operationId, sentBytes: v.sent, totalBytes: v.total }),
  );
  const transfers = new TransferBook();
  const processDeps: ProcessDeps = {
    drafts: storage.drafts,
    outbox: storage.outbox,
    store: storage.store,
    accounts: storage.accounts,
    credentials: vaultUnlessRejected,
    ...options.sending,
    connector,
    ingest: writers,
    attachments: storage.attachments,
    files: options.files,
    // The app has no carrier yet (ADR 0040, rule 5); the seam is there for the first one.
    carriers: [],
    // Forwarded files come through the cache of received files (ADR 0045, rule 7).
    forward: {
      attachment: (messageKey, partId) => storage.store.getAttachment(messageKey, partId),
      fetch: (messageKey, partId, watch) => fetchForwarded(messageKey, partId, watch),
      locate: async (messageKey, partId) => options.received?.locate(messageKey, partId) ?? null,
      stopped: () => downloads?.stopped ?? false,
    },
    copies: new CopyBook(),
    newId: () => randomUUID(),
    now: () => clock.now(),
    // Between looks for a Sent copy the server filed itself (ADR 0092).
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...(options.undoWindowMs === undefined ? {} : { undoWindowMs: options.undoWindowMs }),
    onChange: announceOutbox,
    onAttachmentsChanged: (draftId) => post({ type: "attachments", draftId }),
    onAttachmentProgress: (id, fraction) => attachmentProgress.report(id, fraction),
    wakeOutbox: () => send.wake(),
    onTransferStart: (operationId, controller) => transfers.start(operationId, controller),
    onTransferEnd: (operationId) => {
      transfers.end(operationId);
      sendProgress.forget(operationId);
    },
    onSendProgress: (operationId, sent, total) => sendProgress.report(operationId, { sent, total }),
  };
  const send: SendService = new SendService({
    process: processDeps,
    onChanged: announceOutbox,
    transfers,
  });
  // Messages of our own errors; the adapters scrub secrets.
  const outboxError = (error: unknown) =>
    console.error("matters-sync: outbox:", error instanceof Error ? error.message : "unknown");
  // One runner for each lane (ADR 0041, rule 11). The small one also settles unknown sends.
  const smallRunner: OutboxRunner = new OutboxRunner({
    clock,
    process: () => send.process("small"),
    reconcile: () => send.reconcile(),
    nextDueMs: () => send.nextDueMs("small"),
    hasUnknown: () => send.hasUnknown(),
    onError: outboxError,
  });
  const largeRunner = new OutboxRunner({
    clock,
    process: async () => {
      const done = await send.process("large");
      // A lost answer is settled by the small runner's reconcile, which looks at every account.
      if (done.some((op) => op.state.kind === "unknown")) void smallRunner.runNow();
      return done;
    },
    reconcile: async () => ({ resolved: 0, leftToUser: 0, waiting: 0 }),
    nextDueMs: () => send.nextDueMs("large"),
    hasUnknown: async () => false,
    onError: outboxError,
  });
  send.attach({ small: smallRunner, large: largeRunner });

  // Received files (ADR 0043): downloaded on demand over a connection of their own, at most two at
  // a time per account, and told to the windows as progress that is shown and never stored.
  const receivedProgress = new ProgressThrottle<{ bytes: number; total: number }>(
    clock,
    (id, v) => {
      const slash = id.indexOf("/");
      post({
        type: "receivedProgress",
        messageKey: Number(id.slice(0, slash)),
        partId: id.slice(slash + 1),
        bytes: v.bytes,
        totalBytes: v.total,
      });
    },
  );
  const openForDownload = async (accountId: string): Promise<DownloadConnection | null> => {
    const account = await storage.accounts.get(accountId);
    if (!account) return null;
    if (options.demo?.serves(account)) return options.demo.connection();
    const credential = await vaultUnlessRejected.get(accountId);
    if (!credential)
      throw new CredentialsUnavailableError("No password is stored for this account");
    return connector.connect({ server: account.imap, credential });
  };
  const downloads = options.received
    ? new ReceivedDownloads(
        { store: storage.store, files: options.received, open: openForDownload },
        {
          onProgress: (messageKey, partId, bytes, total) =>
            receivedProgress.report(receivedId(messageKey, partId), { bytes, total }),
        },
      )
    : null;
  const fetchReceived = async (messageKey: number, partId: string): Promise<FetchOutcome> => {
    if (!downloads) return { kind: "failed", message: "Received files are not available" };
    try {
      return await downloads.fetch(messageKey, partId);
    } finally {
      receivedProgress.forget(receivedId(messageKey, partId));
    }
  };

  const fetchForwarded = async (
    messageKey: number,
    partId: string,
    watch?: FetchWatch,
  ): Promise<FetchOutcome> => {
    if (!downloads) return { kind: "failed", message: "Received files are not available" };
    try {
      return await downloads.fetch(messageKey, partId, watch);
    } finally {
      // A reader of the same file may still be waiting; its ring is told again by its own bytes.
      receivedProgress.forget(receivedId(messageKey, partId));
    }
  };

  // The agent reads attached files (ADR 0087): kept text first; else through the received cache
  // and the file work thread. It runs here, where the agent runs, not as a command from the router.
  const extractText = options.files.extractText?.bind(options.files);
  const fileReader = createFileReader({
    store: storage.store,
    texts: storage.fileText,
    fetch: fetchReceived,
    locate: async (messageKey, partId) => options.received?.locate(messageKey, partId) ?? null,
    extractor: extractText === undefined ? undefined : { extractText },
    // A file with no text goes whole (ADR 0090, rule 8): the cached copy, if it is not over the cap.
    readBytes: async (path, max) => {
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isFile() || info.size > max) return null;
      const bytes = await readFileBytes(path);
      return bytes.length > max ? null : new Uint8Array(bytes);
    },
    now: () => clock.now(),
  });

  const attachments = new AttachmentService({
    attach: processDeps,
    probe: {
      accounts: storage.accounts,
      credentials: vaultUnlessRejected,
      submit: options.sending.submit,
    },
    onCaptured: (ids) => {
      for (const id of ids) attachmentProgress.forget(id);
      post({ type: "captured", ids });
    },
  });

  // Read state the server does not have yet (ADR 0039): stored with the flag, pushed a second
  // after the latest change, and found again at start-up if the app quit before it went.
  const seen = new SeenService({
    store: storage.store,
    flagOps: storage.flagOps,
    accounts: storage.accounts,
    credentials: vaultUnlessRejected,
    connector,
    uow: storage.uow,
    clock,
    onChanged: () => post({ type: "committed" }),
    onError: (error) =>
      console.error("matters-sync: seen:", error instanceof Error ? error.message : "unknown"),
  });
  const flagRunner = new FlagRunner({
    clock,
    process: () => seen.process(),
    nextDueMs: () => seen.nextDueMs(),
    onError: (error) =>
      console.error("matters-sync: seen:", error instanceof Error ? error.message : "unknown"),
  });
  seen.attach(flagRunner);

  // Moves the server does not have yet (ADR 0044): stored with the new labels, pushed when the
  // undo window is over, and found again at start-up if the app quit before they went.
  const moves = new MoveService({
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    ...(options.received ? { received: options.received } : {}),
    moveOps: storage.moveOps,
    accounts: storage.accounts,
    credentials: vaultUnlessRejected,
    connector,
    uow: storage.uow,
    clock,
    newId: () => randomUUID(),
    ...(options.undoWindowMs === undefined ? {} : { windowMs: options.undoWindowMs }),
    onChanged: () => post({ type: "committed" }),
    onMoves: () => post({ type: "moves" }),
    onRefused: (action, count) => post({ type: "moveRefused", action, count }),
    requestSync: (accountId) => scheduler.syncNow(accountId),
    onError: (error) =>
      console.error("matters-sync: moves:", error instanceof Error ? error.message : "unknown"),
  });
  const moveRunner = new FlagRunner({
    clock,
    process: () => moves.process(),
    nextDueMs: () => moves.nextDueMs(),
    onError: (error) =>
      console.error("matters-sync: moves:", error instanceof Error ? error.message : "unknown"),
  });
  moves.attach(moveRunner);

  const views = new ViewService({
    views: storage.views,
    newId: () => randomUUID(),
    now: () => clock.now(),
  });

  const imageRules = new ImageRuleService({
    rules: storage.imageRules,
    registrableDomain: options.registrableDomain,
    uow: storage.uow,
    now: () => clock.now(),
  });

  const agent = options.agent
    ? new AgentService({
        runtimes: options.agent.runtimes,
        store: storage.store,
        bodies: storage.bodies,
        accounts: storage.accounts,
        insights: storage.agent,
        settings: storage.agentSettings,
        drafts: storage.drafts,
        saveDraft: (content) => send.saveDraft({ content }),
        clock,
        visibleText: options.agent.visibleText,
        onChanged: () => post({ type: "agent" }),
        readFile: (messageKey, partId) => fileReader.read(messageKey, partId),
        wholeFile: (messageKey, partId) => fileReader.whole(messageKey, partId),
        onTalkStep: (query, threads, kind, note) =>
          post({
            type: "agentTalkStep",
            query,
            threads,
            ...(kind === undefined ? {} : { kind }),
            ...(note === undefined ? {} : { note }),
          }),
        onPromptProgress: (progress) => post({ type: "agentPrompt", ...progress }),
        index: storage.index,
        views: storage.views,
        starterViews: storage.views,
        onViewsChanged: () => post({ type: "views" }),
        onError: (message) => console.error(`matters-sync: ${message}`),
        ...(options.agent.kickDebounceMs === undefined
          ? {}
          : { kickDebounceMs: options.agent.kickDebounceMs }),
        ...(options.agent.stepThreads === undefined
          ? {}
          : { stepThreads: options.agent.stepThreads }),
      })
    : null;
  agentService = agent;
  const needAgent = (): AgentService => {
    if (agent === null) throw new Error("Agents are not available");
    return agent;
  };

  /** Removing an account takes its consent and what agents kept about its threads with it. */
  const removeAccount = async (accountId: string): Promise<boolean> => {
    const threadIds = (await storage.store.listThreadsSince(0, 1_000_000))
      .filter((t) => t.accountId === accountId)
      .map((t) => t.threadId);
    const removed = await accounts.remove(accountId);
    if (removed) {
      await storage.agentSettings.revokeConsent(accountId);
      await storage.agent.removeForThreads(threadIds);
      post({ type: "agent" });
    }
    return removed;
  };

  const execute = async (
    command: WorkerCommand,
  ): Promise<CommandResults[WorkerCommand["name"]]> => {
    switch (command.name) {
      case "addAccount":
        return accounts.add({
          address: command.address,
          displayName: command.displayName,
          password: command.password,
          imap: command.imap,
          ...(command.smtp === undefined ? {} : { smtp: command.smtp }),
        });
      case "removeAccount":
        return removeAccount(command.accountId);
      case "syncNow":
        return accounts.syncNow(command.accountId);
      case "changePassword":
        return accounts.changePassword(command.accountId, command.password);
      case "setSeen":
        return seen.setSeen(command.keys, command.seen);
      case "moveThread":
        return moves.moveThread({
          threadId: command.threadId,
          ...(command.others === undefined ? {} : { others: command.others }),
          action: command.action,
          ...(command.target === undefined ? {} : { target: command.target }),
          ...(command.hidden === undefined ? {} : { hidden: command.hidden }),
        });
      case "undoMove":
        return moves.undoMove(command.operationId);
      case "deleteForever":
        return moves.deleteForever(command.keys);
      case "saveDraft":
        return send.saveDraft({
          content: command.content,
          ...(command.id === undefined ? {} : { id: command.id }),
        });
      case "deleteDraft":
        return send.deleteDraft(command.draftId);
      case "requestSend":
        return send.requestSend(command.draftId);
      case "undoSend":
        return send.undoSend(command.operationId);
      case "addAttachments":
        return attachments.add(command.draftId, command.files);
      case "addForwardedAttachments":
        return attachments.addForwarded(command.draftId, command.files);
      case "checkAttachmentSources":
        return attachments.check(command.draftId);
      case "recaptureAttachment":
        return attachments.recapture(command.draftId, command.id);
      case "probeMessageLimit":
        return attachments.probeLimit(command.accountId);
      case "fetchReceived":
        return fetchReceived(command.messageKey, command.partId);
      case "sendAction":
        return send.sendAction(command.operationId, command.action);
      case "createView":
        return views.create({ name: command.viewName, query: command.query });
      case "updateViewQuery":
        return views.updateQuery(command.id, command.query);
      case "renameView":
        return views.rename(command.id, command.viewName);
      case "deleteView":
        return views.remove(command.id);
      case "moveView":
        await views.move(command.id, command.toIndex);
        return null;
      case "noteSearch":
        await views.noteSearch(command.viewId, command.query);
        return null;
      case "forgetSearch":
        await views.forgetSearch(command.viewId, command.query);
        return null;
      case "clearSearches":
        await views.clearSearches(command.viewId);
        return null;
      case "recordStorageSample":
        await storage.storageSamples.record(command.sample);
        return null;
      case "compactDatabase":
        return storage.storageSamples.compact();
      case "clearFileText":
        return storage.fileText.clear();
      case "setImageRule":
        return imageRules.setRule({
          scope: command.scope,
          value: command.value,
          decision: command.decision,
        });
      case "removeImageRule":
        return imageRules.removeRule(command.scope, command.value);
      case "stopImages":
        await imageRules.stop({ address: command.address, source: command.source });
        return null;
      case "setGeneralImages":
        await imageRules.setGeneral(command.general);
        return null;
      case "importImageAddresses":
        return imageRules.importAddresses(command.addresses);
      case "agentStatus":
        return needAgent().status();
      case "agentSetEnabled":
        return needAgent().setEnabled({
          accountIds: command.accountIds,
          runtimeId: command.runtimeId,
        });
      case "agentSetKindRuntime":
        return needAgent().setKindRuntime(command.kinds, command.runtimeId);
      case "agentDisable":
        return needAgent().disable();
      case "agentSetModels":
        return needAgent().setModels(command.models, command.efforts);
      case "agentSetWeekShare":
        return needAgent().setWeekShare(command.percent);
      case "agentSetTalkLoop":
        return needAgent().setTalkLoop(command.on);
      case "agentInspect":
        return needAgent().inspect();
      case "agentPauseReading":
        return needAgent().pauseReading();
      case "agentResumeReading":
        return needAgent().resumeReading();
      case "agentTestRuntime":
        return needAgent().testRuntime(command.runtimeId);
      case "agentPrepare":
        return needAgent().prepare(command.threadId, {
          ...(command.direction === undefined ? {} : { direction: command.direction }),
          ...(command.answer === undefined ? {} : { answer: command.answer }),
        });
      case "agentTalk":
        return needAgent().talk(command.threadId, command.words, command.choice);
      case "agentRewriteDraft":
        return needAgent().rewriteDraft(draftFor(command), command.text, command.how);
      case "agentWriteDraft":
        return needAgent().writeDraft(
          draftFor(command),
          command.subject,
          command.text,
          command.words,
        );
      case "agentAnswerQuestions":
        return needAgent().answerQuestions(command.threadId, command.text, command.missing ?? []);
      case "agentCheckReply":
        return needAgent().checkReply(command.threadId, command.text);
      case "agentFillGaps":
        return needAgent().fillGaps(command.threadId, command.text);
      case "agentTalkStop":
        await needAgent().talkStop(command.threadId);
        return null;
      case "agentMakeTheme":
        return needAgent().makeTheme(command.input);
      case "agentMakeThemeStop":
        await needAgent().makeThemeStop();
        return null;
      case "agentTalkAll":
        return needAgent().talkAll(command.words, command.talkId ?? null, command.choice);
      case "agentTalkAllStop":
        await needAgent().talkAllStop();
        return null;
      case "agentTalkRename":
        await needAgent().renameTalk(command.talkId, command.title);
        return null;
      case "agentTalkDelete":
        await needAgent().deleteTalk(command.talkId);
        return null;
      case "agentTalkDeleteAll":
        return needAgent().deleteAllTalks();
      case "agentUndoFeedback":
        await needAgent().undoFeedback(command.threadId, command.kind);
        return null;
      case "agentRemember":
        return needAgent().remember(command.threadId, command.words);
      case "agentAddInstruction":
        return needAgent().addInstruction(command.input);
      case "agentRemoveInstruction":
        await needAgent().removeInstruction(command.id);
        return null;
      case "agentAddRule":
        return needAgent().addRule(command.input);
      case "agentRemoveRule":
        await needAgent().removeRule(command.ruleId);
        return null;
      case "agentRevokeConsent":
        return needAgent().revokeConsent(command.accountId, command.runtimeId);
      case "agentDraftFromPrepared":
        return needAgent().draftFromPrepared(command.threadId, command.body);
      case "agentMatchAct":
        return needAgent().matchAct(command.query);
      case "agentPromptCount":
        return needAgent().promptCount(command.query);
      case "agentPromptVerdicts":
        return needAgent().promptVerdicts(command.query);
      case "agentPromptBadge":
        return needAgent().promptBadge(command.query);
      case "agentPromptRun":
        return needAgent().promptRun(
          command.query,
          command.again === true,
          command.readAll === true,
        );
      case "agentPromptStop":
        await needAgent().promptStop();
        return null;
      case "agentReadingStatus":
        return needAgent().readingStatus(command.fresh === true);
      case "sortRanked":
        return sortRanked(
          {
            index: storage.index,
            store: storage.store,
            accounts: storage.accounts,
            now: () => clock.now(),
          },
          command.query,
        );
      case "countMatches":
        return countMatches(
          { index: storage.index, accounts: storage.accounts, now: () => clock.now() },
          command.query,
          {
            cap: command.cap,
            ...(command.beforeKey === undefined ? {} : { beforeKey: command.beforeKey }),
          },
        );
    }
  };

  let stopping: Promise<void> | null = null;
  let stopRepack: (() => void) | null = null;
  let stopAutomatedBodies: (() => void) | null = null;
  const stop = () => {
    stopping ??= (async () => {
      stopRepack?.();
      stopAutomatedBodies?.();
      // An upload that has not ended its data is cut short first and comes back held: quitting
      // never waits for it (ADR 0041, rule 15). A hand-off past that point finishes (cut short,
      // it would be an unknown outcome); then connections, then the database they write to.
      transfers.abortAll("quit");
      // Runs of the assistant are cut short first: they are child processes of this thread.
      const agentStopped = agent?.stop();
      downloads?.abortAll();
      await Promise.race([
        Promise.all([
          smallRunner.stop(),
          largeRunner.stop(),
          flagRunner.stop(),
          moveRunner.stop(),
          scheduler.stop(),
          agentStopped,
        ]),
        new Promise((r) => setTimeout(r, STOP_WAIT_MS)),
      ]);
      credentials.dispose();
      storage.close();
      // After the writer: a build cut off now finds the database closed and writes nothing.
      await options.files.dispose?.().catch(() => {});
      post({ type: "stopped" });
    })();
    return stopping;
  };

  channel.onMessage((message) => {
    if (message.type === "shutdown") void stop();
    if (message.type !== "command" || stopping) return;
    const { id } = message;
    execute(message.command).then(
      (value) => post({ type: "result", id, ok: true, value }),
      (error) => post({ type: "result", id, ok: false, error: wireError(error) }),
    );
  });

  if (options.testAccount && !(await storage.accounts.get(options.testAccount.id))) {
    await storage.accounts.add(options.testAccount);
  }
  // Sends whose window ended while the app was closed wait for the user (ADR 0020, rule 5).
  await send.recover();
  // Stray files go and copies that were running start again (ADR 0041, rule 19).
  await attachments
    .start()
    .catch((error) =>
      console.error(
        "matters-sync: attachments:",
        error instanceof Error ? error.message : "unknown",
      ),
    );
  await scheduler.start();
  post({ type: "ready", seeded, ms: Math.round(performance.now() - started) });
  // After ready: the router serves reads meanwhile, and nothing waits for the assistant (ADR 0051,
  // rule 10). With AI off this does nothing at all.
  void agent
    ?.start()
    .catch((error) =>
      console.error("matters-sync: agents:", error instanceof Error ? error.name : "unknown"),
    );
  // The cache is trimmed once launch is done and never waited for (ADR 0043, rule 8).
  const cache = options.received;
  if (cache && downloads) {
    void sweepReceived({ files: cache, nowMs: clock.now(), inUse: downloads.inUse() }).catch(
      (error) =>
        console.error(
          "matters-sync: received files:",
          error instanceof Error ? error.message : "unknown",
        ),
    );
  }
  // ADR 0088: HTML still kept per thread moves into blocks per sender, in small steps.
  stopRepack = startHtmlRepack({
    step: () => storage.repackHtml(),
    clock,
    onError: (error) =>
      console.error(
        "matters-sync: html repack:",
        error instanceof Error ? error.message : "unknown",
      ),
  });
  // ADR 0111: stored mail is read once for a mailing's footer, in the same small steps.
  stopAutomatedBodies = startHtmlRepack({
    step: () => storage.learnAutomatedFromBodies(),
    clock,
    onError: (error) =>
      console.error(
        "matters-sync: automated by text:",
        error instanceof Error ? error.message : "unknown",
      ),
  });
  announceOutbox();
  send.wake();
  void flagRunner.runNow();
  void moveRunner.runNow();
  post({ type: "moves" });
  return { stop };
}
