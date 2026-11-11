import { describe, expect, it } from "vitest";
import { OLD_IMAGES_KEY } from "../src/renderer/imagesMigration.ts";
import { renameOldKeys } from "../src/renderer/keyRename.ts";

/** localStorage over a Map, in insertion order like the real one enough for these tests. */
function memoryStore(entries: Record<string, string> = {}, opts: { full?: boolean } = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem(k: string, v: string) {
      if (opts.full) throw new DOMException("quota", "QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

describe("renaming the old localStorage keys", () => {
  it("moves every old key to its new name and removes the old one", () => {
    const store = memoryStore({
      "unclosed.listWidth": "420",
      "unclosed.ai.paneWidth": "360",
      "unclosed.accountColors": '{"a":"#AABBCC"}',
      "someone.else": "kept",
    });
    expect(renameOldKeys(store)).toBe(3);
    expect(Object.fromEntries(store.data)).toEqual({
      "someone.else": "kept",
      "matters.listWidth": "420",
      "matters.ai.paneWidth": "360",
      "matters.accountColors": '{"a":"#AABBCC"}',
    });
    // Once moved, nothing is left to do.
    expect(renameOldKeys(store)).toBe(0);
  });

  it("never overwrites a value already under the new key", () => {
    const store = memoryStore({ "unclosed.listWidth": "420", "matters.listWidth": "300" });
    renameOldKeys(store);
    expect(store.getItem("matters.listWidth")).toBe("300");
    expect(store.getItem("unclosed.listWidth")).toBeNull();
  });

  it("leaves the old image list to its own migration", () => {
    const store = memoryStore({ [OLD_IMAGES_KEY]: '["a@example.com"]' });
    expect(renameOldKeys(store)).toBe(0);
    expect(store.getItem(OLD_IMAGES_KEY)).toBe('["a@example.com"]');
    expect(store.getItem("matters.imagesFrom")).toBeNull();
  });

  it("keeps the old key when the new one cannot be written, and never throws", () => {
    const store = memoryStore({ "unclosed.listWidth": "420" }, { full: true });
    expect(renameOldKeys(store)).toBe(0);
    expect(store.getItem("unclosed.listWidth")).toBe("420");

    const broken = {
      get length(): number {
        throw new Error("storage is gone");
      },
      key: () => null,
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    expect(renameOldKeys(broken)).toBe(0);
    expect(renameOldKeys(null)).toBe(0);
  });
});
