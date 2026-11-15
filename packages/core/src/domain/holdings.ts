// What Matters keeps on a computer, declared in one list (ADR 0138, rule 2). Each holding says the
// group the review shows it under, where it is and in which step of an erase it goes. Adapters
// declare their own; the composition root puts the lists together. A store that is not declared
// breaks the "nothing undeclared" tests, which is the point.

/** The groups of the review screen, in the order it lists them (ADR 0138, rule 2). */
export const HOLDING_GROUPS = ["signIns", "mail", "files", "agents", "settings", "caches"] as const;
export type HoldingGroup = (typeof HOLDING_GROUPS)[number];

/**
 * The steps of an erase, in their order (ADR 0138, rule 3): credentials and the Keychain key
 * first, then the database files, attachments and files, settings, caches and Chromium's storage,
 * temp folders, the earlier copy if asked. The order file goes last, after all of them: while it
 * exists, every start continues the erase.
 */
export const ERASE_STEPS = [
  "signIns",
  "database",
  "files",
  "settings",
  "caches",
  "temp",
  "earlier",
  "order",
] as const;
export type EraseStep = (typeof ERASE_STEPS)[number];

/** Whose rows a table holds, for removing one account (ADR 0138, rule 5). */
export type TableScope =
  /** Rows belong to one account: the account's are discarded with it. */
  | "account"
  /** Built from mail: what no longer has mail to support it is pruned. */
  | "derived"
  /** The person's, across accounts (views, settings, themes): it stays. */
  | "shared";

export type HoldingPlace =
  /** An entry directly under the data folder, by its exact name or a name prefix. */
  | { readonly kind: "data"; readonly name: string; readonly match: "exact" | "prefix" }
  /**
   * The database file and the files named after it (`-wal`, `-shm`, `.owner`), wherever the
   * database lies (`MATTERS_DB_PATH` may point away from the data folder).
   */
  | { readonly kind: "database"; readonly suffix: string }
  /** A file in the database's folder that is not named after it. */
  | { readonly kind: "besideDatabase"; readonly name: string }
  /** Folders in the system's temp directory, by name prefix. */
  | { readonly kind: "temp"; readonly prefix: string }
  /** A key in the system's key store: this identity's, or the earlier identity's (ADR 0105). */
  | { readonly kind: "keychain"; readonly which: "current" | "earlier" }
  /** The folder of the earlier identity (ADR 0105), whole. */
  | { readonly kind: "earlierFolder" }
  /** A table inside the database. Erased with the database file; removing an account reads it. */
  | { readonly kind: "table"; readonly table: string; readonly scope: TableScope };

export interface Holding {
  /** Unique across all lists, e.g. `secrets.vault`, `sqlite.messages`. */
  readonly id: string;
  readonly group: HoldingGroup;
  readonly place: HoldingPlace;
  readonly step: EraseStep;
}

/** Puts the adapters' lists together; an id declared twice is a programming error. */
export function holdingsOf(...lists: readonly (readonly Holding[])[]): readonly Holding[] {
  const all = lists.flat();
  const seen = new Set<string>();
  for (const h of all) {
    if (seen.has(h.id)) throw new Error(`holding ${h.id} is declared twice`);
    seen.add(h.id);
  }
  return all;
}

/** The holding that owns an entry directly under the data folder, or null: undeclared. */
export function holdingForDataEntry(
  holdings: readonly Holding[],
  name: string,
  databaseFile: string | null,
): Holding | null {
  for (const h of holdings) {
    const p = h.place;
    if (p.kind === "data" && (p.match === "exact" ? name === p.name : name.startsWith(p.name))) {
      return h;
    }
    // The database lies in the data folder in a normal run.
    if (databaseFile !== null && p.kind === "database" && name === databaseFile + p.suffix)
      return h;
    if (databaseFile !== null && p.kind === "besideDatabase" && name === p.name) return h;
  }
  return null;
}

/** The entries of a data folder that belong to no holding. */
export function undeclaredEntries(
  holdings: readonly Holding[],
  names: readonly string[],
  databaseFile: string | null,
): readonly string[] {
  return names.filter((n) => holdingForDataEntry(holdings, n, databaseFile) === null);
}

/** The tables of a database that belong to no holding. */
export function undeclaredTables(
  holdings: readonly Holding[],
  tables: readonly string[],
): readonly string[] {
  const declared = new Set(
    holdings.flatMap((h) => (h.place.kind === "table" ? [h.place.table] : [])),
  );
  return tables.filter((t) => !declared.has(t));
}

export interface ErasePlanStep {
  readonly step: EraseStep;
  /** Holdings with a place outside the database's tables; tables go with the database file. */
  readonly holdings: readonly Holding[];
}

/**
 * The erase, step by step (ADR 0138, rule 3). Tables are not listed: they go with the database
 * file. The earlier identity's folder and key are in only when the person asked (rule 4).
 */
export function erasePlan(
  holdings: readonly Holding[],
  options: { readonly earlierCopy: boolean },
): readonly ErasePlanStep[] {
  const isEarlier = (h: Holding) =>
    h.place.kind === "earlierFolder" ||
    (h.place.kind === "keychain" && h.place.which === "earlier");
  return ERASE_STEPS.flatMap((step) => {
    if (step === "earlier" && !options.earlierCopy) return [];
    const inStep = holdings.filter(
      (h) =>
        h.place.kind !== "table" &&
        (step === "earlier" ? isEarlier(h) : h.step === step && !isEarlier(h)),
    );
    return inStep.length === 0 ? [] : [{ step, holdings: inStep }];
  });
}

/** What became of one holding in an erase. */
export type HoldingOutcome =
  | { readonly kind: "gone"; readonly bytes: number }
  /** Not there to begin with (nothing to erase). */
  | { readonly kind: "absent" }
  /** Still there; `reason` says why in plain words, `where` is a path to show (or null). */
  | {
      readonly kind: "left";
      readonly reason: LeftReason;
      readonly bytes: number;
      readonly where: string | null;
    };

export type LeftReason =
  /** Another program has it open, or the system said it is busy. */
  | "busy"
  /** Another copy of Matters owns the database (its owner file, ADR 0110); it was not touched. */
  | "inUse"
  /** The system refused (permissions, a locked file). */
  | "refused"
  /** The key store refused to delete the key. */
  | "keychainRefused"
  /** There is no key to delete on this system, or no way to delete it from here. */
  | "keychainUnsupported"
  /** The path lay outside what the erase may touch; nothing was deleted there. */
  | "outsideReach"
  /** Something else went wrong. */
  | "failed";

export interface EraseResult {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly earlierCopy: boolean;
  readonly outcomes: readonly { readonly holding: Holding; readonly outcome: HoldingOutcome }[];
}

/** Bytes erased in all, and whether anything was left. */
export function eraseSummary(result: EraseResult): {
  readonly bytes: number;
  readonly left: readonly { readonly holding: Holding; readonly outcome: HoldingOutcome }[];
} {
  let bytes = 0;
  const left: { holding: Holding; outcome: HoldingOutcome }[] = [];
  for (const o of result.outcomes) {
    if (o.outcome.kind === "gone") bytes += o.outcome.bytes;
    if (o.outcome.kind === "left") left.push(o);
  }
  return { bytes, left };
}
