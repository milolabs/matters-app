import { tokenize } from "../domain/text.ts";
import type { AccountStorePort, PeoplePort, PersonSuggestion } from "../ports/index.ts";

export interface SuggestPeopleDeps {
  readonly people: PeoplePort;
  /** The user's own addresses are left out: `me` covers them. */
  readonly accounts: Pick<AccountStorePort, "list">;
}

export const MAX_PEOPLE = 20;

/**
 * People whose name or address starts with `input` (ADR 0028). Blank input gives the most
 * frequent people (ADR 0029); input with only other characters gives nothing. The port is asked for enough extra to still fill `limit`
 * after the user's own addresses are dropped.
 */
export async function suggestPeople(
  deps: SuggestPeopleDeps,
  input: string,
  limit: number,
): Promise<readonly PersonSuggestion[]> {
  const words = tokenize(input);
  const want = Math.min(Math.max(Math.trunc(limit) || 0, 0), MAX_PEOPLE);
  const blank = input.trim() === "";
  if ((words.length === 0 && !blank) || want === 0) return [];
  const own = new Set((await deps.accounts.list()).map((a) => a.address.trim().toLowerCase()));
  const found = blank
    ? await deps.people.frequent(want + own.size)
    : await deps.people.suggest(words.join(" "), want + own.size);
  return found.filter((p) => !own.has(p.address)).slice(0, want);
}
