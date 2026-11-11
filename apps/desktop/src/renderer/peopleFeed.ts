import type { PersonSuggestion } from "@matters/core";
import type { Backend } from "./client.ts";
import { PEOPLE_IN_VALUE } from "./querySuggestions.ts";

/**
 * Asks the backend for people (ADR 0028), one request at a time that counts: the answer to
 * an older request is dropped once a newer one was made, or the feed was stopped. A failed
 * request is ignored: the panel simply has no people.
 */
export function createPeopleFeed(
  backend: Pick<Backend, "suggestPeople">,
  onAnswer: (people: readonly PersonSuggestion[]) => void,
) {
  let latest = 0;
  return {
    ask(prefix: string): void {
      const mine = ++latest;
      backend.suggestPeople(prefix, PEOPLE_IN_VALUE).then(
        (people) => {
          if (mine === latest) onAnswer(people);
        },
        () => {},
      );
    },
    /** Nothing in flight counts any more. */
    stop(): void {
      latest++;
    },
  };
}
