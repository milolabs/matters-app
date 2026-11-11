/** A name and query text (ADR 0027). The text is kept as typed; the grammar can change. */
export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  /** Ascending order of the tabs; gaps are allowed. */
  readonly position: number;
  readonly createdMs: number;
  readonly updatedMs: number;
}

export const MAX_VIEW_NAME = 40;
export const MAX_VIEW_QUERY = 1024;
export const MAX_VIEWS = 50;
/** Searches remembered per view (ADR 0030). */
export const MAX_RECENT_SEARCHES = 10;
