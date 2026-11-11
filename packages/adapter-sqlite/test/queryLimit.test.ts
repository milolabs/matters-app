// ADR 0116, rule 4a: `limit:` without a prompt lists at most that many messages, the newest along
// the key, and stops paging there; a badge counts the unread among them. On the real index and
// on the fake one, so both agree.
import type { Message, SearchIndexPort } from "@matters/core";
import { countMatches, EXACT_LIMIT_COUNT, searchMessages } from "@matters/core";
import { createInMemoryStorage, makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStorage, type SqliteStorage } from "../src/index.ts";

const open: SqliteStorage[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

interface Rig {
  readonly store: { upsertMessages(b: readonly Message[]): Promise<{ keys: readonly number[] }> };
  readonly index: SearchIndexPort;
  readonly deps: Parameters<typeof searchMessages>[0];
}

function rigs(): [string, () => Rig][] {
  const accounts = { list: async () => [] };
  return [
    [
      "sqlite",
      () => {
        const s = createSqliteStorage(":memory:");
        open.push(s);
        return {
          store: s.store,
          index: s.index,
          deps: { index: s.index, store: s.store, accounts },
        };
      },
    ],
    [
      "in memory",
      () => {
        const s = createInMemoryStorage();
        return {
          store: s.store,
          index: s.index,
          deps: { index: s.index, store: s.store, accounts },
        };
      },
    ],
  ];
}

/** `n` messages, one a day, from Anna and Ben by turns; every third one unread. */
async function fill(r: Rig, n: number, from = 0): Promise<void> {
  const messages = Array.from({ length: n }, (_, j) => {
    const i = from + j;
    return makeMessage({
      providerId: `m${i}`,
      threadId: `t${i}`,
      dateMs: T0 + i * DAY,
      from: { address: i % 2 === 0 ? "anna@example.com" : "ben@example.com" },
      subject: `Note ${i}`,
      flags: { seen: i % 3 !== 0, flagged: false, answered: false, draft: false },
      labelIds: ["inbox"],
    });
  });
  const { keys } = await r.store.upsertMessages(messages);
  await r.index.indexMessages(
    messages.map((m, i) => ({ message: { ...m, key: keys[i] ?? m.key }, bodyText: m.subject })),
  );
}

/** Every page of a query, as the list pages it: by `afterKey` oldest first (rule 4b). */
async function pages(r: Rig, query: string, limit: number): Promise<Message[][]> {
  const out: Message[][] = [];
  let before: number | undefined;
  let after: number | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await searchMessages(r.deps, query, {
      limit,
      ...(before === undefined ? {} : { beforeKey: before }),
      ...(after === undefined ? {} : { afterKey: after }),
    });
    out.push([...page.messages]);
    if (page.nextBeforeKey === undefined && page.nextAfterKey === undefined) break;
    before = page.nextBeforeKey;
    after = page.nextAfterKey;
  }
  return out;
}

const subjects = (ms: readonly Message[]) => ms.map((m) => m.subject);

describe.each(rigs())("limit: without a prompt (ADR 0116, rule 4a), %s", (_name, make) => {
  it("lists the newest N matches and stops paging there", async () => {
    const r = make();
    await fill(r, 40);
    // Anna wrote the even ones: the newest five are 38, 36, ... 30.
    const one = await pages(r, "from:anna limit:5", 200);
    expect(one.map(subjects)).toEqual([["Note 38", "Note 36", "Note 34", "Note 32", "Note 30"]]);
    // Paged three at a time, the cut holds: no sixth row, and no cursor after it.
    const paged = await pages(r, "from:anna limit:5", 3);
    expect(paged.flat().map((m) => m.subject)).toEqual(one[0]?.map((m) => m.subject));
    expect(paged.at(-1)?.length).toBeGreaterThan(0);
    // More than there is: all of it.
    expect((await pages(r, "from:anna limit:500", 200)).flat()).toHaveLength(20);
    // Order does not matter, and a dropped limit cuts nothing.
    expect((await pages(r, "limit:5 from:anna", 200)).flat()).toHaveLength(5);
    expect((await pages(r, "from:anna -limit:5", 200)).flat()).toHaveLength(20);
  });

  it("alone, lists the N newest messages of all mail", async () => {
    const r = make();
    await fill(r, 12);
    expect(subjects((await pages(r, "limit:3", 200)).flat())).toEqual([
      "Note 11",
      "Note 10",
      "Note 9",
    ]);
    expect((await pages(r, "limit:", 200)).flat()).toEqual([]);
  });

  it("keeps N as new mail arrives: the oldest goes", async () => {
    const r = make();
    await fill(r, 10);
    await fill(r, 2, 10);
    expect(subjects((await pages(r, "limit:3", 200)).flat())).toEqual([
      "Note 11",
      "Note 10",
      "Note 9",
    ]);
  });

  it("is not the list's when there is a prompt: the prompt's limit is of its own", async () => {
    const r = make();
    await fill(r, 10);
    expect((await pages(r, "from:anna limit:2 prompt:x", 200)).flat()).toHaveLength(5);
  });

  it("counts for a badge the unread among the newest N only", async () => {
    const r = make();
    await fill(r, 30);
    const count = async (q: string) => {
      let total = 0;
      let before: number | undefined;
      for (let i = 0; i < 100; i++) {
        const c = await countMatches(r.deps, q, {
          cap: 2,
          ...(before === undefined ? {} : { beforeKey: before }),
        });
        total += c.count;
        if (c.nextBeforeKey === undefined) break;
        before = c.nextBeforeKey;
      }
      return total;
    };
    // Unread: every third (0, 3, ..., 27). The newest ten are 20..29: 21, 24, 27 unread.
    expect(await count("is:unread")).toBe(10);
    expect(await count("limit:10")).toBe(3);
    expect(await count("from:anna limit:5")).toBe(1); // 28 26 24 22 20: only 24
    expect(await count("limit:10 prompt:x")).toBe(0);
    expect(EXACT_LIMIT_COUNT).toBeGreaterThanOrEqual(1000);
  });
});

