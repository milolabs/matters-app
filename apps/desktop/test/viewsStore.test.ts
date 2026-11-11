import type { SavedView } from "@matters/core";
import { describe, expect, it } from "vitest";
import { type Backend, BackendError } from "../src/renderer/client.ts";
import { createMailStore } from "../src/renderer/store.ts";
import { ALL_MAIL, BADGE_GAP_MS, createViewsStore } from "../src/renderer/views.ts";

const view = (id: string, name: string, query: string, position: number): SavedView => ({
  id,
  name,
  query,
  position,
  createdMs: 1,
  updatedMs: 1,
});

/** A backend with views and a scripted count; messages are empty. */
function rig(initial: SavedView[], counts: Record<string, number[]> = {}) {
  let list = [...initial];
  const calls: { query: string; cap: number; beforeKey?: number }[] = [];
  const failing = new Set<string>();
  const backend = {
    async listNewest() {
      return { messages: [] };
    },
    async search() {
      return { messages: [] };
    },
    async listViews() {
      return list;
    },
    async createView(name: string, query: string) {
      if (list.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
        throw new BackendError("invalidView", `A view named "${name}" already exists.`);
      }
      const v = view(`n${list.length + 1}`, name, query, list.length);
      list = [...list, v];
      return v;
    },
    async updateViewQuery(id: string, query: string) {
      const v = { ...(list.find((x) => x.id === id) as SavedView), query };
      list = list.map((x) => (x.id === id ? v : x));
      return v;
    },
    async renameView(id: string, name: string) {
      const v = { ...(list.find((x) => x.id === id) as SavedView), name };
      list = list.map((x) => (x.id === id ? v : x));
      return v;
    },
    async deleteView(id: string) {
      list = list.filter((v) => v.id !== id);
    },
    async moveView(id: string, to: number) {
      const rest = list.filter((v) => v.id !== id);
      rest.splice(to, 0, list.find((v) => v.id === id) as SavedView);
      list = rest;
    },
    async countMatches(args: { query: string; cap: number; beforeKey?: number }) {
      calls.push(args);
      if (failing.has(args.query)) throw new Error("boom");
      // Chunks of the script per query: [3, 4] means two windows holding 3 and 4.
      const chunks = counts[args.query] ?? [0];
      const at = args.beforeKey === undefined ? 0 : args.beforeKey;
      const count = chunks[at] ?? 0;
      return at + 1 < chunks.length ? { count, nextBeforeKey: at + 1 } : { count };
    },
  } as unknown as Backend;
  return { backend, calls, failing, current: () => list };
}

/** A delay the test releases by hand. */
function clock() {
  const waiting: { ms: number; release: () => void }[] = [];
  return {
    delay: (ms: number) => new Promise<void>((release) => waiting.push({ ms, release })),
    waiting,
    /** Releases whatever waits, repeatedly, until the loop is idle. */
    async drain(max = 200) {
      for (let i = 0; i < max; i++) {
        await new Promise((r) => setTimeout(r, 0));
        const next = waiting.shift();
        if (!next) return i;
        next.release();
      }
      throw new Error("never idle");
    },
  };
}

async function setup(initial: SavedView[], counts: Record<string, number[]> = {}) {
  const r = rig(initial, counts);
  const store = createMailStore(r.backend);
  const c = clock();
  const texts: string[] = [];
  const views = createViewsStore(r.backend, store, {
    delay: c.delay,
    setText: (t) => {
      texts.push(t);
      store.setQuery(t);
    },
  });
  await views.load();
  return { ...r, store, views, clock: c, texts };
}

const two = [view("a", "Invoices", "faktura", 0), view("b", "Unread", "is:unread", 1)];

