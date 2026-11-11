import { PostalMimeParser } from "@matters/adapter-mime";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import type { Account, MessageStorePort } from "@matters/core";
import { syncAccount } from "@matters/core";
import { ImapMailSync, type SyncStats } from "../../src/index.ts";
import type { Credentials } from "./admin.ts";

export const ACCOUNT: Account = {
  id: "acc1",
  address: "milosz@example.com",
  displayName: "Miłosz",
  capabilities: [],
};

/**
 * What `afterEach` has to undo, added as `beforeEach` sets it up. A hook that fails halfway then
 * releases what it got, and nothing left over from the test before.
 */
export class Teardown {
  private readonly steps: (() => void | Promise<void>)[] = [];

  add(step: () => void | Promise<void>): void {
    this.steps.push(step);
  }

  /** Runs every step, newest first, even after one throws; then throws the first failure. */
  async run(): Promise<void> {
    const failures: unknown[] = [];
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
}

export class Mailbox {
  readonly storage: SqliteStorage = createSqliteStorage(":memory:");
  readonly stats: SyncStats = {
    sourcesDownloaded: 0,
    fullUidSearches: 0,
    replyToFetches: 0,
    automatedFetches: 0,
    attachmentFetches: 0,
  };
  private readonly credentials: Credentials;
  private readonly batchSize: number;

  constructor(credentials: Credentials, batchSize = 200) {
    this.credentials = credentials;
    this.batchSize = batchSize;
  }

  async connect(): Promise<ImapMailSync> {
    return ImapMailSync.connect({
      host: this.credentials.host,
      port: this.credentials.port,
      security: "none",
      allowInsecure: true,
      auth: { user: this.credentials.user, pass: this.credentials.pass },
      parser: new PostalMimeParser(),
      batchSize: this.batchSize,
    });
  }

  /** One full `syncAccount` run on a fresh connection, like a periodic sync. */
  async sync() {
    const imap = await this.connect();
    try {
      const result = await syncAccount({ ...this.storage, sync: imap }, ACCOUNT);
      this.stats.sourcesDownloaded += imap.stats.sourcesDownloaded;
      this.stats.fullUidSearches += imap.stats.fullUidSearches;
      this.stats.replyToFetches += imap.stats.replyToFetches;
      this.stats.automatedFetches += imap.stats.automatedFetches;
      this.stats.attachmentFetches += imap.stats.attachmentFetches;
      return result;
    } finally {
      await imap.close();
    }
  }

  get store(): MessageStorePort {
    return this.storage.store;
  }

  async messages() {
    return this.storage.store.listNewest({ limit: 10_000 });
  }

  /** Every message, Trash and Spam included: `listNewest` leaves those out (ADR 0044). */
  async everything() {
    return this.storage.store.getByKeys((await this.storage.store.changesSince(0)).changedKeys);
  }

  async byProviderPrefix(prefix: string) {
    return (await this.messages()).filter((m) => m.providerId.startsWith(prefix));
  }

  async bySubject(subject: string) {
    const found = (await this.messages()).filter((m) => m.subject === subject);
    if (found.length !== 1)
      throw new Error(`expected one message "${subject}", got ${found.length}`);
    return found[0] as NonNullable<(typeof found)[number]>;
  }

  /** `bySubject` over `everything()`. */
  async bySubjectAnywhere(subject: string) {
    const found = (await this.everything()).filter((m) => m.subject === subject);
    if (found.length !== 1)
      throw new Error(`expected one message "${subject}", got ${found.length}`);
    return found[0] as NonNullable<(typeof found)[number]>;
  }

  close(): void {
    this.storage.close();
  }
}
