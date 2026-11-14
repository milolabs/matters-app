import type { MailServerSettings, StoredAccount } from "../domain/accounts.ts";
import { isPlausibleAddress } from "../domain/accounts.ts";
import type { Account } from "../domain/entities.ts";
import { CredentialsUnavailableError, SignInEndedError, scrubSecrets } from "../domain/errors.ts";
import type { FailureDetail } from "../domain/signIn.ts";
import type {
  AccountStorePort,
  AttachmentStorePort,
  Credential,
  CredentialPort,
  CursorPort,
  DraftStorePort,
  FileWorkPort,
  FlagOutboxPort,
  MailConnectorPort,
  MailSubmitPort,
  MailTarget,
  MessageBodyPort,
  MessageStorePort,
  MoveOutboxPort,
  OutboxPort,
  ReceivedFilesPort,
  SearchIndexPort,
  UnitOfWorkPort,
} from "../ports/index.ts";

/**
 * The synchronisation view of a stored account. Microsoft keeps the Sent copy of a Graph
 * account's mail itself (ADR 0136, rule 9).
 */
export function toAccount(stored: StoredAccount): Account {
  return {
    id: stored.id,
    address: stored.address,
    displayName: stored.displayName,
    capabilities: stored.transport === "graph" ? ["savesSent"] : [],
  };
}

/**
 * Where the account's incoming mail is read (ADR 0136, rule 4): its IMAP server, or Graph. The
 * credential is the one the vault gave for the account.
 */
export function incomingTarget(account: StoredAccount, credential: Credential): MailTarget {
  if (account.transport === "graph") return { transport: "graph", credential };
  return { server: account.imap, credential };
}

/**
 * Where the account's mail is sent: its SMTP server with its own user name for a password (one
 * token serves both servers, ADR 0133, rule 9), or Graph. Null for an IMAP account without an
 * outgoing server.
 */
export function outgoingTarget(account: StoredAccount, credential: Credential): MailTarget | null {
  if (account.transport === "graph") return { transport: "graph", credential };
  if (!account.smtp) return null;
  return {
    server: account.smtp,
    credential:
      credential.kind === "password"
        ? { ...credential, username: account.smtp.username }
        : credential,
  };
}

interface AddAccountIdentity {
  readonly address: string;
  readonly displayName: string;
}

type AddAccountFields = AddAccountIdentity &
  (
    | {
        readonly transport?: "imap";
        readonly imap: MailServerSettings;
        /** Where mail is sent from; without it the account cannot send (ADR 0020). */
        readonly smtp?: MailServerSettings;
      }
    | {
        /** No server settings: they are not asked for and not stored (ADR 0136, rules 2, 13). */
        readonly transport: "graph";
        readonly imap?: undefined;
        readonly smtp?: undefined;
      }
  );

/**
 * The account to add, with how it signs in: a password (ADR 0018), or the handle of a browser
 * sign-in that main holds for 10 minutes (ADR 0133, rule 6). The handle is not a secret of its
 * own: the vault reads the token by it, and only main can. A Graph account signs in only through
 * the browser (ADR 0136, rule 3).
 */
export type AddAccountInput = AddAccountFields &
  (
    | { readonly password: string; readonly signIn?: undefined }
    | { readonly signIn: string; readonly password?: undefined }
  );

export interface AddAccountDeps {
  readonly accounts: AccountStorePort;
  readonly credentials: CredentialPort;
  readonly connector: MailConnectorPort;
  /** Tests the outgoing server before anything is saved. */
  readonly outgoing: Pick<MailSubmitPort, "verify">;
  newId(): string;
  now(): number;
}

export class InvalidAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountError";
  }
}

