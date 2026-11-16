import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentKey,
  AgentKeyVaultPort,
  Credential,
  CredentialAvailability,
  CredentialPort,
} from "@matters/core";
import { CredentialsUnavailableError, SignInEndedError } from "@matters/core";

/** What protects the secrets: the operating system's keychain through Electron's `safeStorage`. */
export interface Encryptor {
  availability(): Promise<CredentialAvailability>;
  encrypt(plainText: string): Promise<Uint8Array>;
  /** `reencrypt`: the key changed since this was written; save it again. */
  decrypt(data: Uint8Array): Promise<{ readonly text: string; readonly reencrypt: boolean }>;
}

interface VaultFile {
  readonly version: 1;
  /** Account id -> base64 of the encrypted JSON of the credential. */
  readonly entries: Record<string, string>;
}

const EMPTY: VaultFile = { version: 1, entries: {} };

function isVaultFile(value: unknown): value is VaultFile {
  const v = value as { version?: unknown; entries?: unknown } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    typeof v.entries === "object" &&
    v.entries !== null &&
    Object.values(v.entries).every((e) => typeof e === "string")
  );
}

/**
 * `CredentialPort` over one file of encrypted blobs (ADR 0018). Only encrypted data touches the
 * disk, the file is replaced atomically (temp file, fsync, rename) and readable by its owner
 * only. When the encryptor is not available `set` and `get` refuse with a clear error instead
 * of falling back to anything weaker; `delete` always works.
 */
/** The vault entry of a runtime's API key (ADR 0141, rule 4): never an account's id (`acc-…`). */
export const AGENT_KEY_PREFIX = "agent-key:";
const RUNTIME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The vault entry of a runtime's key; throws for an id that is not a runtime's. */
export function agentKeyEntry(runtimeId: string): string {
  if (!RUNTIME_ID.test(runtimeId)) throw new Error("Not a runtime");
  return `${AGENT_KEY_PREFIX}${runtimeId}`;
}

/** A kept key of a known shape, or null: what is read back or crosses a process is checked. */
export function parseAgentKey(v: unknown): AgentKey | null {
  const r = v as { kind?: unknown; key?: unknown; savedAtMs?: unknown } | null;
  if (typeof r !== "object" || r === null) return null;
  if (typeof r.key !== "string" || r.key.length === 0 || r.key.length > 512) return null;
  if (typeof r.savedAtMs !== "number" || !Number.isFinite(r.savedAtMs)) return null;
  return { key: r.key, savedAtMs: r.savedAtMs };
}

export class EncryptedFileCredentialStore implements CredentialPort {
  private readonly path: string;
  private readonly encryptor: Encryptor;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(path: string, encryptor: Encryptor) {
    this.path = path;
    this.encryptor = encryptor;
  }

  availability(): Promise<CredentialAvailability> {
    return this.encryptor.availability();
  }

  get(accountId: string): Promise<Credential | null> {
    if (accountId.startsWith(AGENT_KEY_PREFIX)) return Promise.resolve(null);
    return this.exclusive(async () => {
      const file = await this.read();
      const blob = file.entries[accountId];
      if (blob === undefined) return null;
      await this.requireAvailable();
      let decrypted: Awaited<ReturnType<Encryptor["decrypt"]>>;
      try {
        decrypted = await this.encryptor.decrypt(Buffer.from(blob, "base64"));
      } catch {
        throw new CredentialsUnavailableError(
          "The saved password can no longer be decrypted. Enter it again.",
        );
      }
      const credential = JSON.parse(decrypted.text) as Credential;
      if (decrypted.reencrypt) await this.write(file, accountId, credential);
      return credential;
    });
  }

  set(accountId: string, credential: Credential): Promise<void> {
    if (accountId.startsWith(AGENT_KEY_PREFIX)) return Promise.reject(new Error("Not an account"));
    return this.exclusive(async () => {
      await this.requireAvailable();
      await this.write(await this.read(), accountId, credential);
    });
  }

  // --- The API keys of runtimes billed to them (ADR 0141, rule 4), beside the passwords ---

