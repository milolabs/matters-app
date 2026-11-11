import type { SavedView, ViewDeps } from "@matters/core";
import {
  clearSearches,
  createView,
  deleteView,
  forgetSearch,
  moveView,
  noteSearch,
  renameView,
  updateViewQuery,
} from "@matters/core";
import type { ViewsApi } from "./handler.ts";

/** The view requests of the renderer over the core use cases. Runs in the sync worker (it writes). */
export class ViewService implements ViewsApi {
  private readonly deps: ViewDeps;

  constructor(deps: ViewDeps) {
    this.deps = deps;
  }

  create(input: { name: string; query: string }): Promise<SavedView> {
    return createView(this.deps, input);
  }

  updateQuery(id: string, query: string): Promise<SavedView> {
    return updateViewQuery(this.deps, id, query);
  }

  rename(id: string, name: string): Promise<SavedView> {
    return renameView(this.deps, id, name);
  }

  remove(id: string): Promise<boolean> {
    return deleteView(this.deps, id);
  }

  async move(id: string, toIndex: number): Promise<void> {
    await moveView(this.deps, id, toIndex);
  }

  noteSearch(viewId: string, query: string): Promise<void> {
    return noteSearch(this.deps, viewId, query);
  }

  forgetSearch(viewId: string, query: string): Promise<void> {
    return forgetSearch(this.deps, viewId, query);
  }

  clearSearches(viewId: string): Promise<void> {
    return clearSearches(this.deps, viewId);
  }
}
