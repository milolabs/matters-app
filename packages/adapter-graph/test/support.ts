import { PostalMimeParser } from "@matters/adapter-mime";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import type { Account, MailTarget } from "@matters/core";
import { syncAccount } from "@matters/core";
import { type StandInGraphServer, startStandInGraphServer } from "@matters/testkit";
import { afterEach } from "vitest";
import {
  GraphConnector,
  type GraphConnectorOptions,
  RefusedTokens,
  type Schedule,
} from "../src/index.ts";

export const ACCOUNT: Account = {
  id: "acc1",
  address: "me@outlook.example",
  displayName: "Me",
  capabilities: [],
};

export const TOKEN = "graph-test-token-0123456789abcdef";

export const target = (token = TOKEN): MailTarget => ({
  transport: "graph",
  credential: { kind: "oauth2", provider: "microsoftGraph", accessToken: token },
});

/** Runs every wait at once and notes how long it was. */
export function instantSchedule(waits: number[] = []): Schedule {
  return (run, ms) => {
    waits.push(ms);
    setImmediate(run);
    return () => {};
  };
}

/** A message as MIME, with a stable `Message-ID` from `id`. */
export function mail(
  id: string,
  options: {
    readonly subject?: string;
    readonly to?: string;
    readonly date?: string;
    readonly body?: string;
    readonly attachment?: { readonly name: string; readonly bytes: Buffer };
  } = {},
): string {
  const head = [
    `From: Sender <sender@example.org>`,
    `To: ${options.to ?? "me@outlook.example"}`,
    `Subject: ${options.subject ?? id}`,
    `Date: ${options.date ?? "Tue, 03 Nov 2026 10:00:00 +0000"}`,
    `Message-ID: <${id}@example.org>`,
    "MIME-Version: 1.0",
  ];
  const text = options.body ?? `body of ${id}`;
  if (!options.attachment) {
    return [...head, "Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n");
  }
  const b64 = options.attachment.bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--b1",
    `Content-Type: application/pdf; name="${options.attachment.name}"`,
    `Content-Disposition: attachment; filename="${options.attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64,
    "--b1--",
    "",
  ].join("\r\n");
}

export interface Harness {
  readonly server: StandInGraphServer;
  readonly storage: SqliteStorage;
  readonly connector: GraphConnector;
  readonly refused: RefusedTokens;
  readonly waits: number[];
  /** One full `syncAccount` run on a fresh connection; returns the downloads it made. */
  sync(token?: string): Promise<Awaited<ReturnType<typeof syncAccount>> & { downloads: number }>;
  messages(): Promise<Awaited<ReturnType<SqliteStorage["store"]["listNewest"]>>>;
  keyOf(itemId: string): Promise<number | undefined>;
}

const open: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

export async function harness(over: Partial<GraphConnectorOptions> = {}): Promise<Harness> {
  const server = await startStandInGraphServer({ token: TOKEN });
  const storage = createSqliteStorage(":memory:");
  open.push(
    () => server.stop(),
    () => storage.close(),
  );
  const waits: number[] = [];
  const refused = new RefusedTokens();
  const connector = new GraphConnector({
    parser: new PostalMimeParser(),
    baseUrl: server.baseUrl,
    refusedTokens: refused,
    schedule: instantSchedule(waits),
    pageSize: 2,
    ...over,
  });
  return {
    server,
    storage,
    connector,
    refused,
    waits,
    async sync(token = TOKEN) {
      const connection = await connector.connect(target(token));
      try {
        const result = await syncAccount({ ...storage, sync: connection.sync }, ACCOUNT);
        return { ...result, downloads: connection.sync.stats.sourcesDownloaded };
      } finally {
        await connection.close();
      }
    },
    messages: () => storage.store.listNewest({ limit: 1000 }),
    async keyOf(itemId) {
      return (await storage.store.findByProviderIds(ACCOUNT.id, [itemId])).get(itemId);
    },
  };
}

/** `$value` downloads the stand-in served. */
export const downloads = (server: StandInGraphServer) =>
  server.requests.filter((r) => r.path.endsWith("/$value")).length;
