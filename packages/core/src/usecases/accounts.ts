import type { MailServerSettings, StoredAccount } from "../domain/accounts.ts";
import { isPlausibleAddress } from "../domain/accounts.ts";
import type { Account } from "../domain/entities.ts";
import { CredentialsUnavailableError, scrubSecrets } from "../domain/errors.ts";
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
  MessageBodyPort,
  MessageStorePort,
  MoveOutboxPort,
  OutboxPort,
  ReceivedFilesPort,
  SearchIndexPort,
  UnitOfWorkPort,
} from "../ports/index.ts";

/** The synchronisation view of a stored account. */
export function toAccount(stored: StoredAccount): Account {
  return {
    id: stored.id,
    address: stored.address,
    displayName: stored.displayName,
    capabilities: [],
  };
}

export interface AddAccountInput {
  readonly address: string;
  readonly displayName: string;
  readonly password: string;
  readonly imap: MailServerSettings;
  /** Where mail is sent from; without it the account cannot send (ADR 0020). */
  readonly smtp?: MailServerSettings;
}

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
 * server if there is one, and only then stores the account and its password. Nothing is left behind when a step fails; errors never contain
 * the password.
 */
export async function addAccount(
  deps: AddAccountDeps,
  input: AddAccountInput,
): Promise<AddAccountResult> {
  const address = input.address.trim();
  if (!isPlausibleAddress(address)) throw new InvalidAccountError("Enter a valid email address");
  if (input.password === "") throw new InvalidAccountError("Enter the password");
  const { host, port, username } = input.imap;
  if (host.trim() === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidAccountError("Enter the server name and a port between 1 and 65535");
  }
  if (username.trim() === "") throw new InvalidAccountError("Enter the user name");

  const availability = await deps.credentials.availability();
  if (!availability.available) throw new CredentialsUnavailableError(availability.reason);

  let account: StoredAccount = {
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
  const credential: Credential = {
    kind: "password",
    username: account.imap.username,
    password: input.password,
  };

  let folderCount: number;
  try {
    const connection = await deps.connector.connect({ server: account.imap, credential });
    try {
      folderCount = (await connection.sync.listFolders(toAccount(account))).length;
    } finally {
      await connection.close().catch(() => {});
    }
  } catch (error) {
    throw rethrowWithoutSecret(error, [input.password]);
  }

  if (account.smtp) {
    const check = await deps.outgoing.verify({
      server: account.smtp,
      credential: { ...credential, username: account.smtp.username },
    });
    if (!check.ok) {
      throw new OutgoingServerError(
        check.kind,
        scrubSecrets(check.reason, [input.password]),
        check.detail,
      );
    }
    // The greeting told how large a message the server takes; the composer needs it early.
    if (check.limitBytes) account = { ...account, messageLimitBytes: check.limitBytes };
  }

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
