// Settings › Storage asks main for what only main knows: folder sizes and process memory, and to
// clear caches (ADR 0089, rule 5). Like the other bridges it exposes nothing: the page posts a
// request, the preload checks its shape and asks main, which answers only the settings window.

export const CHANNEL_STORAGE = "matters:storage";

export type StorageAction = "overview" | "clearCaches";
const ACTIONS: readonly string[] = ["overview", "clearCaches"] satisfies StorageAction[];

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
      deps
        .invoke(CHANNEL_STORAGE, ask.action)
        .then(
          (answer) => (isRecord(answer) ? answer : null),
          () => null,
        )
        .then((answer) => deps.post({ mattersStorageAnswer: { requestId, answer } }));
    },
  };
}
