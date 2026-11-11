import type { SetSeenResult } from "@matters/core";
import type { SeenApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * Marking read and unread as the router serves it: a command to the sync worker, which writes the
 * flag and the request for the server in one unit (ADR 0039). The router tells the windows through
 * the change log, like any other write.
 */
export class RemoteSeen implements SeenApi {
  private readonly host: SyncHost;

  constructor(host: SyncHost) {
    this.host = host;
  }

  setSeen(keys: readonly number[], seen: boolean): Promise<SetSeenResult> {
    return this.host.command({ name: "setSeen", keys, seen });
  }
}
