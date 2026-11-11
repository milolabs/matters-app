import { ImapFlow } from "imapflow";

export interface Credentials {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
}

/** A second client the tests use to change the mailbox the way another device would. */
export class Admin {
  private readonly client: ImapFlow;

  private constructor(client: ImapFlow) {
    this.client = client;
  }

  static async connect(c: Credentials): Promise<Admin> {
    const client = new ImapFlow({
      host: c.host,
      port: c.port,
      secure: false,
      auth: { user: c.user, pass: c.pass },
      logger: false,
      disableAutoIdle: true,
    });
    client.on("error", () => {});
    await client.connect();
    return new Admin(client);
  }

  async close(): Promise<void> {
    await this.client.logout().catch(() => this.client.close());
  }

  async append(path: string, raw: string, flags: string[] = []): Promise<number> {
    const result = await this.client.append(path, raw, flags);
    const uid = result ? result.uid : undefined;
    if (!uid) throw new Error(`append to ${path} returned no UID`);
    return uid;
  }

  async appendMany(path: string, raws: readonly string[]): Promise<void> {
    for (const raw of raws) await this.append(path, raw);
  }

  private async inFolder<T>(path: string, work: () => Promise<T>): Promise<T> {
    const lock = await this.client.getMailboxLock(path);
    try {
      return await work();
    } finally {
      lock.release();
    }
  }

  flagAdd(path: string, uid: number, flags: string[], useLabels = false): Promise<boolean> {
    return this.inFolder(path, () =>
      this.client.messageFlagsAdd(String(uid), flags, { uid: true, useLabels }),
    );
  }

  expunge(path: string, ...uids: number[]): Promise<boolean> {
    return this.inFolder(path, () => this.client.messageDelete(uids.join(","), { uid: true }));
  }

  async move(from: string, uid: number, to: string): Promise<void> {
    await this.inFolder(from, () => this.client.messageMove(String(uid), to, { uid: true }));
  }

  async copy(from: string, uid: number, to: string): Promise<void> {
    await this.inFolder(from, () => this.client.messageCopy(String(uid), to, { uid: true }));
  }

  async createFolder(path: string): Promise<void> {
    await this.client.mailboxCreate(path);
  }

  async deleteFolder(path: string): Promise<void> {
    await this.client.mailboxDelete(path);
  }

  async uidValidity(path: string): Promise<string> {
    const status = await this.client.status(path, { uidValidity: true });
    return status ? String(status.uidValidity) : "";
  }

  /** Every message of a folder as the server holds it: UID, flags and the raw source. */
  async messages(path: string): Promise<{ uid: number; flags: string[]; source: Buffer }[]> {
    return this.inFolder(path, async () => {
      const out: { uid: number; flags: string[]; source: Buffer }[] = [];
      // A folder that stays selected does not learn about mail delivered meanwhile; ask.
      await this.client.noop();
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return out;
      for await (const m of this.client.fetch("1:*", { uid: true, flags: true, source: true })) {
        out.push({ uid: m.uid, flags: [...(m.flags ?? [])], source: m.source ?? Buffer.alloc(0) });
      }
      return out;
    });
  }

  /** Empties INBOX and deletes every other folder: a clean slate on a reused server. */
  async reset(): Promise<void> {
    const folders = await this.client.list();
    for (const f of folders) {
      if (f.path.toUpperCase() === "INBOX" || f.flags.has("\\Noselect")) continue;
      await this.client.mailboxDelete(f.path).catch(() => {});
    }
    await this.inFolder("INBOX", async () => {
      if (this.client.mailbox && this.client.mailbox.exists > 0) {
        await this.client.messageDelete("1:*");
      }
    });
  }
}
