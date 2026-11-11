import { InvalidViewError, ViewNotFoundError } from "../domain/errors.ts";
import { foldText } from "../domain/text.ts";
import {
  MAX_VIEW_NAME,
  MAX_VIEW_QUERY,
  MAX_VIEWS,
  NEEDS_YOU_VIEW,
  type SavedView,
} from "../domain/views.ts";
import type { SavedViewStorePort } from "../ports/index.ts";

export interface ViewDeps {
  readonly views: SavedViewStorePort;
  newId(): string;
  now(): number;
}

/** Why a view cannot have this query text, or null when it can (ADR 0027). */
export function viewQueryProblem(query: string): string | null {
  if (query.trim() === "") return "A view needs a query.";
  if (query.length > MAX_VIEW_QUERY)
    return `A query can have at most ${MAX_VIEW_QUERY} characters.`;
  return null;
}

/**
 * Why a view cannot have this name beside `others`, or null when it can (ADR 0027): 1 to 40
 * characters once trimmed, unique ignoring case. Shared with the views the agent proposes (ADR 0102).
 */
export function viewNameProblem(
  name: string,
  others: readonly Pick<SavedView, "name">[],
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the view a name.";
  if (trimmed.length > MAX_VIEW_NAME) return `A name can have at most ${MAX_VIEW_NAME} characters.`;
  const folded = foldText(trimmed);
  if (others.some((v) => foldText(v.name) === folded)) {
    return `A view named "${trimmed}" already exists.`;
  }
  return null;
}

function checkQuery(query: string): void {
  const problem = viewQueryProblem(query);
  if (problem !== null) throw new InvalidViewError(problem);
}

/** The trimmed name, or an `InvalidViewError` saying why not (ADR 0027). */
function checkName(name: string, others: readonly SavedView[]): string {
  const problem = viewNameProblem(name, others);
  if (problem !== null) throw new InvalidViewError(problem);
  return name.trim();
}

async function find(deps: ViewDeps, id: string): Promise<SavedView> {
  const view = await deps.views.get(id);
  if (!view) throw new ViewNotFoundError();
  return view;
}

export async function createView(
  deps: ViewDeps,
  input: { name: string; query: string },
): Promise<SavedView> {
  const all = await deps.views.list();
  if (all.length >= MAX_VIEWS) {
    throw new InvalidViewError(`You can have at most ${MAX_VIEWS} views.`);
  }
  const name = checkName(input.name, all);
  checkQuery(input.query);
  const now = deps.now();
  const view: SavedView = {
    id: deps.newId(),
    name,
    query: input.query,
    position: all.reduce((max, v) => Math.max(max, v.position), -1) + 1,
    createdMs: now,
    updatedMs: now,
  };
  await deps.views.put(view);
  return view;
}

export async function updateViewQuery(
  deps: ViewDeps,
  id: string,
  query: string,
): Promise<SavedView> {
  const view = await find(deps, id);
  checkQuery(query);
  const next = { ...view, query, updatedMs: deps.now() };
  await deps.views.put(next);
  return next;
}

export async function renameView(deps: ViewDeps, id: string, name: string): Promise<SavedView> {
  const view = await find(deps, id);
  const others = (await deps.views.list()).filter((v) => v.id !== id);
  const next = { ...view, name: checkName(name, others), updatedMs: deps.now() };
  await deps.views.put(next);
  return next;
}

/** Returns whether the view existed. */
export function deleteView(deps: ViewDeps, id: string): Promise<boolean> {
  return deps.views.remove(id);
}

/** Puts the view at `toIndex` of the tab order (clamped); the others keep their order. */
export async function moveView(deps: ViewDeps, id: string, toIndex: number): Promise<void> {
  const ids = (await deps.views.list()).map((v) => v.id);
  const from = ids.indexOf(id);
  if (from < 0) throw new ViewNotFoundError();
  ids.splice(from, 1);
  ids.splice(Math.min(Math.max(Math.trunc(toIndex), 0), ids.length), 0, id);
  await deps.views.setPositions(ids);
}

/** ADR 0030. Blank or oversized text is not worth remembering, and is not an error. */
export async function noteSearch(deps: ViewDeps, viewId: string, query: string): Promise<void> {
  const text = query.trim();
  if (text === "" || text.length > MAX_VIEW_QUERY) return;
  await deps.views.noteSearch(viewId, text, deps.now());
}

export function forgetSearch(deps: ViewDeps, viewId: string, query: string): Promise<void> {
  return deps.views.forgetSearch(viewId, query.trim());
}

export function clearSearches(deps: ViewDeps, viewId: string): Promise<void> {
  return deps.views.clearSearches(viewId);
}

/**
 * ADR 0117, rule 2: puts `Needs you` in front of the other views, the tabs that exist moving down
 * by one. `full`: the list holds `MAX_VIEWS` and nothing is added (it may be added later).
 * `taken`: a view of that name, or with that id, exists; nothing is added. Whether it is ever
 * tried again is the caller's record, not the list's: a deleted view stays deleted.
 */
export async function addNeedsYouView(deps: {
  readonly views: Pick<SavedViewStorePort, "list" | "put" | "setPositions">;
  now(): number;
}): Promise<"added" | "full" | "taken"> {
  const all = await deps.views.list();
  if (all.length >= MAX_VIEWS) return "full";
  if (
    all.some((v) => v.id === NEEDS_YOU_VIEW.id) ||
    viewNameProblem(NEEDS_YOU_VIEW.name, all) !== null
  ) {
    return "taken";
  }
  const now = deps.now();
  const first = all.reduce((min, v) => Math.min(min, v.position), 0) - 1;
  await deps.views.put({
    id: NEEDS_YOU_VIEW.id,
    name: NEEDS_YOU_VIEW.name,
    query: NEEDS_YOU_VIEW.query,
    position: first,
    createdMs: now,
    updatedMs: now,
  });
  await deps.views.setPositions([NEEDS_YOU_VIEW.id, ...all.map((v) => v.id)]);
  return "added";
}
