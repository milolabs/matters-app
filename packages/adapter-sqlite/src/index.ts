import type {
  AccountStorePort,
  AgentInsightStorePort,
  AgentSettingsPort,
  ArrivalPort,
  AttachmentStorePort,
  CursorPort,
  DraftStorePort,
  FilesPort,
  FileTextPort,
  FlagOutboxPort,
  ImageRuleStorePort,
  MessageBodyPort,
  MessageStorePort,
  MoveOutboxPort,
  OutboxPort,
  PeoplePort,
  RankedSearchPort,
  SavedViewStorePort,
  SearchIndexPort,
  UnitOfWorkPort,
} from "@matters/core";
import { SqliteAccountStore } from "./accountStore.ts";
import { SqliteAgentInsightStore, SqliteAgentSettings } from "./agentStore.ts";
import { SqliteArrivals } from "./arrivals.ts";
import { SqliteAttachmentStore } from "./attachmentStore.ts";
import { type AutomatedBodyStep, AutomatedFromBodies } from "./automatedBodies.ts";
import { type BodyStats, type RepackStep, SqliteBodyStore } from "./bodyStore.ts";
import { SqliteCursorStore } from "./cursorStore.ts";
import {
  type MigrationStep,
  openDatabase,
  openReader,
  openReaderIfCurrent,
  SqliteUnitOfWork,
} from "./database.ts";
import { SqliteDraftStore } from "./draftStore.ts";
import { SqliteFileText } from "./fileTextStore.ts";
import { SqliteFlagOutbox } from "./flagOutbox.ts";
import { SqliteImageRuleStore } from "./imageRuleStore.ts";
import { SqliteMessageStore } from "./messageStore.ts";
import { SqliteMoveOutbox } from "./moveOutbox.ts";
import { SqliteOutbox } from "./outbox.ts";
import { SqliteSearchIndex } from "./searchIndex.ts";
import { SqliteStorageSamples, SqliteStorageUsage } from "./storageUsage.ts";
import { SqliteSavedViewStore } from "./viewStore.ts";

export * from "./accountStore.ts";
export * from "./agentStore.ts";
export * from "./arrivals.ts";
export * from "./attachmentStore.ts";
export * from "./automatedBodies.ts";
export * from "./bodyStore.ts";
export * from "./cursorStore.ts";
export * from "./database.ts";
export * from "./draftStore.ts";
export * from "./fileTextStore.ts";
export * from "./flagOutbox.ts";
export * from "./imageRuleStore.ts";
export * from "./messageStore.ts";
export * from "./moveOutbox.ts";
export * from "./outbox.ts";
export * from "./people.ts";
export * from "./searchIndex.ts";
export * from "./storageUsage.ts";
export * from "./threadJoin.ts";
export * from "./viewStore.ts";

/** The read paths, served by their own connection. */
export interface SqliteReadPorts {
  readonly store: Pick<
    MessageStorePort,
    | "getByKeys"
    | "getThread"
    | "listNewest"
    | "listLabels"
    | "changesSince"
    | "listFolders"
    | "listThreadsSince"
    | "listWrittenTo"
    | "listSentMail"
    | "listReceivedMail"
  >;
  readonly index: Pick<SearchIndexPort, "search" | "searchChunk" | "matchesAmong">;
  readonly people: PeoplePort;
  /** Files found by name (ADR 0074). */
  readonly fileSearch: FilesPort;
  readonly bodies: Pick<MessageBodyPort, "getBodies" | "getHtmlKinds" | "getHtml">;
  readonly accounts: Pick<AccountStorePort, "list" | "get">;
  readonly drafts: Pick<DraftStorePort, "get" | "list" | "findByThread">;
  readonly outbox: Pick<OutboxPort, "get" | "listVisible">;
  readonly moveOps: Pick<MoveOutboxPort, "listPending">;
  readonly attachments: Pick<AttachmentStorePort, "get" | "forDraft">;
  readonly views: Pick<SavedViewStorePort, "get" | "list" | "recentSearches">;
  readonly imageRules: Pick<ImageRuleStorePort, "get" | "list" | "getGeneral">;
  /** What agents found and made, for the list of things that matter (ADR 0052). */
  readonly agentInsights: Pick<
    AgentInsightStorePort,
    | "getAnalysis"
    | "listAnalyses"
    | "getPrepared"
    | "getBundleRead"
    | "listFeedback"
    | "listLedger"
    | "listJournal"
    | "listRules"
    | "listInstructions"
    | "listTalk"
    | "getTalk"
    | "listTalks"
  >;
  readonly agentSettings: Pick<AgentSettingsPort, "get" | "listConsents" | "getRuntimeRecord">;
  /** What the database holds, for Settings › Storage (ADR 0089). */
  readonly storageUsage: SqliteStorageUsage;
  /** What arrived since a folder's mark, for notifications (ADR 0106). */
  readonly arrivals: ArrivalPort;
}

