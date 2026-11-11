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

/**
 * The view that takes the place of the built-in `Matters` tab (ADR 0117, rule 2): an ordinary
 * saved view with a prompt, added once the first time AI is on with an account that has consent.
 * Its id is stable, so the app can open it at the start and the badge can count it.
 */
export const NEEDS_YOU_VIEW = {
  id: "starter-needs-you",
  name: "Needs you",
  query: 'after:-30d prompt:"mail that needs my reply or decision"',
} as const;