/** Incoming mail works, the outgoing server does not. The `kind` says why. */
export class OutgoingServerError extends Error {
  readonly kind: "auth" | "tls" | "unreachable" | "other";
  /** What the outgoing server's answer told (ADR 0114); never part of the message. */
  readonly detail?: FailureDetail;
  constructor(kind: OutgoingServerError["kind"], message: string, detail?: FailureDetail) {
    super(message);
    this.name = "OutgoingServerError";
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface AddAccountResult {
  readonly account: StoredAccount;
  /** Folders the test login found. */
  readonly folderCount: number;
}

/**
 * Checks that the password can be kept, logs in and lists folders, logs in to the outgoing
 * server if there is one, and only then stores the account and its password. Nothing is left
 * behind when a step fails; errors never contain the password.
 *
 * With a browser sign-in (`signIn`, ADR 0133, rule 6) the steps are the same with the token the
 * handle holds: both servers are tested, the account is stored, and the vault moves what the
 * handle holds to the account in one write. On any failure the handle's sign-in is dropped, so
 * a token that did not work is never kept.
 */
export async function addAccount(
  deps: AddAccountDeps,
  input: AddAccountInput,
): Promise<AddAccountResult> {
  if (input.signIn === undefined) {
    if (input.transport === "graph") {
      throw new InvalidAccountError("A Microsoft account signs in through the browser");
    }
    return addWithPassword(deps, input, input.password);
  }
  const handle = input.signIn;
  try {
    return await addWithSignIn(deps, input, handle);
  } catch (error) {
    await deps.credentials.delete(handle).catch(() => {});
    throw error;
  }
}

/** The account as it will be stored, from what was typed; throws for what cannot be used. */
function accountFrom(deps: AddAccountDeps, input: AddAccountFields): StoredAccount {
  const address = input.address.trim();
  if (!isPlausibleAddress(address)) throw new InvalidAccountError("Enter a valid email address");
  if (input.transport === "graph") {
    return {
      id: deps.newId(),
      transport: "graph",
      address,
      displayName: input.displayName.trim() || address,
      createdAtMs: deps.now(),
    };
  }
  const { host, port, username } = input.imap;
  if (host.trim() === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidAccountError("Enter the server name and a port between 1 and 65535");
  }
  if (username.trim() === "") throw new InvalidAccountError("Enter the user name");
  return {
    id: deps.newId(),
    address,
    displayName: input.displayName.trim() || address,
    imap: { ...input.imap, host: host.trim(), username: username.trim() },
    ...(input.smtp && input.smtp.host.trim() !== ""
      ? {
          smtp: {
            ...input.smtp,
            host: input.smtp.host.trim(),
            username: input.smtp.username.trim() || username.trim(),
          },
        }
      : {}),
    createdAtMs: deps.now(),
  };
}

async function requireVault(credentials: CredentialPort): Promise<void> {
  const availability = await credentials.availability();
  if (!availability.available) throw new CredentialsUnavailableError(availability.reason);
}

async function addWithPassword(
  deps: AddAccountDeps,
  input: AddAccountFields,
  password: string,
): Promise<AddAccountResult> {
  // The address before the password, as the form reads.
  if (!isPlausibleAddress(input.address.trim())) {
    throw new InvalidAccountError("Enter a valid email address");
  }
  if (password === "") throw new InvalidAccountError("Enter the password");
  let account = accountFrom(deps, input);
  if (account.transport === "graph") throw new InvalidAccountError("Enter the server settings");
  await requireVault(deps.credentials);

  const credential: Credential = { kind: "password", username: account.imap.username, password };
  const { folderCount, limitBytes } = await testServers(deps, account, credential, [password]);
  if (limitBytes) account = { ...account, messageLimitBytes: limitBytes };

  // Credential first: an account without a password would be broken, a stray password is not.
  await deps.credentials.set(account.id, credential);
  try {
    await deps.accounts.add(account);
  } catch (error) {
    await deps.credentials.delete(account.id).catch(() => {});
    throw error;
  }
  return { account, folderCount };
}

async function addWithSignIn(
  deps: AddAccountDeps,
  input: AddAccountFields,
  handle: string,
): Promise<AddAccountResult> {
  if (handle === "") throw new SignInEndedError();
  let account = accountFrom(deps, input);
  await requireVault(deps.credentials);

  const credential = await deps.credentials.get(handle);
  if (credential?.kind !== "oauth2") throw new SignInEndedError();
  // A token is for one resource (ADR 0136, Context): Graph's entry for a Graph account only.
  if ((account.transport === "graph") !== (credential.provider === "microsoftGraph")) {
    throw new InvalidAccountError("That sign-in was made for another kind of account");
  }
  const { folderCount, limitBytes } = await testServers(deps, account, credential, [
    credential.accessToken,
  ]);
  if (limitBytes) account = { ...account, messageLimitBytes: limitBytes };

  // Account first, then the move: until the move the token is the handle's, which a failure
  // drops; an account whose move failed is taken back out.
  await deps.accounts.add(account);
  try {
    await deps.credentials.move(handle, account.id);
  } catch (error) {
    await deps.accounts.remove(account.id).catch(() => {});
    await deps.credentials.delete(account.id).catch(() => {});
    throw error;
  }
  return { account, folderCount };
}

/**
 * Logs in to the incoming server and lists its folders, then to the outgoing one if there is
 * one. The one credential serves both; the outgoing server has its own user name (ADR 0133,
 * rule 9 for a token: the connector takes the user name from the server's settings). A Graph
 * account lists its folders over Graph and has its outgoing check asked there (ADR 0136, rule 9).
 */
async function testServers(
  deps: AddAccountDeps,
  account: StoredAccount,
  credential: Credential,
  secrets: readonly string[],
): Promise<{ readonly folderCount: number; readonly limitBytes?: number | null }> {
  let folderCount: number;
  try {
    const connection = await deps.connector.connect(incomingTarget(account, credential));
    try {
      folderCount = (await connection.sync.listFolders(toAccount(account))).length;
    } finally {
      await connection.close().catch(() => {});
    }
  } catch (error) {
    throw rethrowWithoutSecret(error, secrets);
  }
  const outgoing = outgoingTarget(account, credential);
  if (!outgoing) return { folderCount };
  const check = await deps.outgoing.verify(outgoing);
  if (!check.ok) {
    throw new OutgoingServerError(check.kind, scrubSecrets(check.reason, secrets), check.detail);
  }
  // The greeting told how large a message the server takes; the composer needs it early.
  return { folderCount, ...(check.limitBytes ? { limitBytes: check.limitBytes } : {}) };
}

/** The same error, with the secrets gone from its message (the `kind` and class are kept). */
function rethrowWithoutSecret(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return new Error(scrubSecrets(String(error), secrets));
  const clean = scrubSecrets(error.message, secrets);
  if (clean !== error.message) error.message = clean;
  return error;
}

export interface RemoveAccountDeps {
  readonly accounts: AccountStorePort;
  readonly store: MessageStorePort;
  readonly index: SearchIndexPort;
  readonly bodies: MessageBodyPort;
  readonly cursors: CursorPort;
  readonly outbox?: OutboxPort;
  readonly flagOps?: Pick<FlagOutboxPort, "discardAccount">;
  readonly moveOps?: Pick<MoveOutboxPort, "discardAccount">;
  readonly drafts?: DraftStorePort;
  /** With `files`: the account's attachments and spools go with it (ADR 0041, rule 19). */
  readonly attachments?: Pick<AttachmentStorePort, "discardAccount" | "listByState">;
  readonly files?: Pick<FileWorkPort, "removeAttachments" | "removeSpool">;
  /** With it, the account's downloaded copies of received files go too (ADR 0043, rule 8). */
  readonly received?: Pick<ReceivedFilesPort, "removeMessages">;
  readonly uow: UnitOfWorkPort;
  readonly credentials: CredentialPort;
}

const REMOVE_CHUNK = 2000;
const ALL_STATES = [
  "pending",
  "held",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "voided",
] as const;

/**
 * Deletes the account with its messages, locations, bodies, index entries, cursors and queued
 * operations in one unit of work, then its password. A password that cannot be deleted does
 * not bring the account back: the error is reported and the stray secret is unreachable.
 * Stop the account's sync first.
 */
export async function removeAccount(deps: RemoveAccountDeps, accountId: string): Promise<boolean> {
  // Files are deleted after the rows are: a file with no row is swept, a row with no file is not.
  const stored: string[] = [];
  const spools: string[] = [];
  const messageKeys: number[] = [];
  const existed = await deps.uow.run(async () => {
    if (deps.attachments) {
      for (const row of await deps.attachments.listByState([
        "reading",
        "ready",
        "failed",
        "tooLarge",
      ])) {
        if (row.accountId === accountId) stored.push(row.id);
      }
    }
    if (deps.outbox) {
      for (const op of await deps.outbox.listByState(ALL_STATES)) {
        const spool = op.accountId === accountId ? await deps.outbox.getSpool(op.id) : null;
        if (spool) spools.push(spool.path);
      }
    }
    const found = await deps.accounts.get(accountId);
    const keys = await deps.store.removeAccountMessages(accountId);
    messageKeys.push(...keys);
    for (let i = 0; i < keys.length; i += REMOVE_CHUNK) {
      const chunk = keys.slice(i, i + REMOVE_CHUNK);
      await deps.index.removeMessages(chunk);
      await deps.bodies.removeBodies(chunk);
    }
    await deps.cursors.deleteAccount(accountId);
    await deps.outbox?.discardAccount(accountId);
    await deps.flagOps?.discardAccount(accountId);
    await deps.moveOps?.discardAccount(accountId);
    await deps.drafts?.discardAccount(accountId);
    await deps.attachments?.discardAccount(accountId);
    await deps.accounts.remove(accountId);
    return found !== null;
  });
  if (deps.received) await deps.received.removeMessages(messageKeys).catch(() => {});
  if (deps.files) {
    await deps.files.removeAttachments(stored).catch(() => {});
    for (const path of spools) await deps.files.removeSpool(path).catch(() => {});
  }
  await deps.credentials.delete(accountId);
  return existed;
}
