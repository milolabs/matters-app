import type { MailWatch, MailWatchHandlers } from "@matters/core";
import { type ImapConnectionOptions, openConnection } from "./connection.ts";
import { ImapConnectionError, safeError } from "./errors.ts";

/** IDLE is restarted this often: it proves the connection is alive and beats NAT timeouts. */
const IDLE_RESTART_MS = 4 * 60_000;

const secretsOf = (options: ImapConnectionOptions): string[] =>
  "pass" in options.auth ? [options.auth.pass] : [options.auth.accessToken];

/**
 * Opens a dedicated connection, selects INBOX read-only and waits there in IDLE (RFC 2177).
 * New, changed and expunged mail calls `onChange`; the connection ending on its own calls
 * `onClosed` once. Sync never shares this connection: a command would end the IDLE.
 */
export async function watchInbox(
  options: ImapConnectionOptions,
  handlers: MailWatchHandlers,
): Promise<MailWatch> {
  const { client } = await openConnection({ ...options, maxIdleTime: IDLE_RESTART_MS });
  let closing = false;
  let ended = false;
  const secrets = secretsOf(options);

  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    if (!closing) handlers.onClosed(error === undefined ? undefined : safeError(error, secrets));
  };
  const changed = () => {
    if (!closing && !ended) handlers.onChange();
  };
  client.on("exists", changed);
  client.on("expunge", changed);
  client.on("flags", changed);
  client.on("close", () => end());
  client.on("error", (error: unknown) => end(error));

  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch (error) {
    ended = true;
    client.close();
    throw safeError(error, secrets);
  }

  void (async () => {
    while (!closing && !ended) {
      try {
        // Returns when IDLE ended: restart timer, server BYE, or a command; false when IDLE failed.
        if ((await client.idle()) === false) {
          end(new ImapConnectionError("The server stopped the IDLE command"));
        }
      } catch (error) {
        end(error);
      }
    }
  })();

  return {
    async close() {
      closing = true;
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}
