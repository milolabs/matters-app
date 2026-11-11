import type { StoredAccount } from "../domain/accounts.ts";
import { CredentialsUnavailableError, scrubSecrets } from "../domain/errors.ts";
import {
  type FailureDetail,
  newPasswordCanFix,
  refusalIsTemporary,
  type SignInRefusal,
} from "../domain/signIn.ts";
import type {
  AccountStorePort,
  Credential,
  CredentialAvailability,
  CredentialPort,
  MailConnectorPort,
  MailSubmitPort,
} from "../ports/index.ts";
import { InvalidAccountError, OutgoingServerError } from "./accounts.ts";
import type { SyncStatus } from "./syncScheduler.ts";

/** Longer than any password a mail server takes; a bound on what a request may carry. */
export const MAX_PASSWORD_LENGTH = 4096;

export interface NewPasswordDeps {
  readonly accounts: Pick<AccountStorePort, "get">;
  readonly credentials: CredentialPort;
  readonly connector: MailConnectorPort;
  /** Logs in to the outgoing server without sending anything. */
  readonly outgoing: Pick<MailSubmitPort, "verify">;
}

/** What the outgoing server said of the new password (ADR 0113, rule 3). */
export type OutgoingVerdict =
  /** It logged in. */
  | { readonly state: "verified" }
  /** The account does not send. */
  | { readonly state: "none" }
  /** It could not be asked (offline, a certificate, a bad answer): nothing says the password is wrong. */
  | { readonly state: "unchecked"; readonly reason: string };

export interface NewPasswordResult {
  readonly account: StoredAccount;
  readonly outgoing: OutgoingVerdict;
}

/** No account has this id. */
export class AccountNotFoundError extends Error {
  constructor() {
    super("That account is no longer here.");
    this.name = "AccountNotFoundError";
  }
}

/**
 * Gives an existing account a new password (ADR 0113). The incoming server must accept it, and
 * the outgoing server must not refuse it, before the vault is written; until then the stored
 * password is untouched. The vault replaces the entry in one atomic write. Errors never contain
 * the password. The servers, the user name and every local message stay as they are.
 */
export async function setNewPassword(
  deps: NewPasswordDeps,
  input: { readonly accountId: string; readonly password: string },
): Promise<NewPasswordResult> {
  const { password } = input;
  if (password === "") throw new InvalidAccountError("Enter the password");
  if (password.length > MAX_PASSWORD_LENGTH)
    throw new InvalidAccountError("That password is too long");
  const account = await deps.accounts.get(input.accountId);
  if (!account) throw new AccountNotFoundError();

  const availability = await deps.credentials.availability();
  if (!availability.available) throw new CredentialsUnavailableError(availability.reason);

  const credential: Credential = { kind: "password", username: account.imap.username, password };
  try {
    const connection = await deps.connector.connect({ server: account.imap, credential });
    await connection.close().catch(() => {});
  } catch (error) {
    throw withoutSecret(error, password);
  }

  let outgoing: OutgoingVerdict = { state: "none" };
  if (account.smtp) {
    // The one stored password serves both servers; the outgoing one has its own user name.
    const check = await deps.outgoing.verify({
      server: account.smtp,
      credential: { ...credential, username: account.smtp.username },
    });
    if (check.ok) outgoing = { state: "verified" };
    else if (check.kind === "auth") {
      throw new OutgoingServerError("auth", scrubSecrets(check.reason, [password]), check.detail);
    } else outgoing = { state: "unchecked", reason: scrubSecrets(check.reason, [password]) };
  }

  try {
    await deps.credentials.set(account.id, credential);
  } catch (error) {
    throw withoutSecret(error, password);
  }
  return { account, outgoing };
}

function withoutSecret(error: unknown, password: string): unknown {
  if (!(error instanceof Error)) return new Error(scrubSecrets(String(error), [password]));
  const clean = scrubSecrets(error.message, [password]);
  if (clean !== error.message) error.message = clean;
  return error;
}

/**
 * The server turned the saved password down, for a reason only the person can end, and nothing
 * has changed since. `detail.refusal` is the server's reason (ADR 0114).
 */
export class PasswordRejectedError extends Error {
  readonly kind = "auth";
  readonly detail: FailureDetail;
  constructor(refusal: SignInRefusal = "unknown") {
    super(
      newPasswordCanFix(refusal)
        ? "The server refused the saved password. Enter the new one in Settings, Accounts."
        : `The server turned the sign-in away (${refusal}). Settings, Accounts says what it needs; then choose Sync now.`,
    );
    this.name = "PasswordRejectedError";
    this.detail = { refusal };
  }
}

/**
 * Accounts whose sign-in the incoming server refused for a reason that lasts until the person
 * acts (ADR 0113, rule 4; a temporary refusal, `unavailable` or `throttled`, is not one). While an
 * account is here, work that would log in on its own (pushing read state and moves, the Sent
 * copy, downloads, sends, the size probe) gets `PasswordRejectedError` from `guard` instead of
 * the password, so the server never sees the refused sign-in again until the person acts. The
 * sync scheduler reads the vault itself: it already stops on such a refusal and tries once more
 * only on "Sync now". Kept in memory: after a restart the first sync finds out again.
 */
export class RejectedPasswords {
  private readonly ids = new Map<string, SignInRefusal>();

  /**
   * Follows the scheduler: a lasting refusal marks the account, a settled sync without error
   * clears it. A temporary refusal changes nothing.
   */
  note(accountId: string, status: SyncStatus): void {
    if (status.state === "error" && status.kind === "auth") {
      const refusal = status.detail?.refusal ?? "unknown";
      if (!refusalIsTemporary(refusal)) this.ids.set(accountId, refusal);
    } else if (status.state === "idle") this.ids.delete(accountId);
  }

  /** A new password was verified and stored, or the account is gone. */
  clear(accountId: string): void {
    this.ids.delete(accountId);
  }

  has(accountId: string): boolean {
    return this.ids.has(accountId);
  }

  /** The same vault, closed for the accounts marked here. */
  guard(inner: CredentialPort): CredentialPort {
    return {
      availability: (): Promise<CredentialAvailability> => inner.availability(),
      get: async (accountId) => {
        const refusal = this.ids.get(accountId);
        if (refusal !== undefined) throw new PasswordRejectedError(refusal);
        return inner.get(accountId);
      },
      set: (accountId, credential) => inner.set(accountId, credential),
      delete: (accountId) => inner.delete(accountId),
    };
  }
}
