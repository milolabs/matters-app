// The page's own settings move from the old key prefix to `matters.` once (ADR 0105). Imported
// first by every page that reads them, so the rename is done before any module looks. Synchronous,
// and it never throws: storage that cannot be read must not stop the window from opening.
import { OLD_IMAGES_KEY } from "./imagesMigration.ts";

export const OLD_PREFIX = "unclosed.";
export const PREFIX = "matters.";

type Store = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

function storage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Copies every `unclosed.*` value to its `matters.*` key and removes the old one. A value already
 * under the new key wins and is never overwritten. The old image list keeps its key: its own
 * migration reads it (imagesMigration.ts). Returns how many keys moved.
 */
export function renameOldKeys(store: Store | null = storage()): number {
  if (!store) return 0;
  let moved = 0;
  try {
    const old: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(OLD_PREFIX) && key !== OLD_IMAGES_KEY) old.push(key);
    }
    for (const key of old) {
      try {
        const value = store.getItem(key);
        if (value === null) continue;
        const next = PREFIX + key.slice(OLD_PREFIX.length);
        if (store.getItem(next) === null) store.setItem(next, value);
        // The old key goes only once the new one holds a value (a full storage refuses the write).
        if (store.getItem(next) !== null) {
          store.removeItem(key);
          moved++;
        }
      } catch {
        // This key stays as it is and is tried again on the next start.
      }
    }
  } catch {}
  return moved;
}

renameOldKeys();
