import type { Backend } from "./client.ts";

/** Where the first version kept the senders the reader allowed (ADR 0024). */
export const OLD_IMAGES_KEY = "unclosed.imagesFrom";

type Store = Pick<Storage, "getItem" | "removeItem">;

/** Well under the backend's limit for one request. */
const CHUNK = 5000;

function storage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * The old per-sender list becomes `allow` rules, once (ADR 0037, point 8). The key goes only
 * after the backend confirmed every address, so a crash or a refusal repeats the import on the
 * next start, which is harmless: addresses that already have a rule are left alone. It never
 * throws: storage that cannot be read, or a backend that is not there yet, must not stop the
 * window from opening.
 */
export async function migrateImageAddresses(
  backend: Pick<Backend, "importImageAddresses">,
  store: Store | null = storage(),
): Promise<void> {
  if (!store) return;
  let addresses: string[];
  try {
    const raw = store.getItem(OLD_IMAGES_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    // Something that is not a list is not ours to import, nor to delete.
    if (!Array.isArray(parsed)) return;
    addresses = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    return;
  }
  try {
    // At least one request, even for an empty list: the key goes only on the backend's word.
    let from = 0;
    do {
      await backend.importImageAddresses(addresses.slice(from, from + CHUNK));
      from += CHUNK;
    } while (from < addresses.length);
  } catch {
    return;
  }
  try {
    store.removeItem(OLD_IMAGES_KEY);
  } catch {
    // It will be imported again, and found already there.
  }
}
