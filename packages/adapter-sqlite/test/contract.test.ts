import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageDocument, PeoplePort, SearchIndexPort } from "@matters/core";
import {
  describeAccountStoreContract,
  describeAgentInsightStoreContract,
  describeAgentSettingsContract,
  describeAttachmentStoreContract,
  describeDraftStoreContract,
  describeFileSearchContract,
  describeFlagOutboxContract,
  describeImageRuleStoreContract,
  describeMessageBodyContract,
  describeMessageStoreContract,
  describeMoveContract,
  describeMoveOutboxContract,
  describeOutboxAttachmentsContract,
  describeOutboxContract,
  describePeopleContract,
  describeSavedViewStoreContract,
  describeSearchIndexContract,
  describeSeenContract,
  describeSyncBatchContract,
  describeUnitOfWorkContract,
} from "@matters/testkit";
import {
  createSqliteStorage,
  openDatabase,
  SqliteMessageStore,
  SqliteSearchIndex,
} from "../src/index.ts";
import { DEFAULT_DRIVER_LIMITS } from "../src/searchPlan.ts";

describeMessageStoreContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.store, cleanup: () => storage.close() };
});

// The index reads filters from the message store, so the harness upserts first.
function indexHarness(
  storage: ReturnType<typeof createSqliteStorage>,
): SearchIndexPort & PeoplePort {
  return {
    async indexMessages(batch: readonly MessageDocument[]) {
      const { keys } = await storage.store.upsertMessages(batch.map((d) => d.message));
      await storage.index.indexMessages(
        batch.map((d, i) => ({ ...d, message: { ...d.message, key: keys[i] as number } })),
      );
    },
    removeMessages: (keys) => storage.index.removeMessages(keys),
    search: (query, options) => storage.index.search(query, options),
    searchChunk: (query, options) => storage.index.searchChunk(query, options),
    matchesAmong: (query, keys) => storage.index.matchesAmong(query, keys),
    suggest: (prefix, limit) => storage.index.suggest(prefix, limit),
    frequent: (limit) => storage.index.frequent(limit),
  };
}

describeSearchIndexContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: indexHarness(storage), cleanup: () => storage.close() };
});

describePeopleContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: indexHarness(storage), cleanup: () => storage.close() };
});

// Every prefix counts as common: people are walked in rank order instead of read from the words.
describePeopleContract("sqlite, walking in rank order", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteMessageStore(db);
  const index = new SqliteSearchIndex(db, DEFAULT_DRIVER_LIMITS, -1);
  const harness: SearchIndexPort & PeoplePort = {
    async indexMessages(batch: readonly MessageDocument[]) {
      const { keys } = await store.upsertMessages(batch.map((d) => d.message));
      await index.indexMessages(
        batch.map((d, i) => ({ ...d, message: { ...d.message, key: keys[i] as number } })),
      );
    },
    removeMessages: (keys) => index.removeMessages(keys),
    search: (query, options) => index.search(query, options),
    searchChunk: (query, options) => index.searchChunk(query, options),
    matchesAmong: (query, keys) => index.matchesAmong(query, keys),
    suggest: (prefix, limit) => index.suggest(prefix, limit),
    frequent: (limit) => index.frequent(limit),
  };
  return { instance: harness, cleanup: () => db.close() };
});

describeMessageBodyContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.bodies, cleanup: () => storage.close() };
});

// A file database, so the reader is a real second connection that sees committed data only.
describeUnitOfWorkContract("sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "matters-uow-"));
  const storage = createSqliteStorage(join(dir, "mail.db"));
  return {
    instance: { ...storage, read: storage.read },
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describeUnitOfWorkContract("sqlite in-memory", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: { ...storage, read: storage.read }, cleanup: () => storage.close() };
});

describeSyncBatchContract("sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "matters-loc-"));
  const storage = createSqliteStorage(join(dir, "mail.db"));
  return {
    instance: { ...storage, read: storage.read },
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// A file database, as for the other unit-of-work contracts.
describeSeenContract("sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "matters-seen-"));
  const storage = createSqliteStorage(join(dir, "mail.db"));
  return {
    instance: { ...storage, read: storage.read },
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describeMoveContract("sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "matters-move-"));
  const storage = createSqliteStorage(join(dir, "mail.db"));
  return {
    instance: { ...storage, read: storage.read },
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describeMoveOutboxContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.moveOps, cleanup: () => storage.close() };
});

describeFlagOutboxContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.flagOps, cleanup: () => storage.close() };
});

describeAccountStoreContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.accounts, cleanup: () => storage.close() };
});

describeDraftStoreContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.drafts, cleanup: () => storage.close() };
});

describeAttachmentStoreContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.attachments, cleanup: () => storage.close() };
});

describeOutboxAttachmentsContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return {
    instance: { outbox: storage.outbox, attachments: storage.attachments },
    cleanup: () => storage.close(),
  };
});

describeOutboxContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.outbox, cleanup: () => storage.close() };
});

describeImageRuleStoreContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.imageRules, cleanup: () => storage.close() };
});

describeSavedViewStoreContract("sqlite", async () => {
  const storage = createSqliteStorage(":memory:");
  // The contract starts from an empty store; the starter views are a migration's (ADR 0029).
  for (const view of await storage.views.list()) await storage.views.remove(view.id);
  return { instance: storage.views, cleanup: () => storage.close() };
});

describeAgentInsightStoreContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.agent, cleanup: () => storage.close() };
});

describeAgentSettingsContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return { instance: storage.agentSettings, cleanup: () => storage.close() };
});

describeFileSearchContract("sqlite", () => {
  const storage = createSqliteStorage(":memory:");
  return {
    instance: { store: storage.store, files: storage.index },
    cleanup: () => storage.close(),
  };
});
