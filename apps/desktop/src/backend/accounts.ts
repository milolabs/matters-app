import type { AccountInfo } from "@matters/contracts";
import type {
  AccountStorePort,
  AddAccountDeps,
  Discovery,
  NewPasswordResult,
  RejectedPasswords,
  RemoveAccountDeps,
  ServerDiscoveryPort,
  StoredAccount,
  SyncScheduler,
  SyncStatus,
} from "@matters/core";
import {
  addAccount,
  canSendFrom,
  removeAccount,
  saveSignature,
  setNewPassword,
  signInAgain,
} from "@matters/core";
import type { AccountsApi, NewAccountInput, PasswordChanged } from "./handler.ts";

/** What the renderer sees of an account; no secrets are in a `StoredAccount`. */
export function accountInfo(a: StoredAccount, status: SyncStatus): AccountInfo {
  return {
    id: a.id,
    address: a.address,
    displayName: a.displayName,
    // A Graph account has no servers to show (ADR 0136, rule 2).
    ...(a.transport === "graph" ? { transport: "graph" as const } : {}),
    host: a.imap?.host ?? "",
    port: a.imap?.port ?? 0,
    security: a.imap?.security ?? "tls",
    username: a.imap?.username ?? "",
    canSend: canSendFrom(a),
    ...(a.signature === undefined ? {} : { signature: a.signature }),
    status,
  };
}

export interface AccountServiceDeps {
  /** Reads; the list is small and never needs a unit of work. */
  readonly accounts: Pick<AccountStorePort, "list" | "get">;
  /** Also what a new password is verified and stored with (ADR 0113). */
  readonly add: AddAccountDeps;
  readonly remove: RemoveAccountDeps;
  readonly discovery: ServerDiscoveryPort;
  readonly scheduler: SyncScheduler;
  /** Accounts whose saved password the server refused; a verified new one takes them out. */
  readonly rejected?: RejectedPasswords;
  /** Accounts or their messages changed in a way the UI has to hear about. */
  readonly onChanged: () => void;
}

/**
 * The account requests of the renderer, over the core use cases and the scheduler. In the app
 * this runs inside the sync worker (it writes); the router serves the same API through
 * `RemoteAccounts`.
 */
export class AccountService implements AccountsApi {
  private readonly deps: AccountServiceDeps;

  constructor(deps: AccountServiceDeps) {
    this.deps = deps;
  }

  discover(domain: string): Promise<Discovery> {
    return this.deps.discovery.discover(domain);
  }

  async list(): Promise<readonly AccountInfo[]> {
    return (await this.deps.accounts.list()).map((a) => this.info(a));
  }

  /** With a password, or with the handle of a browser sign-in main holds (ADR 0133, rule 6). */
  async add(input: NewAccountInput): Promise<{ account: AccountInfo; folderCount: number }> {
    const { account, folderCount } = await addAccount(this.deps.add, input);
    this.deps.scheduler.add(account);
    this.deps.onChanged();
    return { account: this.info(account), folderCount };
  }

  async remove(accountId: string): Promise<boolean> {
    if (!(await this.deps.accounts.get(accountId))) return false;
    // Stop first: a sync that writes while its data is deleted would bring messages back.
    await this.deps.scheduler.remove(accountId);
    await removeAccount(this.deps.remove, accountId);
    this.deps.rejected?.clear(accountId);
    this.deps.onChanged();
    return true;
  }

  async changePassword(accountId: string, password: string): Promise<PasswordChanged | null> {
    if (!(await this.deps.accounts.get(accountId))) return null;
    // Throws with the stored password untouched when a server refuses or the vault fails.
    const result = await setNewPassword(this.deps.add, { accountId, password });
    this.deps.rejected?.clear(accountId);
    return this.mended(result);
  }

  /**
   * *Sign in again* (ADR 0133, rule 11), with the after-effects of a verified new password (ADR
   * 0113, rules 4 and 5): the refusal's mark ends and the account's work logs in again.
   */
  async signInAgain(accountId: string, signIn: string): Promise<PasswordChanged | null> {
    if (!(await this.deps.accounts.get(accountId))) {
      // The held sign-in is of no use now; it is dropped rather than left for 10 minutes.
      await this.deps.add.credentials.delete(signIn).catch(() => {});
      return null;
    }
    // Throws with the stored sign-in untouched when a server refuses or the vault fails.
    const result = await signInAgain(
      { ...this.deps.add, ...(this.deps.rejected ? { rejected: this.deps.rejected } : {}) },
      { accountId, signIn },
    );
    return this.mended(result);
  }

  /** What follows a verified new password or sign-in: the sync first, and at once. */
  private mended({ account, outgoing }: NewPasswordResult): PasswordChanged {
    void this.deps.scheduler.reconnect(account.id).catch(() => {});
    this.deps.onChanged();
    return {
      // What the window shows until the sync reports: the old refusal is over.
      account: accountInfo(account, { state: "syncing", folder: "", done: 0 }),
      outgoing: outgoing.state,
      ...(outgoing.state === "unchecked" ? { outgoingNote: outgoing.reason } : {}),
    };
  }

  /** Throws `InvalidSignatureError` with words for the field (ADR 0142). */
  async setSignature(accountId: string, signature: string): Promise<string | null> {
    // Written with the store accounts are added with: this one only reads.
    const kept = await saveSignature({ accounts: this.deps.add.accounts }, accountId, signature);
    if (kept !== null) this.deps.onChanged();
    return kept;
  }

  async syncNow(accountId: string): Promise<boolean> {
    if (!(await this.deps.accounts.get(accountId))) return false;
    this.deps.scheduler.syncNow(accountId);
    return true;
  }

  private info(a: StoredAccount): AccountInfo {
    return accountInfo(a, this.deps.scheduler.status(a.id) ?? { state: "idle" });
  }
}