describe.each(rigs())("sort:oldest without a prompt (ADR 0116, rule 4b), %s", (_name, make) => {
  it("lists oldest first, paged along the key the other way", async () => {
    const r = make();
    // Over more than a year, so the time windows of a heavy plan matter.
    await fill(r, 400);
    const all = (await pages(r, "from:anna sort:oldest", 200)).flat();
    expect(all).toHaveLength(200);
    expect(subjects(all.slice(0, 3))).toEqual(["Note 0", "Note 2", "Note 4"]);
    const keys = all.map((m) => m.key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    // Paged seven at a time: the same rows, in the same order.
    expect((await pages(r, "from:anna sort:oldest", 7)).flat().map((m) => m.key)).toEqual(keys);
    // The newest order is untouched, and the reverse of it.
    const newest = (await pages(r, "from:anna", 200)).flat().map((m) => m.key);
    expect(newest).toEqual([...keys].reverse());
    // A light plan (an indexed flag drives it) and a heavy one (a negated word is a nested FTS
    // subquery, walked in time windows) agree, oldest first.
    const unread = (await pages(r, "is:unread sort:oldest", 50)).flat();
    expect(unread[0]?.subject).toBe("Note 0");
    expect(unread).toHaveLength(134);
    const heavy = (await pages(r, "(-note OR is:unread) sort:oldest", 50)).flat();
    expect(heavy.map((m) => m.key)).toEqual(unread.map((m) => m.key));
  });

  it("alone, lists all mail oldest first; with a limit, the N oldest", async () => {
    const r = make();
    await fill(r, 12);
    expect(subjects((await pages(r, "sort:oldest", 5)).flat()).slice(0, 3)).toEqual([
      "Note 0",
      "Note 1",
      "Note 2",
    ]);
    expect((await pages(r, "sort:oldest", 5)).flat()).toHaveLength(12);
    expect(subjects((await pages(r, "sort:oldest limit:3", 200)).flat())).toEqual([
      "Note 0",
      "Note 1",
      "Note 2",
    ]);
    // Paged two at a time, the cut holds.
    expect(subjects((await pages(r, "limit:3 sort:oldest", 2)).flat())).toEqual([
      "Note 0",
      "Note 1",
      "Note 2",
    ]);
    // New mail does not change the oldest N.
    await fill(r, 2, 12);
    expect(subjects((await pages(r, "sort:oldest limit:3", 200)).flat())).toEqual([
      "Note 0",
      "Note 1",
      "Note 2",
    ]);
    // A ranked order lists by date while typing (it is ranked only after ↵).
    expect(subjects((await pages(r, "note sort:relevance limit:2", 200)).flat())).toEqual([
      "Note 13",
      "Note 12",
    ]);
  });

  it("counts for a badge the unread among the oldest N", async () => {
    const r = make();
    await fill(r, 30);
    const count = async (q: string) => {
      let total = 0;
      let before: number | undefined;
      for (let i = 0; i < 100; i++) {
        const c = await countMatches(r.deps, q, {
          cap: 2,
          ...(before === undefined ? {} : { beforeKey: before }),
        });
        total += c.count;
        if (c.nextBeforeKey === undefined) break;
        before = c.nextBeforeKey;
      }
      return total;
    };
    // The oldest ten are 0..9: 0, 3, 6, 9 unread. The order alone changes no count.
    expect(await count("sort:oldest limit:10")).toBe(4);
    expect(await count("from:anna sort:oldest limit:5")).toBe(2); // 0 2 4 6 8: 0 and 6
    expect(await count("is:unread sort:oldest")).toBe(10);
    expect(await count("is:unread sort:relevance")).toBe(10);
  });
});
