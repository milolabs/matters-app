import type { SavedView } from "@matters/core";
import type { ViewsApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * The view writes as the router serves them: each is a command to the sync worker (ADR 0019,
 * 0027). The router reads the list itself, on the reader connection.
 */
export class RemoteViews implements ViewsApi {
  private readonly host: SyncHost;

  constructor(host: SyncHost) {
    this.host = host;
  }

  create(input: { name: string; query: string }): Promise<SavedView> {
    return this.host.command({ name: "createView", viewName: input.name, query: input.query });
  }

  updateQuery(id: string, query: string): Promise<SavedView> {
    return this.host.command({ name: "updateViewQuery", id, query });
  }

  rename(id: string, name: string): Promise<SavedView> {
    return this.host.command({ name: "renameView", id, viewName: name });
  }

  remove(id: string): Promise<boolean> {
    return this.host.command({ name: "deleteView", id });
  }

  async move(id: string, toIndex: number): Promise<void> {
    await this.host.command({ name: "moveView", id, toIndex });
  }

  async noteSearch(viewId: string, query: string): Promise<void> {
    await this.host.command({ name: "noteSearch", viewId, query });
  }

  async forgetSearch(viewId: string, query: string): Promise<void> {
    await this.host.command({ name: "forgetSearch", viewId, query });
  }

  async clearSearches(viewId: string): Promise<void> {
    await this.host.command({ name: "clearSearches", viewId });
  }
}
