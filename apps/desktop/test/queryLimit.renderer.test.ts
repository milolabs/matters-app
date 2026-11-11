// ADR 0116, rule 4a: `limit:` without a prompt, in the list. The store asks the backend's search
// as for any query; here that is the real use case over the in-memory stores, so the cut, the end
// of paging and live updates are the backend's, as in the app.
import type { ChangesEvent } from "@matters/contracts";
import type { Message } from "@matters/core";
import { countMatches, parseQuery, type SavedView, searchMessages } from "@matters/core";
import { createInMemoryStorage, makeMessage } from "@matters/testkit";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/renderer/client.ts";
import { layoutList } from "../src/renderer/listLayout.ts";
import { createMailStore, isConstrained, PAGE_SIZE } from "../src/renderer/store.ts";
import { createViewsStore } from "../src/renderer/views.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function rig() {
  const s = createInMemoryStorage();
  let n = 0;
  async function add(count: number, from = "anna@example.com"): Promise<number[]> {
    const messages = Array.from({ length: count }, () => {
      const i = n++;
      return makeMessage({
        providerId: `m${i}`,
        threadId: `t${i}`,
        dateMs: T0 + i * DAY,
        from: { address: from },
        subject: `Note ${i}`,
        labelIds: ["inbox"],
        // Every other one unread.
        flags: { seen: i % 2 === 0, flagged: false, answered: false, draft: false },
      });
    });
    const { keys } = await s.store.upsertMessages(messages);
    await s.index.indexMessages(
      messages.map((m, i) => ({ message: { ...m, key: keys[i] ?? m.key }, bodyText: m.subject })),
    );
    return [...keys];
  }
  const deps = { index: s.index, store: s.store, accounts: { list: async () => [] } };
  const search = vi.fn(
    async (args: { query: string; limit: number; beforeKey?: number; afterKey?: number }) => ({
      type: "search",
      requestId: "x",
      ok: true,
      ...(await searchMessages(deps, args.query, args)),
    }),
  );
  const listNewest = vi.fn(async ({ limit }: { limit: number }) => ({
    messages: (await s.store.listNewest({ limit })) as Message[],
  }));
  const backend = {
    search,
    async countMatches(args: { query: string; cap: number; beforeKey?: number }) {
      return countMatches(deps, args.query, args);
    },
    listNewest,
    async getMessages(keys: readonly number[]) {
      return { messages: await s.store.getByKeys(keys) };
    },
    async openThread() {
      return null;
    },
  } as unknown as Backend;
  return { add, backend, search, listNewest };
}

const changes = (changed: readonly number[]): ChangesEvent => ({
  type: "changes",
  changeSeq: 1,
  changedKeys: changed,
  removedKeys: [],
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!done()) throw new Error("timed out");
};

const subjects = (ms: readonly Message[]) => ms.map((m) => m.subject);

describe("limit: in the list (ADR 0116, rule 4a)", () => {
  it("is a constraint without a prompt, and the prompt's own with one", () => {
    expect(isConstrained("limit:5")).toBe(true);
    expect(isConstrained("from:anna limit:5")).toBe(true);
    expect(isConstrained("limit:")).toBe(false);
    expect(isConstrained("limit:zero")).toBe(false);
    expect(isConstrained("limit:5 prompt:x")).toBe(false);
    // Not in the tree: nothing else that reads the tree sees it.
    expect(parseQuery("from:anna limit:5").root).toEqual(parseQuery("from:anna").root);
  });

  it("lists at most N, the newest, and does not page past them", async () => {
    const r = rig();
    await r.add(30);
    const store = createMailStore(r.backend);
    await store.start();
    store.setQuery("from:anna limit:4");
    await until(() => store.messages().length === 4 && !store.searching());
    expect(subjects(store.messages())).toEqual(["Note 29", "Note 28", "Note 27", "Note 26"]);
    expect(store.hasMore()).toBe(false);
    await store.loadMore();
    expect(store.messages()).toHaveLength(4);
  });

  it("alone, lists the newest N of all mail through the search", async () => {
    const r = rig();
    await r.add(10);
    const store = createMailStore(r.backend);
    await store.start();
    r.listNewest.mockClear();
    store.setQuery("limit:2");
    await until(() => store.messages().length === 2);
    expect(subjects(store.messages())).toEqual(["Note 9", "Note 8"]);
    expect(r.search).toHaveBeenCalledWith(expect.objectContaining({ query: "limit:2" }));
    expect(r.listNewest).not.toHaveBeenCalled();
    expect(store.hasMore()).toBe(false);
  });

  it("keeps N as new mail arrives: the newest comes in, the oldest goes", async () => {
    const r = rig();
    await r.add(10);
    const store = createMailStore(r.backend);
    await store.start();
    store.setQuery("limit:3");
    await until(() => store.messages().length === 3);
    const keys = await r.add(2);
    await store.applyChanges(changes(keys));
    expect(subjects(store.messages())).toEqual(["Note 11", "Note 10", "Note 9"]);
  });
});

