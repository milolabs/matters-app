import type { Label } from "@matters/core";
import { createSignal } from "solid-js";
import type { Backend } from "./client.ts";

/**
 * The folders sync last listed (ADR 0044, rule 1), for the Move list and for knowing which label
 * names Trash or Spam. Read from the local table, so the list opens in the frame of the key
 * (rule 17); read again when an account changes and when a sync ends.
 */
export function createFoldersStore(backend: Backend) {
  const [folders, setFolders] = createSignal<readonly Label[]>([]);

  async function refresh(): Promise<void> {
    try {
      setFolders(await backend.listFolders());
    } catch {
      // The list stays as it was; the next sync asks again.
    }
  }

  backend.onEvent((event) => {
    if (event.type === "accountsChanged") void refresh();
    else if (event.type === "syncStatus" && event.status.state === "idle") void refresh();
  });

  return {
    folders,
    refresh,
    /** The folders of one account. */
    of: (accountId: string): readonly Label[] => folders().filter((f) => f.accountId === accountId),
  };
}

export type FoldersStore = ReturnType<typeof createFoldersStore>;
