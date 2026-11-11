import type { AccountInfo, ServerInput } from "@matters/contracts";
import type {
  AccountStorePort,
  DiscoveredServers,
  ServerDiscoveryPort,
  SyncStatus,
} from "@matters/core";
import { accountInfo } from "./accounts.ts";
import type { AccountsApi, PasswordChanged } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

export interface RemoteAccountsDeps {
  /** The reader connection: the list is small and committed data is all it ever needs. */
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly discovery: ServerDiscoveryPort;
  readonly host: SyncHost;
  /** Last status the worker reported per account. */
  readonly statuses: Map<string, SyncStatus>;
  /** Accounts changed in a way the UI has to hear about. */
  readonly onChanged: () => void;
}

/**
 * The account requests as the router serves them: discovery and the list are local reads,
 * everything that writes or talks to a mail server is a command to the sync worker.
 */
export class RemoteAccounts implements AccountsApi {
  private readonly deps: RemoteAccountsDeps;

  constructor(deps: RemoteAccountsDeps) {
    this.deps = deps;
  }

  discover(domain: string): Promise<DiscoveredServers | null> {
    return this.deps.discovery.discover(domain);
  }

  async list(): Promise<readonly AccountInfo[]> {
    const { statuses } = this.deps;
    return (await this.deps.accounts.list()).map((a) =>
      accountInfo(a, statuses.get(a.id) ?? { state: "idle" }),
    );
  }

  async add(input: {
    address: string;
    displayName: string;
    password: string;
    imap: ServerInput;
    smtp?: ServerInput;
  }): Promise<{ account: AccountInfo; folderCount: number }> {
    const added = await this.deps.host.command({ name: "addAccount", ...input });
    this.deps.statuses.set(added.account.id, added.account.status);
    this.deps.onChanged();
    return added;
  }

  async remove(accountId: string): Promise<boolean> {
    const removed = await this.deps.host.command({ name: "removeAccount", accountId });
    if (removed) {
      this.deps.statuses.delete(accountId);
      this.deps.onChanged();
    }
    return removed;
  }

  /** The password goes to the worker, which verifies it and writes the vault; it comes back to no one. */
  async changePassword(accountId: string, password: string): Promise<PasswordChanged | null> {
    const changed = await this.deps.host.command({ name: "changePassword", accountId, password });
    if (changed) {
      this.deps.statuses.set(accountId, changed.account.status);
      this.deps.onChanged();
    }
    return changed;
  }

  syncNow(accountId: string): Promise<boolean> {
    return this.deps.host.command({ name: "syncNow", accountId });
  }
}
