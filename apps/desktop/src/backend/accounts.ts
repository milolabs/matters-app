import type { AccountInfo, ServerInput } from "@matters/contracts";
import type {
  AccountStorePort,
  AddAccountDeps,
  DiscoveredServers,
  RejectedPasswords,
  RemoveAccountDeps,
  ServerDiscoveryPort,
  StoredAccount,
  SyncScheduler,
  SyncStatus,
} from "@matters/core";
import { addAccount, removeAccount, setNewPassword } from "@matters/core";
import type { AccountsApi, PasswordChanged } from "./handler.ts";

/** What the renderer sees of an account; no secrets are in a `StoredAccount`. */
export function accountInfo(a: StoredAccount, status: SyncStatus): AccountInfo {
  return {
    id: a.id,
    address: a.address,
    displayName: a.displayName,
    host: a.imap.host,
    port: a.imap.port,
    security: a.imap.security,
    username: a.imap.username,
    canSend: a.smtp !== undefined,
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

  discover(domain: string): Promise<DiscoveredServers | null> {
    return this.deps.discovery.discover(domain);
  }

  async list(): Promise<readonly AccountInfo[]> {
    return (await this.deps.accounts.list()).map((a) => this.info(a));
  }

  async add(input: {
    address: string;
    displayName: string;
    password: string;
    imap: ServerInput;
    smtp?: ServerInput;
  }): Promise<{ account: AccountInfo; folderCount: number }> {
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
    const { account, outgoing } = await setNewPassword(this.deps.add, { accountId, password });
    this.deps.rejected?.clear(accountId);
    // The work that waited for a password may log in again, the sync first and at once.
    void this.deps.scheduler.reconnect(accountId).catch(() => {});
    this.deps.onChanged();
    return {
      // What the window shows until the sync reports: the old refusal is over.
      account: accountInfo(account, { state: "syncing", folder: "", done: 0 }),
      outgoing: outgoing.state,
      ...(outgoing.state === "unchecked" ? { outgoingNote: outgoing.reason } : {}),
    };
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