describe("views store: tabs and changed", () => {
  it("has All mail first, not stored; the active view is All mail with no change", async () => {
    const { views } = await setup(two);
    expect(views.views().map((v) => v.name)).toEqual(["All mail", "Invoices", "Unread"]);
    expect(views.active()).toBe(ALL_MAIL);
    expect(views.changed()).toBe(false);
  });

  it("select sets the text through setText and never saves; changed follows the text", async () => {
    const { views, store, texts, current } = await setup(two);
    views.select("a");
    expect(texts).toEqual(["faktura"]);
    expect(store.query()).toBe("faktura");
    expect(views.changed()).toBe(false);
    store.setQuery("faktura is:unread");
    expect(views.changed()).toBe(true);
    expect(current()[0]?.query).toBe("faktura");
    views.select("nope");
    expect(views.active().id).toBe("a");
    views.select("all");
    expect(store.query()).toBe("");
  });

  it("selecting the active tab does nothing: no setText, the unsaved text stays", async () => {
    const { views, store, texts } = await setup(two);
    views.select("a");
    store.setQuery("faktura edited");
    texts.length = 0;
    views.select("a");
    expect(texts).toEqual([]);
    expect(store.query()).toBe("faktura edited");
    expect(views.changed()).toBe(true);
    // The same on All mail.
    views.select("all");
    store.setQuery("typed");
    texts.length = 0;
    views.select("all");
    expect(texts).toEqual([]);
    expect(store.query()).toBe("typed");
  });

  it("on All mail, any text is a change", async () => {
    const { views, store } = await setup(two);
    store.setQuery("x");
    expect(views.changed()).toBe(true);
    views.revert();
    expect(store.query()).toBe("");
    expect(views.changed()).toBe(false);
  });

  it("save writes the text into the active view; revert goes back to the saved text", async () => {
    const { views, store, current } = await setup(two);
    views.select("a");
    store.setQuery("faktura has:attachment");
    views.revert();
    expect(store.query()).toBe("faktura");
    store.setQuery("faktura has:attachment");
    expect(await views.save()).toEqual({ ok: true });
    expect(current()[0]?.query).toBe("faktura has:attachment");
    expect(views.active().query).toBe("faktura has:attachment");
    expect(views.changed()).toBe(false);
  });

  it("saveAs creates, appends and activates; a duplicate keeps everything and says why", async () => {
    const { views, store } = await setup(two);
    store.setQuery("from:anna");
    const dup = await views.saveAs("invoices");
    expect(dup).toEqual({ ok: false, message: 'A view named "invoices" already exists.' });
    expect(views.active().id).toBe("all");
    expect(views.saved()).toHaveLength(2);
    expect(await views.saveAs("Anna")).toEqual({ ok: true });
    expect(views.views().map((v) => v.name)).toEqual(["All mail", "Invoices", "Unread", "Anna"]);
    expect(views.active().name).toBe("Anna");
    expect(views.changed()).toBe(false);
    expect(store.query()).toBe("from:anna");
  });

  it("create adds a view from a name and query given whole, and leaves the tab and the text alone (ADR 0102)", async () => {
    const { views, store, texts } = await setup(two);
    store.setQuery("typed");
    texts.length = 0;
    expect(await views.create("Anna", "from:anna")).toMatchObject({
      ok: true,
      view: { name: "Anna", query: "from:anna" },
    });
    expect(views.saved().map((v) => [v.name, v.query])).toEqual([
      ["Invoices", "faktura"],
      ["Unread", "is:unread"],
      ["Anna", "from:anna"],
    ]);
    expect(views.active().id).toBe("all");
    expect(store.query()).toBe("typed");
    expect(texts).toEqual([]);
    expect(await views.create("anna", "from:anna2")).toEqual({
      ok: false,
      message: 'A view named "anna" already exists.',
    });
    expect(views.saved()).toHaveLength(3);
  });

  it("naming: only for text that could be a view; submit renames or creates", async () => {
    const { views, store } = await setup(two);
    expect(views.startNaming()).toBe(false);
    store.setQuery("from:"); // constrains nothing
    expect(views.startNaming()).toBe(false);
    store.setQuery("from:anna");
    expect(views.startNaming()).toBe(true);
    views.cancelNaming();
    expect(views.naming()).toBeNull();
    views.startRename("b");
    expect(views.naming()).toEqual({ mode: "rename", id: "b", name: "Unread" });
    expect(await views.submitName("Inbox zero")).toEqual({ ok: true });
    expect(views.saved().map((v) => v.name)).toEqual(["Invoices", "Inbox zero"]);
    expect(views.naming()).toBeNull();
  });

  it("deleting the active view goes to All mail with an empty query; others leave it alone", async () => {
    const { views, store } = await setup(two);
    views.select("a");
    store.setQuery("faktura edited");
    await views.remove("b");
    expect(views.active().id).toBe("a");
    expect(store.query()).toBe("faktura edited");
    await views.remove("a");
    expect(views.active().id).toBe("all");
    expect(store.query()).toBe("");
    expect(views.views().map((v) => v.id)).toEqual(["all"]);
  });

  it("moves a view by one place, not past the ends", async () => {
    const { views, current } = await setup(two);
    await views.move("b", -1);
    expect(views.saved().map((v) => v.id)).toEqual(["b", "a"]);
    expect(current().map((v) => v.id)).toEqual(["b", "a"]);
    await views.move("b", -1);
    expect(views.saved().map((v) => v.id)).toEqual(["b", "a"]);
  });
});

