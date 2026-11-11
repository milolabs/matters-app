import type { PeoplePort, PersonStats } from "../ports/index.ts";

export interface GetPersonDeps {
  readonly people: PeoplePort;
}

const MAX_ADDRESS = 320;

/**
 * What the mail says of one person (ADR 0078): how many messages name them and when the newest
 * one is. A blank or absurdly long address, or someone the index holds no mail for, gives
 * `undefined`. One indexed read by address.
 */
export async function getPerson(
  deps: GetPersonDeps,
  address: string,
): Promise<PersonStats | undefined> {
  const wanted = address.trim().toLowerCase();
  if (wanted === "" || wanted.length > MAX_ADDRESS) return undefined;
  return deps.people.person(wanted);
}
