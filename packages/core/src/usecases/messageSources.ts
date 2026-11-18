import { mailErrorKind } from "../domain/errors.ts";
import type { MailConnection, MessageStorePort, SourceFilesPort } from "../ports/index.ts";

/** What saving a source needs of a connection: the fetcher, and the way to let go of it. */
export type SourceConnection = Pick<MailConnection, "attachments" | "close">;

/**
 * How saving one letter as a file ended (ADR 0145, rule 3). As for a received file (ADR 0043,
 * rule 9): `gone` is definite, `offline` is for later. `signIn`: the account has no usable
 * password or sign-in. `exists`: a file of that name appeared where nothing may be replaced.
 * `failed`: anything else; `message` is for the log, not for the person.
 */
export type SaveSourceOutcome =
  | { readonly kind: "saved"; readonly bytes: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "gone" }
  | { readonly kind: "offline"; readonly message: string }
  | { readonly kind: "signIn"; readonly message: string }
  | { readonly kind: "exists" }
  | { readonly kind: "failed"; readonly message: string };

export interface MessageSourcesDeps {
  readonly store: Pick<MessageStorePort, "getLocations">;
  readonly files: SourceFilesPort;
  /**
   * A connection of its own to the account's server, as a received file's download has (ADR
   * 0043, rule 6): a long save never holds up sync. Null when the account is gone. Failures carry
   * a `kind`, as `connect` does.
   */
  open(accountId: string): Promise<SourceConnection | null>;
}

export interface SourceWatch {
  readonly signal?: AbortSignal;
  /** Bytes written so far and what the server said the whole is (0 when it did not say). */
  readonly onBytes?: (bytes: number, total: number) => void;
}

/**
 * Saves a message as the server has it, to a place the person chose (ADR 0145, rules 2, 3 and 5).
 * Every folder the message is in holds the same message; the first that still has it will do.
 * Nothing here touches a database write: the bytes go from the connection to the file.
 */
export class MessageSources {
  private readonly deps: MessageSourcesDeps;

  constructor(deps: MessageSourcesDeps) {
    this.deps = deps;
  }

  async save(
    messageKey: number,
    target: string,
    overwrite: boolean,
    watch: SourceWatch = {},
  ): Promise<SaveSourceOutcome> {
    const { signal } = watch;
    if (signal?.aborted) return { kind: "cancelled" };
    try {
      const locations = await this.deps.store.getLocations(messageKey);
      const accountId = locations[0]?.accountId;
      // A letter with no place on a server (none was ever there, or all copies went) has no source.
      if (accountId === undefined) return { kind: "gone" };
      const connection = await this.deps.open(accountId);
      if (!connection) return { kind: "gone" };
      try {
        for (const location of locations) {
          signal?.throwIfAborted();
          const found = await connection.attachments.source(location, signal);
          if (found.kind === "gone") continue;
          const total = found.size ?? 0;
          const bytes = await this.deps.files.write(
            target,
            overwrite,
            found.content,
            (written) => watch.onBytes?.(written, Math.max(total, written)),
            signal,
          );
          return { kind: "saved", bytes };
        }
        return { kind: "gone" };
      } finally {
        await connection.close().catch(() => {});
      }
    } catch (error) {
      if (signal?.aborted) return { kind: "cancelled" };
      if ((error as { code?: unknown } | null)?.code === "EEXIST") return { kind: "exists" };
      const kind = mailErrorKind(error);
      const message = error instanceof Error ? error.message : "The message could not be saved";
      if (kind === "unreachable" || kind === "tls") return { kind: "offline", message };
      if (kind === "auth" || kind === "credentials") return { kind: "signIn", message };
      return { kind: "failed", message };
    }
  }
}