describe("views store: badges", () => {
  it("counts one view at a time, one window per request, with a gap, and shows 99+ at the cap", async () => {
    const { views, calls, clock: c } = await setup(two, { faktura: [40, 70], "is:unread": [5] });
    // load() queued the first run; nothing has been asked yet.
    expect(calls).toEqual([]);
    await c.drain();
    expect(calls).toEqual([
      // All mail first: its unread mail, like any view (ADR 0093).
      { query: "is:unread", cap: 99 },
      { query: "faktura", cap: 99 },
      { query: "faktura", cap: 59, beforeKey: 1 },
      { query: "is:unread", cap: 99 },
    ]);
    expect(views.badge("all")).toBe("5");
    expect(views.badge("a")).toBe("99+");
    expect(views.badge("b")).toBe("5");
  });

  it("keeps a tab's unread badge when it is selected", async () => {
    const { views, clock: c } = await setup(two, { faktura: [3], "is:unread": [4] });
    await c.drain();
    views.select("a");
    expect(views.badge("a")).toBe("3");
    views.select("all");
    expect(views.badge("all")).toBe("4");
  });

  it("waits at least 16 ms between requests", async () => {
    const { clock: c } = await setup(two, { faktura: [1, 1], "is:unread": [1] });
    const gaps: number[] = [];
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const next = c.waiting.shift();
      if (!next) break;
      gaps.push(next.ms);
      next.release();
    }
    expect(gaps[0]).toBe(0);
    expect(gaps.slice(1).every((ms) => ms >= BADGE_GAP_MS)).toBe(true);
    expect(gaps.length).toBeGreaterThan(3);
  });

  it("shows no badge for zero", async () => {
    const { views, clock: c } = await setup(two, { faktura: [0], "is:unread": [2] });
    await c.drain();
    expect(views.badge("a")).toBeUndefined();
    expect(views.badge("b")).toBe("2");
  });

  it("typing abandons the run; the next one starts after the quiet time", async () => {
    const { views, store, calls, clock: c } = await setup(two, { faktura: [3], "is:unread": [4] });
    await new Promise((r) => setTimeout(r, 0));
    c.waiting.shift()?.release(); // the load run starts: first request goes out
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    store.setQuery("x"); // a keystroke
    await new Promise((r) => setTimeout(r, 0));
    // The in-flight run is dead: releasing its gap asks for nothing more.
    const before = calls.length;
    c.waiting.shift()?.release(); // its gap
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(before);
    // The restart waits for the quiet time (1500 ms), then counts everything again.
    expect(c.waiting.some((w) => w.ms === 1500)).toBe(true);
    await c.drain();
    expect(calls.length).toBeGreaterThan(before);
    expect(views.badge("b")).toBe("4");
  });

  it("a changes event or a views change also restarts it", async () => {
    const { views, calls, clock: c } = await setup(two, { faktura: [3], "is:unread": [4] });
    await c.drain();
    const done = calls.length;
    views.noteChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.waiting.some((w) => w.ms === 1500)).toBe(true);
    await c.drain();
    expect(calls.length).toBe(done * 2);
    await views.remove("a");
    expect(c.waiting.some((w) => w.ms === 0)).toBe(true);
  });

  it("a failing count shows no badge and goes on with the next view", async () => {
    const {
      views,
      failing,
      calls,
      clock: c,
    } = await setup(two, { "is:unread": [4], faktura: [9] });
    failing.add("faktura");
    await c.drain();
    expect(views.badge("a")).toBeUndefined();
    expect(views.badge("b")).toBe("4");
    expect(calls.filter((x) => x.query === "faktura")).toHaveLength(1);
  });
});
