// Syncs one IMAP account into a local database, for trying the sync against a real mailbox.
//
//   MATTERS_IMAP_HOST=imap.example.com MATTERS_IMAP_PORT=993 MATTERS_IMAP_SECURITY=tls \
//   MATTERS_IMAP_USER=me@example.com MATTERS_IMAP_PASS=... MATTERS_DB_PATH=/tmp/matters.db \
//   npm run sync:imap
//
// Everything comes from the environment; nothing is read from or written to disk except the
// database, and the password is never printed. Open the result in the desktop app with
// MATTERS_DB_PATH=<same path>. The app never seeds demo mail unless MATTERS_SEED=1.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ImapAuthError, ImapMailSync } from "../packages/adapter-imap/src/index.ts";
import { PostalMimeParser } from "../packages/adapter-mime/src/index.ts";
import { createSqliteStorage } from "../packages/adapter-sqlite/src/index.ts";
import { type Account, syncAccount } from "../packages/core/src/index.ts";

const env = process.env;
const missing = [
  "MATTERS_IMAP_HOST",
  "MATTERS_IMAP_USER",
  "MATTERS_IMAP_PASS",
  "MATTERS_DB_PATH",
].filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  console.error(
    "Optional: MATTERS_IMAP_PORT (default 993), MATTERS_IMAP_SECURITY=tls|starttls|none (default tls)",
  );
  process.exit(2);
}

const host = env.MATTERS_IMAP_HOST as string;
const user = env.MATTERS_IMAP_USER as string;
const pass = env.MATTERS_IMAP_PASS as string;
const dbPath = env.MATTERS_DB_PATH as string;
const port = Number(env.MATTERS_IMAP_PORT ?? 993);
const security = env.MATTERS_IMAP_SECURITY ?? "tls";
if (security !== "tls" && security !== "starttls" && security !== "none") {
  console.error("MATTERS_IMAP_SECURITY must be tls, starttls or none");
  process.exit(2);
}

const account: Account = { id: "imap", address: user, displayName: user, capabilities: [] };

/** Error text for the terminal; the password cannot appear in it. */
const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split(pass).join("***");

const started = performance.now();
mkdirSync(dirname(dbPath), { recursive: true });
const storage = createSqliteStorage(dbPath);
let imap: ImapMailSync | undefined;
try {
  imap = await ImapMailSync.connect({
    host,
    port,
    security,
    auth: { user, pass },
    parser: new PostalMimeParser(),
  });
  console.log(
    `connected to ${host}:${port} as ${user}; capabilities: ${[...imap.capabilities].sort().join(", ") || "none"}`,
  );
  const result = await syncAccount({ ...storage, sync: imap }, account);

  const rows = result.folders.map((f) => ({
    folder: f.folderId,
    batches: f.batches,
    new: f.documents,
    "moved/copied": f.knownLocations,
    flags: f.flagsUpdated,
    removed: f.locationsRemoved,
    deleted: f.messagesDeleted,
    reset: f.reset ? "yes" : "",
  }));
  console.table(rows);
  const total = (key: "documents" | "knownLocations" | "flagsUpdated" | "messagesDeleted") =>
    result.folders.reduce((n, f) => n + f[key], 0);
  console.log(
    `${total("documents")} new, ${total("knownLocations")} moved or copied, ${total("flagsUpdated")} flag updates, ${total("messagesDeleted")} deleted; ` +
      `${imap.stats.sourcesDownloaded} sources downloaded; ${Math.round(performance.now() - started)} ms; database ${dbPath}`,
  );
} catch (error) {
  console.error(
    error instanceof ImapAuthError
      ? `Login failed for ${user} on ${host}. Check the user name and password (Gmail needs an app password).`
      : `Sync failed: ${describe(error)}`,
  );
  process.exitCode = 1;
} finally {
  await imap?.close();
  storage.close();
}