describe("a saved view with limit: (ADR 0116, rule 4a)", () => {
  it("keeps the term, lists N when opened, and counts the unread among those N", async () => {
    const r = rig();
    await r.add(20);
    const view: SavedView = {
      id: "v",
      name: "Latest",
      query: "from:anna limit:4",
      position: 0,
      createdMs: 1,
      updatedMs: 1,
    };
    const backend = Object.assign(r.backend, { listViews: async () => [view] }) as Backend;
    const store = createMailStore(backend);
    await store.start();
    const views = createViewsStore(backend, store, { delay: async () => {} });
    await views.load();
    await until(() => views.badge("v") !== undefined);
    // Of 16..19, the odd ones are unread: 17 and 19. Not the 10 unread of all 20.
    expect(views.badge("v")).toBe("2");
    views.select("v");
    expect(store.query()).toBe("from:anna limit:4");
    await until(() => store.messages().length === 4 && !store.searching());
    expect(subjects(store.messages())).toEqual(["Note 19", "Note 18", "Note 17", "Note 16"]);
    expect(views.changed()).toBe(false);
  });
});

describe("sort:oldest in the list (ADR 0116, rule 4b)", () => {
  it("is a constraint, also alone, and walks the key the other way", () => {
    expect(isConstrained("sort:oldest")).toBe(true);
    expect(isConstrained("sort:newest")).toBe(false);
    expect(isConstrained("sort:relevance")).toBe(false);
    expect(isConstrained("from:anna sort:newest")).toBe(true);
  });

  it("lists oldest first, pages on by afterKey, and its day headings ascend", async () => {
    const r = rig();
    await r.add(PAGE_SIZE + 50);
    const store = createMailStore(r.backend);
    await store.start();
    store.setQuery("from:anna sort:oldest");
    await until(() => store.messages()[0]?.subject === "Note 0" && !store.searching());
    expect(store.messages()).toHaveLength(PAGE_SIZE);
    expect(subjects(store.messages().slice(0, 3))).toEqual(["Note 0", "Note 1", "Note 2"]);
    expect(store.hasMore()).toBe(true);
    await store.loadMore();
    expect(store.messages()).toHaveLength(PAGE_SIZE + 50);
    expect(store.messages().at(-1)?.subject).toBe(`Note ${PAGE_SIZE + 49}`);
    expect(store.hasMore()).toBe(false);
    const last = r.search.mock.calls.at(-1)?.[0];
    expect(last?.afterKey).toBeDefined();
    expect(last?.beforeKey).toBeUndefined();
    // Day headings follow the rows, months ascending; today's mail would come last.
    const heads = layoutList(store.messages(), T0 + 400 * DAY)
      .items.filter((i) => i.kind === "head")
      .map((i) => (i.kind === "head" ? i.label : ""));
    expect(heads.slice(0, 3)).toEqual(["January 2026", "February 2026", "March 2026"]);
  });

  it("alone, lists all mail oldest first through the search; with a limit, the N oldest", async () => {
    const r = rig();
    await r.add(10);
    const store = createMailStore(r.backend);
    await store.start();
    r.listNewest.mockClear();
    store.setQuery("sort:oldest limit:3");
    await until(() => store.messages().length === 3);
    expect(subjects(store.messages())).toEqual(["Note 0", "Note 1", "Note 2"]);
    expect(r.listNewest).not.toHaveBeenCalled();
    expect(store.hasMore()).toBe(false);
  });

  it("live: new mail lands at the end of a short list, past a long one's first page", async () => {
    const r = rig();
    await r.add(5);
    const store = createMailStore(r.backend);
    await store.start();
    store.setQuery("sort:oldest");
    await until(() => store.messages()[0]?.subject === "Note 0");
    const keys = await r.add(1);
    await store.applyChanges(changes(keys));
    expect(subjects(store.messages())).toEqual([
      "Note 0",
      "Note 1",
      "Note 2",
      "Note 3",
      "Note 4",
      "Note 5",
    ]);
    // A list longer than a page: the first page stays the oldest ones.
    await r.add(PAGE_SIZE);
    const more = await r.add(1);
    await store.applyChanges(changes(more));
    expect(store.messages()[0]?.subject).toBe("Note 0");
    expect(store.messages()).toHaveLength(PAGE_SIZE);
    expect(store.hasMore()).toBe(true);
  });

  it("a ranked order lists by date while typing", async () => {
    const r = rig();
    await r.add(4);
    const store = createMailStore(r.backend);
    await store.start();
    store.setQuery("note sort:relevance");
    await until(() => r.search.mock.calls.length > 0 && store.messages().length === 4);
    expect(subjects(store.messages())).toEqual(["Note 3", "Note 2", "Note 1", "Note 0"]);
    expect(store.ordered()).toBe(false);
  });
});