  /** `AgentKeyVaultPort.get`: the kept key of a runtime, or null. */
  async getKey(runtimeId: string): Promise<AgentKey | null> {
    const entry = agentKeyEntry(runtimeId);
    return this.exclusive(async () => {
      const file = await this.read();
      const blob = file.entries[entry];
      if (blob === undefined) return null;
      await this.requireAvailable();
      let decrypted: Awaited<ReturnType<Encryptor["decrypt"]>>;
      try {
        decrypted = await this.encryptor.decrypt(Buffer.from(blob, "base64"));
      } catch {
        throw new CredentialsUnavailableError(
          "The saved key can no longer be decrypted. Paste it again.",
        );
      }
      let key: AgentKey | null = null;
      try {
        key = parseAgentKey(JSON.parse(decrypted.text));
      } catch {
        key = null;
      }
      if (key !== null && decrypted.reencrypt) await this.write(file, entry, key);
      return key;
    });
  }

  async setKey(runtimeId: string, key: AgentKey): Promise<void> {
    const entry = agentKeyEntry(runtimeId);
    const kept = parseAgentKey(key);
    if (kept === null) throw new Error("Not a key");
    return this.exclusive(async () => {
      await this.requireAvailable();
      await this.write(await this.read(), entry, kept);
    });
  }

  async deleteKey(runtimeId: string): Promise<void> {
    await this.delete(agentKeyEntry(runtimeId));
  }

  /** How many keys of runtimes are kept, read without decrypting (the erase review, ADR 0138). */
  countKeys(): Promise<number> {
    return this.exclusive(async () => {
      const file = await this.read();
      return Object.keys(file.entries).filter((id) => id.startsWith(AGENT_KEY_PREFIX)).length;
    });
  }

  /** The vault as an `AgentKeyVaultPort`, for code that knows only the port. */
  keys(): AgentKeyVaultPort {
    return {
      get: (runtimeId) => this.getKey(runtimeId),
      set: (runtimeId, key) => this.setKey(runtimeId, key),
      delete: (runtimeId) => this.deleteKey(runtimeId),
    };
  }

  /**
   * Replaces the whole file with these credentials in one atomic write: either every one of them
   * is saved or the file is as it was (ADR 0105: the identity move writes the passwords once).
   */
  replaceAll(credentials: Readonly<Record<string, Credential>>): Promise<void> {
    return this.exclusive(async () => {
      await this.requireAvailable();
      const entries: Record<string, string> = {};
      for (const [accountId, credential] of Object.entries(credentials)) {
        const encrypted = await this.encryptor.encrypt(JSON.stringify(credential));
        entries[accountId] = Buffer.from(encrypted).toString("base64");
      }
      await this.save({ version: 1, entries });
    });
  }

  /**
   * Moves the encrypted entry of `fromId` to `toId` in one atomic write (ADR 0133, rule 6): the
   * blob is not decrypted, so the move needs nothing of the encryptor.
   */
  move(fromId: string, toId: string): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.read();
      const blob = file.entries[fromId];
      if (blob === undefined) throw new SignInEndedError();
      if (fromId === toId) return;
      const { [fromId]: _gone, ...entries } = file.entries;
      await this.save({ version: 1, entries: { ...entries, [toId]: blob } });
    });
  }

  delete(accountId: string): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.read();
      if (!(accountId in file.entries)) return;
      const { [accountId]: _gone, ...entries } = file.entries;
      await this.save({ version: 1, entries });
    });
  }

  private async requireAvailable(): Promise<void> {
    const state = await this.encryptor.availability();
    if (!state.available) throw new CredentialsUnavailableError(state.reason);
  }

  private async write(
    file: VaultFile,
    accountId: string,
    credential: Credential | AgentKey,
  ): Promise<void> {
    const encrypted = await this.encryptor.encrypt(JSON.stringify(credential));
    await this.save({
      version: 1,
      entries: { ...file.entries, [accountId]: Buffer.from(encrypted).toString("base64") },
    });
  }

  /** A file that cannot be read as a vault is set aside, never overwritten silently. */
  private async read(): Promise<VaultFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return EMPTY;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isVaultFile(parsed)) return parsed;
    } catch {
      // fall through to set-aside
    }
    await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
    return EMPTY;
  }

  private async save(file: VaultFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(file));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** One operation at a time: read-modify-write must not interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {});
    return result;
  }
}
