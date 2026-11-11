import type { ImageRule } from "@matters/core";
import type { ImagesApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * The image rule writes as the router serves them: each is a command to the sync worker, and
 * once it has committed every window is told (ADR 0037), so an open message decides again.
 */
export class RemoteImageRules implements ImagesApi {
  private readonly host: SyncHost;
  private readonly onChanged: () => void;

  constructor(host: SyncHost, onChanged: () => void) {
    this.host = host;
    this.onChanged = onChanged;
  }

  async setRule(input: Parameters<ImagesApi["setRule"]>[0]): Promise<ImageRule> {
    const rule = await this.host.command({ name: "setImageRule", ...input });
    this.onChanged();
    return rule;
  }

  async removeRule(scope: ImageRule["scope"], value: string): Promise<boolean> {
    const removed = await this.host.command({ name: "removeImageRule", scope, value });
    if (removed) this.onChanged();
    return removed;
  }

  async stop(input: Parameters<ImagesApi["stop"]>[0]): Promise<void> {
    await this.host.command({ name: "stopImages", ...input });
    this.onChanged();
  }

  async setGeneral(general: Parameters<ImagesApi["setGeneral"]>[0]): Promise<void> {
    await this.host.command({ name: "setGeneralImages", general });
    this.onChanged();
  }

  async importAddresses(addresses: readonly string[]): Promise<number> {
    const added = await this.host.command({ name: "importImageAddresses", addresses });
    if (added > 0) this.onChanged();
    return added;
  }
}
