import { MAX_RECENT_SEARCHES, type SavedView, type SavedViewStorePort } from "@matters/core";

export class InMemorySavedViewStore implements SavedViewStorePort {
  private views = new Map<string, SavedView>();
  private searches = new Map<string, Map<string, number>>();

  async list(): Promise<readonly SavedView[]> {
    return [...this.views.values()].sort(
      (a, b) =>
        a.position - b.position ||
        a.createdMs - b.createdMs ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  async get(id: string): Promise<SavedView | null> {
    return this.views.get(id) ?? null;
  }

  async put(view: SavedView): Promise<void> {
    this.views.set(view.id, view);
  }

  async remove(id: string): Promise<boolean> {
    this.searches.delete(id);
    return this.views.delete(id);
  }

  async recentSearches(viewId: string): Promise<readonly string[]> {
    return [...(this.searches.get(viewId) ?? [])]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_RECENT_SEARCHES)
      .map(([query]) => query);
  }

  async noteSearch(viewId: string, query: string, atMs: number): Promise<void> {
    const mine = this.searches.get(viewId) ?? new Map<string, number>();
    mine.set(query, atMs);
    this.searches.set(viewId, mine);
    const keep = new Set(await this.recentSearches(viewId));
    for (const q of mine.keys()) if (!keep.has(q)) mine.delete(q);
  }

  async forgetSearch(viewId: string, query: string): Promise<void> {
    this.searches.get(viewId)?.delete(query);
  }

  async clearSearches(viewId: string): Promise<void> {
    this.searches.delete(viewId);
  }

  async setPositions(ids: readonly string[]): Promise<void> {
    ids.forEach((id, position) => {
      const view = this.views.get(id);
      if (view) this.views.set(id, { ...view, position });
    });
  }
}
