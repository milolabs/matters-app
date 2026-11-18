// After a restore, the accounts whose saved password or sign-in this Mac holds back (ADR 0145,
// rule 9). The vault keeps a credential per account id; a backup's account with an id that is
// here too but another server, user name or address would otherwise be sent this Mac's password
// for that id. Such an account answers as one with nothing saved (`get` gives null), so its row
// asks for the password or the sign-in in place, until a new one is saved for it (a verified
// `set`, or a tested sign-in `move`d onto it) or it is removed. The list is read the first time
// the backend asks for a credential, not at launch.
import type { Credential, CredentialGetOptions, CredentialPort } from "@matters/core";

export interface HeldList {
  read(): Promise<readonly string[]>;
  write(ids: readonly string[]): Promise<void>;
}

export function holdRestoredAccounts(inner: CredentialPort, list: HeldList): CredentialPort {
  let held: Promise<Set<string>> | null = null;
  const current = () => {
    held ??= list.read().then(
      (ids) => new Set(ids),
      () => new Set<string>(),
    );
    return held;
  };
  /** The account has its own credential again: it is held no longer. */
  const release = async (accountId: string) => {
    const set = await current();
    if (!set.delete(accountId)) return;
    await list.write([...set]);
  };
  return {
    availability: () => inner.availability(),
    async get(accountId: string, options?: CredentialGetOptions): Promise<Credential | null> {
      if ((await current()).has(accountId)) return null;
      return inner.get(accountId, options);
    },
    async set(accountId: string, credential: Credential): Promise<void> {
      await inner.set(accountId, credential);
      await release(accountId);
    },
    async delete(accountId: string): Promise<void> {
      await inner.delete(accountId);
      await release(accountId);
    },
    async move(fromId: string, toId: string): Promise<void> {
      await inner.move(fromId, toId);
      await release(toId);
    },
  };
}
