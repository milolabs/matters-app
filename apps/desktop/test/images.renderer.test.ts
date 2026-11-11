import type { BackendEvent } from "@matters/contracts";
import type { GeneralImages, ImageChoice, ImageRule } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/renderer/client.ts";
import { allowingSource, barKind } from "../src/renderer/imageBar.ts";
import { createImageRulesStore } from "../src/renderer/imageRules.ts";
import { migrateImageAddresses, OLD_IMAGES_KEY } from "../src/renderer/imagesMigration.ts";

const choice = (over: Partial<ImageChoice> = {}): ImageChoice => ({
  show: false,
  source: "none",
  verdict: "unknown",
  address: "news@shop.example",
  domain: "shop.example",
  offerAddress: true,
  offerDomain: null,
  ...over,
});

describe("barKind", () => {
  it("asks in the usual words", () => {
    expect(barKind(choice())).toBe("ask");
    expect(barKind(choice({ verdict: "pass", offerDomain: "shop.example" }))).toBe("ask");
  });

  it("says the sender could not be verified when the verdict is fail", () => {
    expect(barKind(choice({ verdict: "fail", offerAddress: false }))).toBe("unverified");
  });

  it("says the reader chose not to when a deny decided, even for a failed sender", () => {
    expect(barKind(choice({ source: "address-deny" }))).toBe("denied");
    expect(barKind(choice({ source: "domain-deny", verdict: "pass" }))).toBe("denied");
    expect(barKind(choice({ source: "address-deny", verdict: "fail" }))).toBe("denied");
  });
});

describe("allowingSource", () => {
  it("names what let the images in, and nothing when they are off", () => {
    expect(allowingSource(choice({ show: true, source: "address-allow" }))).toBe("address-allow");
    expect(allowingSource(choice({ show: true, source: "domain-allow" }))).toBe("domain-allow");
    expect(allowingSource(choice({ show: true, source: "always" }))).toBe("always");
    expect(allowingSource(choice({ show: false, source: "none" }))).toBeNull();
    expect(allowingSource(choice({ show: false, source: "address-deny" }))).toBeNull();
    expect(allowingSource(null)).toBeNull();
  });
});

describe("migrateImageAddresses (ADR 0037, point 8)", () => {
  function storage(initial: string | null) {
    const items = new Map<string, string>(initial === null ? [] : [[OLD_IMAGES_KEY, initial]]);
    return {
      items,
      store: {
        getItem: (k: string) => items.get(k) ?? null,
        removeItem: (k: string) => void items.delete(k),
      },
    };
  }

  it("does nothing when there is no old list", async () => {
    const backend = { importImageAddresses: vi.fn(async () => 0) };
    await migrateImageAddresses(backend, storage(null).store);
    expect(backend.importImageAddresses).not.toHaveBeenCalled();
  });

  it("sends the addresses, and removes the key only after the backend confirmed", async () => {
    const s = storage(JSON.stringify(["a@x.example", 3, "b@x.example"]));
    let release: (n: number) => void = () => {};
    const backend = {
      importImageAddresses: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const done = migrateImageAddresses(backend, s.store);
    await Promise.resolve();
    expect(backend.importImageAddresses).toHaveBeenCalledWith(["a@x.example", "b@x.example"]);
    expect(s.items.has(OLD_IMAGES_KEY)).toBe(true);
    release(2);
    await done;
    expect(s.items.has(OLD_IMAGES_KEY)).toBe(false);
  });

  it("keeps the key when the backend refuses, and never throws", async () => {
    const s = storage(JSON.stringify(["a@x.example"]));
    const backend = {
      importImageAddresses: vi.fn(async () => {
        throw new Error("backend is not there");
      }),
    };
    await expect(migrateImageAddresses(backend, s.store)).resolves.toBeUndefined();
    expect(s.items.has(OLD_IMAGES_KEY)).toBe(true);
  });

  it("still confirms an empty list before it removes the key", async () => {
    const s = storage("[]");
    const backend = { importImageAddresses: vi.fn(async () => 0) };
    await migrateImageAddresses(backend, s.store);
    expect(backend.importImageAddresses).toHaveBeenCalledWith([]);
    expect(s.items.has(OLD_IMAGES_KEY)).toBe(false);
  });

  it("leaves a value that is not a list alone", async () => {
    const backend = { importImageAddresses: vi.fn(async () => 0) };
    for (const raw of ["{not json", '{"a":1}', '"a@x.example"']) {
      const s = storage(raw);
      await migrateImageAddresses(backend, s.store);
      expect(s.items.has(OLD_IMAGES_KEY)).toBe(true);
    }
    expect(backend.importImageAddresses).not.toHaveBeenCalled();
  });

  it("does not break when storage cannot be read, written or is missing", async () => {
    const backend = { importImageAddresses: vi.fn(async () => 1) };
    const unreadable = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {},
    };
    await expect(migrateImageAddresses(backend, unreadable)).resolves.toBeUndefined();
    await expect(migrateImageAddresses(backend, null)).resolves.toBeUndefined();
    const stuck = {
      getItem: () => JSON.stringify(["a@x.example"]),
      removeItem: () => {
        throw new Error("read only");
      },
    };
    await expect(migrateImageAddresses(backend, stuck)).resolves.toBeUndefined();
    expect(backend.importImageAddresses).toHaveBeenCalledTimes(1);
  });

  it("sends a long list in several requests, all confirmed before the key goes", async () => {
    const list = Array.from({ length: 12_000 }, (_, i) => `u${i}@x.example`);
    const s = storage(JSON.stringify(list));
    const sizes: number[] = [];
    const backend = {
      importImageAddresses: vi.fn(async (a: readonly string[]) => {
        sizes.push(a.length);
        expect(s.items.has(OLD_IMAGES_KEY)).toBe(true);
        return a.length;
      }),
    };
    await migrateImageAddresses(backend, s.store);
    expect(sizes).toEqual([5000, 5000, 2000]);
    expect(s.items.has(OLD_IMAGES_KEY)).toBe(false);
  });
});

