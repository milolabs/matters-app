import type { FetchOutcome } from "@matters/core";
import type { ReceivedApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/** The router's side of `ReceivedApi`: the download runs in the sync worker, which owns the IMAP side. */
export class RemoteReceived implements ReceivedApi {
  private readonly host: SyncHost;

  constructor(host: SyncHost) {
    this.host = host;
  }

  fetch(messageKey: number, partId: string): Promise<FetchOutcome> {
    return this.host.command({ name: "fetchReceived", messageKey, partId });
  }
}
