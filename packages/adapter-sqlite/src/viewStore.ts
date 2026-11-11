import { MAX_RECENT_SEARCHES, type SavedView, type SavedViewStorePort } from "@matters/core";
import { type Database, exclusive, write } from "./database.ts";

interface Row {
  id: string;
  name: string;
  query: string;
  position: number;
  created_ms: number;
  updated_ms: number;
}

function toView(row: Row): SavedView {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    position: row.position,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
  };
}

export class SqliteSavedViewStore implements SavedViewStorePort {
  private readonly db: Database;
  private readonly selectOne;
  private readonly selectAll;
  private readonly upsert;
  private readonly remove_;
  private readonly setPosition;
  private readonly selectSearches;
  private readonly upsertSearch;
  private readonly pruneSearches;
  private readonly removeSearch;
  private readonly removeSearches;

  constructor(db: Database) {
    this.db = db;
    this.selectOne = db.prepare("SELECT * FROM saved_views WHERE id = ?");
    this.selectAll = db.prepare("SELECT * FROM saved_views ORDER BY position, created_ms, id");
    this.upsert = db.prepare(`
      INSERT INTO saved_views (id, name, query, position, created_ms, updated_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, query = excluded.query,
        position = excluded.position, created_ms = excluded.created_ms,
        updated_ms = excluded.updated_ms`);
    this.remove_ = db.prepare("DELETE FROM saved_views WHERE id = ?");
    this.setPosition = db.prepare("UPDATE saved_views SET position = ? WHERE id = ?");
    this.selectSearches = db.prepare(
      "SELECT query FROM view_searches WHERE view_id = ? ORDER BY last_ms DESC, query LIMIT ?",
    );
    this.upsertSearch = db.prepare(`
      INSERT INTO view_searches (view_id, query, last_ms) VALUES (?, ?, ?)
      ON CONFLICT (view_id, query) DO UPDATE SET last_ms = excluded.last_ms`);
    this.pruneSearches = db.prepare(`
      DELETE FROM view_searches WHERE view_id = ?1 AND query NOT IN (
        SELECT query FROM view_searches WHERE view_id = ?1
        ORDER BY last_ms DESC, query LIMIT ?2)`);
    this.removeSearch = db.prepare("DELETE FROM view_searches WHERE view_id = ? AND query = ?");
    this.removeSearches = db.prepare("DELETE FROM view_searches WHERE view_id = ?");
  }

  async list(): Promise<readonly SavedView[]> {
    return (this.selectAll.all() as unknown as Row[]).map(toView);
  }

  async get(id: string): Promise<SavedView | null> {
    const row = this.selectOne.get(id) as Row | undefined;
    return row ? toView(row) : null;
  }

  async put(view: SavedView): Promise<void> {
    await exclusive(this.db, () => {
      this.upsert.run(
        view.id,
        view.name,
        view.query,
        view.position,
        view.createdMs,
        view.updatedMs,
      );
    });
  }

  async remove(id: string): Promise<boolean> {
    let changes = 0;
    await write(this.db, () => {
      changes = Number(this.remove_.run(id).changes);
      this.removeSearches.run(id);
    });
    return changes > 0;
  }

  async recentSearches(viewId: string): Promise<readonly string[]> {
    const rows = this.selectSearches.all(viewId, MAX_RECENT_SEARCHES) as unknown as {
      query: string;
    }[];
    return rows.map((r) => r.query);
  }

  async noteSearch(viewId: string, query: string, atMs: number): Promise<void> {
    await write(this.db, () => {
      this.upsertSearch.run(viewId, query, atMs);
      this.pruneSearches.run(viewId, MAX_RECENT_SEARCHES);
    });
  }

  async forgetSearch(viewId: string, query: string): Promise<void> {
    await exclusive(this.db, () => this.removeSearch.run(viewId, query));
  }

  async clearSearches(viewId: string): Promise<void> {
    await exclusive(this.db, () => this.removeSearches.run(viewId));
  }

  async setPositions(ids: readonly string[]): Promise<void> {
    // One transaction: a failure leaves the old order.
    await write(this.db, () => {
      ids.forEach((id, position) => {
        this.setPosition.run(position, id);
      });
    });
  }
}