describe("the image rules store", () => {
  function rig() {
    let rules: ImageRule[] = [];
    let general: GeneralImages = "ask";
    const listeners = new Set<(e: BackendEvent) => void>();
    const backend = {
      listImageRules: vi.fn(async () => ({ rules, general })),
      setGeneralImages: vi.fn(async (g: GeneralImages) => {
        general = g;
      }),
      removeImageRule: vi.fn(async (scope: string, value: string) => {
        const before = rules.length;
        rules = rules.filter((r) => !(r.scope === scope && r.value === value));
        return rules.length < before;
      }),
      onEvent: (l: (e: BackendEvent) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as Backend;
    const store = createRoot(() => createImageRulesStore(backend));
    return {
      store,
      backend,
      add: (r: ImageRule) => {
        rules.push(r);
      },
      emit: () => {
        for (const l of listeners) l({ type: "imageRulesChanged" });
      },
    };
  }
  const rule: ImageRule = {
    scope: "address",
    value: "a@x.example",
    decision: "allow",
    createdMs: 1,
  };

  it("loads, and reads again when another window changed something", async () => {
    const r = rig();
    expect(r.store.loaded()).toBe(false);
    await r.store.refresh();
    expect(r.store.loaded()).toBe(true);
    expect(r.store.rules()).toEqual([]);
    r.add(rule);
    r.emit();
    await vi.waitFor(() => expect(r.store.rules()).toEqual([rule]));
  });

  it("shows a new general setting at once, and sends it", async () => {
    const r = rig();
    const done = r.store.setGeneral("always");
    expect(r.store.general()).toBe("always");
    await done;
    expect(r.backend.setGeneralImages).toHaveBeenCalledWith("always");
    expect(r.store.general()).toBe("always");
  });

  it("goes back to what the backend holds when a setting is refused", async () => {
    const r = rig();
    (r.backend.setGeneralImages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no way"),
    );
    await r.store.setGeneral("always");
    expect(r.store.general()).toBe("ask");
    expect(r.store.failure()).toBe("no way");
  });

  it("removes a rule and lists what is left", async () => {
    const r = rig();
    r.add(rule);
    await r.store.refresh();
    await r.store.remove(rule);
    expect(r.backend.removeImageRule).toHaveBeenCalledWith("address", "a@x.example");
    expect(r.store.rules()).toEqual([]);
  });
});
