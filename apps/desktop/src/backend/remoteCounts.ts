import type { CountApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * Badge counts as the router serves them: a command to the sync worker, so the count runs on
 * the worker's thread. While the worker is down the command rejects at once (`SyncHost`), and
 * the renderer shows no badge.
 */
export class RemoteCounts implements CountApi {
  private readonly host: SyncHost;

  constructor(host: SyncHost) {
    this.host = host;
  }

  count(query: string, cap: number, beforeKey?: number) {
    return this.host.command({
      name: "countMatches",
      query,
      cap,
      ...(beforeKey === undefined ? {} : { beforeKey }),
    });
  }

  /** ADR 0116, rule 4b: a ranked order, computed on the worker's thread. */
  rank(query: string) {
    return this.host.command({ name: "sortRanked", query });
  }
}
