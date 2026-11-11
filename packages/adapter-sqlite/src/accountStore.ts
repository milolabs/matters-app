import type { AccountStorePort, StoredAccount, TransportSecurity } from "@matters/core";
import { AccountExistsError } from "@matters/core";
import { type Database, exclusive, write } from "./database.ts";

interface AccountRow {
  id: string;
  address: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  imap_security: string;
  imap_username: string;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
  smtp_username: string | null;
  max_message_bytes: number | null;
  created_at_ms: number;
}

const SELECT = "SELECT * FROM accounts";

function toAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    address: row.address,
    displayName: row.display_name,
    imap: {
      host: row.imap_host,
      port: row.imap_port,
      security: row.imap_security as TransportSecurity,
      username: row.imap_username,
    },
    ...(row.smtp_host !== null && row.smtp_port !== null
      ? {
          smtp: {
            host: row.smtp_host,
            port: row.smtp_port,
            security: (row.smtp_security ?? "starttls") as TransportSecurity,
            username: row.smtp_username ?? "",
          },
        }
      : {}),
    ...(row.max_message_bytes === null ? {} : { messageLimitBytes: row.max_message_bytes }),
    createdAtMs: row.created_at_ms,
  };
}

export class SqliteAccountStore implements AccountStorePort {
  private readonly db: Database;
  private readonly selectAll;
  private readonly selectOne;
  private readonly insert;
  private readonly delete;
  private readonly setLimit;

  constructor(db: Database) {
    this.db = db;
    this.selectAll = db.prepare(`${SELECT} ORDER BY created_at_ms, id`);
    this.selectOne = db.prepare(`${SELECT} WHERE id = ?`);
    this.insert = db.prepare(`
      INSERT INTO accounts (id, address, display_name, imap_host, imap_port, imap_security,
                            imap_username, smtp_host, smtp_port, smtp_security, smtp_username,
                            max_message_bytes, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.delete = db.prepare("DELETE FROM accounts WHERE id = ?");
    this.setLimit = db.prepare("UPDATE accounts SET max_message_bytes = ? WHERE id = ?");
  }

  async list(): Promise<readonly StoredAccount[]> {
    return (this.selectAll.all() as unknown as AccountRow[]).map(toAccount);
  }

  async get(id: string): Promise<StoredAccount | null> {
    const row = this.selectOne.get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  async add(account: StoredAccount): Promise<void> {
    await write(this.db, () => {
      try {
        this.insert.run(
          account.id,
          account.address,
          account.displayName,
          account.imap.host,
          account.imap.port,
          account.imap.security,
          account.imap.username,
          account.smtp?.host ?? null,
          account.smtp?.port ?? null,
          account.smtp?.security ?? null,
          account.smtp?.username ?? null,
          account.messageLimitBytes ?? null,
          account.createdAtMs,
        );
      } catch (error) {
        if (/UNIQUE constraint failed/.test(String((error as Error).message))) {
          throw new AccountExistsError(account.address);
        }
        throw error;
      }
    });
  }

  async remove(id: string): Promise<boolean> {
    return write(this.db, () => Number(this.delete.run(id).changes) > 0);
  }

  async setMessageLimit(accountId: string, bytes: number | null): Promise<void> {
    await exclusive(this.db, () => {
      this.setLimit.run(bytes, accountId);
    });
  }
}