export interface SqliteStorage {
  /**
   * Write ports, on the writer connection. Their reads see the writer's own uncommitted
   * writes; use `read` for anything the UI shows.
   */
  readonly store: MessageStorePort;
  readonly index: SearchIndexPort & RankedSearchPort & PeoplePort & FilesPort;
  readonly bodies: MessageBodyPort;
  readonly cursors: CursorPort;
  readonly accounts: AccountStorePort;
  readonly outbox: OutboxPort;
  readonly attachments: AttachmentStorePort;
  readonly flagOps: FlagOutboxPort;
  readonly moveOps: MoveOutboxPort;
  readonly drafts: DraftStorePort;
  readonly views: SavedViewStorePort;
  readonly imageRules: ImageRuleStorePort;
  readonly agent: AgentInsightStorePort;
  readonly agentSettings: AgentSettingsPort;
  /** What the agent read from attached files (ADR 0087). */
  readonly fileText: FileTextPort;
  readonly uow: UnitOfWorkPort;
  /**
   * Read ports on a separate read-only connection: they see committed data only. A
   * `:memory:` database cannot be shared between connections, so there `read` is the writer.
   */
  readonly read: SqliteReadPorts;
  /** Block counts and sizes, to measure the compression ratio. */
  bodyStats(): BodyStats;
  /** The same for the HTML blocks. */
  htmlStats(): BodyStats;
  /** One step of moving HTML kept per thread into blocks per sender (ADR 0088). */
  repackHtml(budgetBytes?: number): Promise<RepackStep>;
  /** One step of reading stored mail for a mailing's footer (ADR 0111). */
  learnAutomatedFromBodies(rows?: number): Promise<AutomatedBodyStep>;
  /** Measurements kept for Settings › Storage, and compacting (ADR 0089). */
  readonly storageSamples: SqliteStorageSamples;
  close(): void;
}

export interface SqliteStorageOptions {
  /**
   * Open the separate read-only connection (default). A process that serves reads elsewhere,
   * through `createSqliteReader`, turns it off; `read` is then the writer's own ports.
   */
  readonly reader?: boolean;
  /** Told of each step of an update of an existing database (ADR 0103, rule 1). */
  readonly onMigrationStep?: MigrationStep;
}

/** Read ports on their own read-only connection of an existing database; never writes. */
export interface SqliteReader {
  readonly read: SqliteReadPorts;
  close(): void;
}

function readPorts(db: ReturnType<typeof openReader>): SqliteReadPorts {
  const index = new SqliteSearchIndex(db);
  return {
    store: new SqliteMessageStore(db),
    index,
    people: index,
    fileSearch: index,
    bodies: new SqliteBodyStore(db),
    accounts: new SqliteAccountStore(db),
    drafts: new SqliteDraftStore(db),
    outbox: new SqliteOutbox(db),
    moveOps: new SqliteMoveOutbox(db),
    attachments: new SqliteAttachmentStore(db),
    views: new SqliteSavedViewStore(db),
    imageRules: new SqliteImageRuleStore(db),
    agentInsights: new SqliteAgentInsightStore(db),
    agentSettings: new SqliteAgentSettings(db),
    storageUsage: new SqliteStorageUsage(db),
    arrivals: new SqliteArrivals(db),
  };
}

/**
 * Opens a read-only connection to a database another connection (the sync worker's writer)
 * already created and migrated. The reader never migrates and never takes a write lock.
 */
export function createSqliteReader(path: string): SqliteReader {
  const db = openReader(path);
  return { read: readPorts(db), close: () => db.close() };
}

/**
 * Like `createSqliteReader`, for a database that is ready to be read before the writer has
 * started (see `openReaderIfCurrent`); null when it is not, and the caller waits for the writer.
 */
export function createSqliteReaderIfCurrent(path: string): SqliteReader | null {
  const db = openReaderIfCurrent(path);
  return db ? { read: readPorts(db), close: () => db.close() } : null;
}

export function createSqliteStorage(
  path: string,
  options: SqliteStorageOptions = {},
): SqliteStorage {
  const db = openDatabase(path, options.onMigrationStep);
  let reader: ReturnType<typeof openReader> | null = null;
  try {
    if (path !== ":memory:" && options.reader !== false) reader = openReader(path);
  } catch (error) {
    db.close();
    throw error;
  }
  const readDb = reader ?? db;
  const bodies = new SqliteBodyStore(db);
  const automatedFromBodies = new AutomatedFromBodies(db, bodies);
  return {
    store: new SqliteMessageStore(db),
    index: new SqliteSearchIndex(db),
    bodies,
    cursors: new SqliteCursorStore(db),
    accounts: new SqliteAccountStore(db),
    outbox: new SqliteOutbox(db),
    attachments: new SqliteAttachmentStore(db),
    flagOps: new SqliteFlagOutbox(db),
    moveOps: new SqliteMoveOutbox(db),
    drafts: new SqliteDraftStore(db),
    views: new SqliteSavedViewStore(db),
    imageRules: new SqliteImageRuleStore(db),
    agent: new SqliteAgentInsightStore(db),
    agentSettings: new SqliteAgentSettings(db),
    fileText: new SqliteFileText(db),
    uow: new SqliteUnitOfWork(db),
    read: readPorts(readDb),
    bodyStats: () => bodies.stats(),
    htmlStats: () => bodies.htmlStats(),
    repackHtml: (budgetBytes) => bodies.repackHtml(budgetBytes),
    learnAutomatedFromBodies: (rows) => automatedFromBodies.step(rows),
    storageSamples: new SqliteStorageSamples(db),
    close: () => {
      try {
        reader?.close();
      } finally {
        db.close();
      }
    },
  };
}
