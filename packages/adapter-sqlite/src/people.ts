import { tokenize } from "@matters/core";
import type { Database } from "./database.ts";

/** ADR 0028. Words kept per person: name first, then address. */
export const MAX_PERSON_WORDS = 16;

export function personAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** The folded words a person is found by, at most `MAX_PERSON_WORDS`, each once. */
export function personWords(name: string | undefined, address: string): string[] {
  return [...new Set(tokenize(`${name ?? ""} ${address}`))].slice(0, MAX_PERSON_WORDS);
}

interface Seen {
  name: string | null;
  /** Date of the newest message that gave `name`. */
  nameMs: number;
  count: number;
  lastMs: number;
}

/** Aggregates participants message by message; an address counts once per message. */
export class PeopleTally {
  readonly byAddress = new Map<string, Seen>();

  add(
    dateMs: number,
    participants: readonly { name?: string | undefined; address: string }[],
  ): void {
    const inThis = new Set<string>();
    for (const p of participants) {
      const address = personAddress(p.address);
      if (address === "") continue;
      const name = p.name?.trim() || null;
      let seen = this.byAddress.get(address);
      if (seen === undefined) {
        seen = { name: null, nameMs: Number.NEGATIVE_INFINITY, count: 0, lastMs: dateMs };
        this.byAddress.set(address, seen);
      }
      if (!inThis.has(address)) {
        inThis.add(address);
        seen.count++;
      }
      if (dateMs > seen.lastMs) seen.lastMs = dateMs;
      if (name !== null && dateMs >= seen.nameMs) {
        seen.name = name;
        seen.nameMs = dateMs;
      }
    }
  }
}

export interface PeopleWriter {
  /** Folds a tally into the tables; call inside the write transaction. */
  apply(tally: PeopleTally): void;
}

/** Statements for the write side, shared by the indexer and the backfill. */
export function peopleWriter(db: Database): PeopleWriter {
  const read = db.prepare("SELECT name, count, last_ms FROM people WHERE address = ?");
  const put = db.prepare(
    "INSERT OR REPLACE INTO people (address, name, count, last_ms) VALUES (?, ?, ?, ?)",
  );
  const word = db.prepare("INSERT OR IGNORE INTO people_words (word, address) VALUES (?, ?)");
  return {
    apply(tally) {
      for (const [address, seen] of tally.byAddress) {
        const old = read.get(address) as
          | { name: string | null; count: number; last_ms: number }
          | undefined;
        // The name of the newest message that has one; an older message never beats a name
        // held for the newest message the table has seen.
        const renamed =
          seen.name !== null && (old?.name == null || seen.nameMs >= old.last_ms)
            ? seen.name
            : null;
        const name = renamed ?? old?.name ?? null;
        put.run(
          address,
          name,
          (old?.count ?? 0) + seen.count,
          Math.max(old?.last_ms ?? seen.lastMs, seen.lastMs),
        );
        if (old === undefined || name !== old.name) {
          for (const w of personWords(name ?? undefined, address)) word.run(w, address);
        }
      }
    },
  };
}
