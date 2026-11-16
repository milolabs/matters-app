// Settings › Storage asks main for what only main knows: folder sizes and process memory, and to
// clear caches (ADR 0089, rule 5). Like the other bridges it exposes nothing: the page posts a
// request, the preload checks its shape and asks main, which answers only the settings window.

export const CHANNEL_STORAGE = "matters:storage";

/**
 * `eraseOverview`: what Erase everything would take, as main measures it (ADR 0138, rule 9).
 * `erase`: writes the erase order and restarts (rule 3); it carries one boolean, the earlier copy.
 */
export type StorageAction =
  | "overview"
  | "clearCaches"
  | "eraseOverview"
  | "erase"
  | "permissionPage"
  // Backups (ADR 0145): main shows every dialog; a set-aside database is named by its folder.
  | "backupOverview"
  | "backup"
  | "restoreBackup"
  | "restoreSetAside"
  | "stopBackup"
  | "cancelRestore"
  | "removeSetAside"
  | "restartToRestore";
const ACTIONS: readonly string[] = [
  "overview",
  "clearCaches",
  "eraseOverview",
  "erase",
  "permissionPage",
  "backupOverview",
  "backup",
  "restoreBackup",
  "restoreSetAside",
  "stopBackup",
  "cancelRestore",
  "removeSetAside",
  "restartToRestore",
] satisfies StorageAction[];
/** A set-aside folder's name, `20261116T153000Z`: nothing else passes (main checks it again). */
const SET_ASIDE_NAME = /^\d{8}T\d{6}Z$/;
/** The provider pages main may open (ADR 0138, rule 8), by name: the page never sends an address. */
const PAGES: readonly string[] = ["microsoftWork", "microsoftPersonal"];

export interface StorageBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface StorageMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function createStorageBridge(deps: StorageBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: StorageMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersStorage;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      if (typeof ask.action !== "string" || !ACTIONS.includes(ask.action)) {
        deps.post({ mattersStorageAnswer: { requestId, answer: null } });
        return;
      }
      // Only a boolean and page names pass with the order; anything else is dropped.
      const pages = Array.isArray(ask.pages)
        ? ask.pages.filter((p): p is string => typeof p === "string" && PAGES.includes(p))
        : [];
      const setAside =
        typeof ask.name === "string" && SET_ASIDE_NAME.test(ask.name) ? ask.name : null;
      const args =
        ask.action === "erase"
          ? [ask.earlierCopy === true, [...new Set(pages)]]
          : ask.action === "permissionPage"
            ? [typeof ask.page === "string" && PAGES.includes(ask.page) ? ask.page : null]
            : ask.action === "removeSetAside" || ask.action === "restoreSetAside"
              ? [setAside]
              : [];
      deps
        .invoke(CHANNEL_STORAGE, ask.action, ...args)
        .then(
          (answer) => (isRecord(answer) ? answer : null),
          () => null,
        )
        .then((answer) => deps.post({ mattersStorageAnswer: { requestId, answer } }));
    },
  };
}
