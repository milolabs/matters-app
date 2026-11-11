// ADR 0116, rule 4b: `sort:relevance` without a prompt, computed after `↵` over at most
// `RELEVANCE_POOL` matches, the newest. On the real index and on the fake one.
import type {
  AccountStorePort,
  Message,
  MessageStorePort,
  RankedSearchPort,
  SearchIndexPort,
} from "@matters/core";
import { RELEVANCE_POOL, searchMessages, sortRanked } from "@matters/core";
import { createInMemoryStorage, makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStorage, type SqliteStorage } from "../src/index.ts";

const open: SqliteStorage[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);

interface Storage {
  readonly store: MessageStorePort;
  readonly index: SearchIndexPort & RankedSearchPort;
  readonly accounts: AccountStorePort;
}

function rigs(): [string, () => Storage][] {
  return [
    [
      "sqlite",
      () => {
        const s = createSqliteStorage(":memory:");
        open.push(s);
        return s;
      },
    ],
    ["in memory", () => createInMemoryStorage()],
  ];
}

let seq = 0;

async function add(
  s: Storage,
  rows: readonly {
    thread: string;
    subject: string;
    body?: string;
    daysAgo: number;
    from?: string;
  }[],
): Promise<void> {
  const messages: Message[] = rows.map((r) =>
    makeMessage({
      seq: ++seq % 1024,
      providerId: `p${seq}`,
      threadId: r.thread,
      dateMs: NOW - r.daysAgo * DAY,
      from: { address: r.from ?? "someone@example.org" },
      subject: r.subject,
      labelIds: ["inbox"],
    }),
  );
  const { keys } = await s.store.upsertMessages(messages);
  await s.index.indexMessages(
    messages.map((m, i) => ({
      message: { ...m, key: keys[i] ?? m.key },
      bodyText: rows[i]?.body ?? "",
    })),
  );
}

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    thread: `f${i}`,
    subject: `Weekly note ${i}`,
    body: "Nothing much happened this week",
    daysAgo: 5 + i,
  }));

describe.each(rigs())("sort:relevance (ADR 0116, rule 4b), %s", (_n, make) => {
  const deps = (s: Storage) => ({
    index: s.index,
    store: s.store,
    accounts: s.accounts,
    now: () => NOW,
  });

  it("orders by how well the words match, one row a thread; the dated order is the keystroke's", async () => {
    const s = make();
    await add(s, [
      ...filler(40),
      { thread: "subject", subject: "Invoice for March", body: "Attached.", daysAgo: 200 },
      { thread: "body", subject: "Hello", body: "the invoice is somewhere", daysAgo: 1 },
      { thread: "body", subject: "Re: Hello", body: "thanks", daysAgo: 0 },
    ]);
    const typed = await searchMessages(deps(s), "invoice sort:relevance", { limit: 50 });
    expect(typed.messages.map((m) => m.threadId)).toEqual(["body", "subject"]);
    const r = await sortRanked(deps(s), "invoice sort:relevance");
    expect(r.sort).toBe("relevance");
    expect(r.rows.map((m) => m.threadId)).toEqual(["subject", "body"]);
    expect(r).toMatchObject({ pool: 2, matches: 2 });
    // `limit:` cuts after the order: the best one.
    const one = await sortRanked(deps(s), "invoice sort:relevance limit:1");
    expect(one.rows.map((m) => m.threadId)).toEqual(["subject"]);
  });

  it("has nothing to compute without words, for a prompt, or for a dated order", async () => {
    const s = make();
    await add(s, filler(3));
    for (const q of ["is:unread sort:relevance", 'note sort:relevance prompt:"x"', "note"]) {
      expect(await sortRanked(deps(s), q), q).toMatchObject({ sort: null, rows: [] });
    }
  });

  it("ranks the newest RELEVANCE_POOL matches only, and says how many match", async () => {
    const s = make();
    const extra = 30;
    // The oldest match is the best one by its words; it is past the pool, so it is not ranked.
    await add(s, [
      {
        thread: "old",
        subject: "Note note note",
        body: "note",
        daysAgo: 4000,
        from: "note@example.org",
      },
      ...Array.from({ length: RELEVANCE_POOL + extra - 1 }, (_, i) => ({
        thread: `n${i}`,
        subject: `Week ${i}`,
        body: `a note ${i}`,
        daysAgo: 1 + i / 10,
      })),
    ]);
    const r = await sortRanked(deps(s), "note sort:relevance");
    expect(r).toMatchObject({ pool: RELEVANCE_POOL, matches: RELEVANCE_POOL + extra });
    expect(r.rows).toHaveLength(RELEVANCE_POOL);
    expect(r.rows.some((m) => m.threadId === "old")).toBe(false);
  });
});
