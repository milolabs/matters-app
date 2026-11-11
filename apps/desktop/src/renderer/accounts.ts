import type { AccountInfo } from "@matters/contracts";
import type { SyncStatus } from "@matters/core";
import { batch, createMemo, createSignal } from "solid-js";
import { readAccountColors, watchAccountColors, writeAccountColors } from "./accountColors.ts";
import {
  type AccountColor,
  accountMarks,
  normalizeAccountColor,
  resolveColors,
} from "./accountMarks.ts";
import type { Backend } from "./client.ts";
import { summarize } from "./status.ts";

/** Accounts and their sync state, kept current by the backend's pushes. */
export function createAccountsStore(backend: Backend) {
  const [accounts, setAccounts] = createSignal<readonly AccountInfo[]>([]);
  const [statuses, setStatuses] = createSignal<Readonly<Record<string, SyncStatus>>>({});
  const [loaded, setLoaded] = createSignal(false);
  const [chosenColors, setChosenColors] = createSignal<Readonly<Record<string, AccountColor>>>(
    readAccountColors(),
  );

  // The settings window picks colours; the mail window must show them at once.
  watchAccountColors(() => setChosenColors(readAccountColors()));

  async function refresh() {
    const r = await backend.listAccounts();
    batch(() => {
      setAccounts(r.accounts);
      setStatuses(Object.fromEntries(r.accounts.map((a) => [a.id, a.status])));
      setLoaded(true);
      // A default colour is assigned once and kept; a removed account's entry goes with it.
      const colors = resolveColors(r.accounts, chosenColors());
      setChosenColors(colors);
      writeAccountColors(colors);
    });
  }

  backend.onEvent((event) => {
    if (event.type === "syncStatus")
      setStatuses((s) => ({ ...s, [event.accountId]: event.status }));
    else if (event.type === "accountsChanged") void refresh();
  });

  return {
    accounts,
    statuses,
    /** False until the first answer: the first-run screen must not flash before it. */
    loaded,
    refresh,
    /** The colour of each account, as persisted: a palette id or `#rrggbb`. */
    colors: chosenColors,
    /** The mark of each account: its colour, letter and name (ADR 0033). */
    marks: createMemo(() => accountMarks(accounts(), chosenColors())),
    setColor(id: string, color: AccountColor) {
      const colors = { ...chosenColors(), [id]: normalizeAccountColor(color) };
      setChosenColors(colors);
      writeAccountColors(colors);
    },
    summary: createMemo(() => summarize(accounts(), statuses())),
    statusOf: (id: string): SyncStatus => statuses()[id] ?? { state: "idle" },
    syncNow: (id: string) => backend.syncNow(id),
    async remove(id: string) {
      await backend.removeAccount(id);
      await refresh();
    },
  };
}

export type AccountsStore = ReturnType<typeof createAccountsStore>;
