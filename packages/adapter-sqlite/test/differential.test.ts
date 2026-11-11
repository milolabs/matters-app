import type { Message, MessageDocument, ParsedQuery, QueryNode, TextField } from "@matters/core";
import { parseQuery, tokenize } from "@matters/core";
import { InMemorySearchIndex, makeMessage, person } from "@matters/testkit";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Database,
  openDatabase,
  SqliteMessageStore,
  SqliteSearchIndex,
} from "../src/index.ts";

// The in-memory index is the reference (ADR 0025); SQLite must return the same keys for any
// tree, through `search` and through concatenated chunks, whichever plan it picks.

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}

const BASE_WORDS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "faktura",
  "umowa",
  "żółw",
  "łódź",
  "spotkanie",
  "raport",
  "invoice",
  "meeting",
  "budget",
  "plan",
  "zamówienie",
  "oferta",
  "test",
  "kod",
  "serwer",
  "mail",
];
// Words that share prefixes of 4+ characters, Polish words that fold, an expansion wider than
// the cap (90 forms of "katalog") and words at and over the 32-character limit.
const EXTRA_WORDS = [
  "faktury",
  "fakturze",
  "fakturowanie",
  "faktyczny",
  "fakt",
  "zażółć",
  "żółwik",
  "żółwie",
  "łódzki",
  "zamówienia",
  "zamówień",
  "spotkania",
  "spotkaniu",
  ...Array.from({ length: 90 }, (_, i) => `katalog${String(i).padStart(2, "0")}`),
  `dlugie${"a".repeat(26)}`,
  `dlugie${"a".repeat(27)}`,
  `dlugie${"b".repeat(40)}`,
];
const ALL_WORDS = [...BASE_WORDS, ...EXTRA_WORDS];
const PEOPLE = [
  person("Jan Kowalski", "jan@example.com"),
  person("Anna Nowak", "anna@example.org"),
  person("Bartek", "bartek@firma.pl"),
  person("Carla Łukasiewicz", "carla@example.com"),
  person("Dorota", "dorota@acme.org"),
  person("Me", "me@home.net"),
];
const LABELS = ["Inbox", "inbox", "Sent", "work", "Projects", "projects", "rare", "Żółć"];
const ACCOUNTS = ["acc1", "acc2", "acc3"];
const HOUR = 3_600_000;

function buildMessages(): MessageDocument[] {
  const r = rng(7);
  const docs: MessageDocument[] = [];
  const seqs = new Map<number, number>();
  const start = new Date(2018, 0, 1).getTime();
  const end = new Date(2026, 10, 1).getTime();
  for (let i = 0; i < 300; i++) {
    // Clustered: a fifth of the mailbox in the last month, the rest across eight years.
    let dateMs = r.chance(0.2)
      ? end - r.int(30 * 24) * HOUR
      : start + Math.floor(r.next() * (end - start));
    // Some sit on local midnights, where day bounds are decided.
    if (r.chance(0.1)) dateMs = new Date(new Date(dateMs).setHours(0, 0, 0, 0)).getTime();
    const seq = seqs.get(dateMs) ?? 0;
    seqs.set(dateMs, seq + 1);
    const words = (n: number) =>
      Array.from({ length: n }, () =>
        r.chance(0.7) ? r.pick(BASE_WORDS) : r.pick(EXTRA_WORDS),
      ).join(" ");
    const labelCount = r.int(4);
    const message: Message = makeMessage({
      dateMs,
      seq,
      providerId: `d${i}`,
      accountId: r.pick(ACCOUNTS),
      from: r.pick(PEOPLE),
      to: Array.from({ length: r.int(3) }, () => r.pick(PEOPLE)),
      cc: Array.from({ length: r.int(2) }, () => r.pick(PEOPLE)),
      subject: words(1 + r.int(4)),
      snippet: words(r.int(4)),
      flags: {
        seen: r.chance(0.6),
        flagged: r.chance(0.04),
        answered: r.chance(0.2),
        draft: r.chance(0.03),
      },
      labelIds: Array.from({ length: labelCount }, () =>
        r.chance(0.03) ? "rare" : r.pick(LABELS.filter((l) => l !== "rare")),
      ).filter((l, j, all) => all.indexOf(l) === j),
      hasAttachments: r.chance(0.2),
    });
    docs.push({ message, bodyText: words(3 + r.int(10)) });
  }
  return docs;
}

type Leaf = QueryNode;

function text(field: TextField, match: "prefix" | "phrase", value: string): Leaf {
  return { kind: "text", field, match, value: tokenize(value).join(" ") };
}

function randomTree(
  r: ReturnType<typeof rng>,
  depth: number,
  accountIds: readonly string[],
): QueryNode {
  if (depth > 0 && r.chance(0.55)) {
    const kind = r.pick(["and", "or", "not"] as const);
    if (kind === "not") return { kind, child: randomTree(r, depth - 1, accountIds) };
    const n = 2 + r.int(2);
    return {
      kind,
      children: Array.from({ length: n }, () => randomTree(r, depth - 1, accountIds)),
    };
  }
  const field = r.pick(["any", "any", "from", "to", "cc", "subject"] as const);
  switch (r.int(12)) {
    case 0:
    case 1:
    case 2: {
      const word = r.pick(ALL_WORDS);
      const folded = tokenize(word)[0] as string;
      return text(field, "prefix", folded.slice(0, 1 + r.int(folded.length)));
    }
    case 3: {
      const a = r.pick(ALL_WORDS);
      return text(field, "phrase", r.chance(0.5) ? `${a} ${r.pick(ALL_WORDS)}` : a);
    }
    case 4: {
      const p = r.pick(PEOPLE);
      return text(r.pick(["from", "to", "cc"] as const), "phrase", p.address.replace("@", " "));
    }
    case 5:
      return { kind: "label", value: tokenize(r.pick(LABELS))[0] as string };
    case 6:
      return {
        kind: "flag",
        flag: r.pick(["unread", "read", "starred", "replied", "draft"] as const),
      };
    case 7:
      return { kind: "attachment" };
    case 8:
      return r.chance(0.1)
        ? { kind: "or", children: [] }
        : {
            kind: "account",
            ids: ACCOUNTS.filter(() => r.chance(0.5)).concat(accountIds.slice(0, 0)),
          };
    default: {
      const ms = new Date(2018 + r.int(9), r.int(12), 1 + r.int(28)).getTime();
      return { kind: r.pick(["after", "before"] as const), ms };
    }
  }
}

const TEXTS = [
  "alpha",
  "alpha OR beta",
  "alpha -beta",
  "-alpha",
  "(alpha OR beta) -gamma is:unread",
  "label:rare",
  "label:rare alpha",
  "label:(rare OR work) -alpha",
  "is:starred",
  "is:starred alpha",
  "is:unread alpha OR beta",
  "alpha OR is:starred",
  "-alpha OR is:starred",
  "has:attachment -is:read after:2020-01-01",
  "from:me OR to:me",
  "account:acc1 alpha",
  "from:(jan OR anna) -subject:beta",
  "after:2019-01-01 before:2021-01-01 -label:inbox",
  "after:-30d alpha",
  "zolw lodz",
  "NOT alpha NOT beta",
];

describe("SQLite agrees with the in-memory index", () => {
  const db: Database = openDatabase(":memory:");
  const store = new SqliteMessageStore(db);
  const fake = new InMemorySearchIndex();
  // Five readers of the same table: default thresholds, prefixes left native, never a driver,
  // always a driver (even beside native prefixes), and always a driver without expansion.
  const base = { keys: 10_000, matchBudget: 500, expand: true };
  const variants = {
    default: new SqliteSearchIndex(db),
    native: new SqliteSearchIndex(db, { ...base, expand: false }),
    walk: new SqliteSearchIndex(db, { keys: -1, matchBudget: -1, expand: true }),
    driven: new SqliteSearchIndex(db, {
      keys: 1_000_000,
      matchBudget: Number.POSITIVE_INFINITY,
      expand: true,
    }),
    drivenNative: new SqliteSearchIndex(db, {
      keys: 1_000_000,
      matchBudget: Number.POSITIVE_INFINITY,
      expand: false,
    }),
  };
  const docs = buildMessages();
  let keys: number[] = [];
  let ready: Promise<void> | undefined;
  const setup = () =>
    (ready ??= (async () => {
      const result = await store.upsertMessages(docs.map((d) => d.message));
      const stored = docs.map((d, i) => ({
        ...d,
        message: { ...d.message, key: result.keys[i] as number },
      }));
      await variants.default.indexMessages(stored);
      await fake.indexMessages(stored);
      keys = stored.map((d) => d.message.key).sort((a, b) => b - a);
    })());
  afterAll(() => db.close());

  const context = {
    nowMs: new Date(2026, 10, 4, 12).getTime(),
    accounts: [
      { id: "acc1", address: "me@home.net", displayName: "Me" },
      { id: "acc2", address: "work@acme.org", displayName: "Work" },
    ],
  };

  async function chunks(
    index: SqliteSearchIndex,
    query: ParsedQuery,
    limit: number,
    beforeKey?: number,
  ): Promise<number[]> {
    const out: number[] = [];
    let cursor = beforeKey;
    for (let i = 0; i < 10_000; i++) {
      const chunk = await index.searchChunk(query, {
        limit,
        ...(cursor === undefined ? {} : { beforeKey: cursor }),
      });
      expect(chunk.keys.length).toBeLessThanOrEqual(limit);
      out.push(...chunk.keys);
      if (chunk.nextBeforeKey === undefined) return out;
      expect(cursor === undefined || chunk.nextBeforeKey < cursor).toBe(true);
      cursor = chunk.nextBeforeKey;
    }
    throw new Error("chunks never ended");
  }

  it("returns the same keys for 600+ random trees and parsed queries", async () => {
    await setup();
    const r = rng(20261104);
    const queries: { label: string; query: ParsedQuery }[] = [];
    for (const t of TEXTS) queries.push({ label: t, query: parseQuery(t, context) });
    for (let i = 0; i < 600; i++) {
      const root = randomTree(r, r.int(5), []);
      queries.push({ label: JSON.stringify(root), query: { root, tokens: [], diagnostics: [] } });
    }
    expect(queries.length).toBeGreaterThanOrEqual(500);

    let heavy = 0;
    let driven = 0;
    let nonEmpty = 0;
    for (const { label, query } of queries) {
      const expected = [...(await fake.search(query, { limit: 10_000 }))];
      if (expected.length > 0) nonEmpty++;
      for (const [name, index] of Object.entries(variants)) {
        expect(await index.search(query, { limit: 10_000 }), `${name}: ${label}`).toEqual(expected);
        const limit = 1 + (expected.length % 23);
        expect(await chunks(index, query, limit), `${name} chunks of ${limit}: ${label}`).toEqual(
          expected,
        );
      }
      // Pages and keyset continuation.
      const before = keys[(label.length * 7) % keys.length];
      const page = await variants.default.search(query, {
        limit: 9,
        ...(before === undefined ? {} : { beforeKey: before }),
      });
      const want = (await fake.search(query, {
        limit: 9,
        ...(before === undefined ? {} : { beforeKey: before }),
      })) as number[];
      expect(page, `page: ${label}`).toEqual(want);
      expect(await chunks(variants.walk, query, 5, before), `chunks below a key: ${label}`).toEqual(
        [
          ...(await fake.search(query, {
            limit: 10_000,
            ...(before === undefined ? {} : { beforeKey: before }),
          })),
        ],
      );

      const route = variants.default.describeRoute(query);
      if (route?.heavy) heavy++;
      if (route?.driver !== undefined) driven++;
    }
    // The generator has to reach the interesting plans, and matches, to mean anything.
    expect(heavy).toBeGreaterThan(50);
    expect(driven).toBeGreaterThan(20);
    expect(nonEmpty).toBeGreaterThan(200);
  }, 120_000);

  it("forces both kinds of heavy plans and the driven ones", async () => {
    await setup();
    const route = (q: string) => variants.default.describeRoute(parseQuery(q, context));
    expect(route("-alpha")?.heavy).toBe(true);
    expect(route("alpha OR is:starred")?.heavy).toBe(true);
    expect(route("alpha is:read")?.heavy).toBe(true);
    // A MATCH of exact terms (an expanded prefix) is driven by a rare filter, light.
    expect(route("alpha label:rare")).toMatchObject({ heavy: false, driver: 0 });
    // A native prefix (1 character, over 32, or expanding past the cap) is walked in windows.
    expect(route("f label:rare")).toMatchObject({ heavy: true, driver: undefined });
    expect(route("katalog label:rare")).toMatchObject({ heavy: true, driver: undefined });
    expect(route(`dlugie${"b".repeat(40)} label:rare`)).toMatchObject({ heavy: true });
    expect(route("alpha")).toMatchObject({ heavy: false, driver: undefined });
    expect(variants.native.describeRoute(parseQuery("alpha label:rare"))).toMatchObject({
      heavy: true,
      driver: undefined,
    });
    expect(variants.driven.describeRoute(parseQuery("f label:rare"))?.driver).toBe(0);
    expect(variants.walk.describeRoute(parseQuery("alpha label:rare"))?.driver).toBeUndefined();
    // Without a MATCH, a rare indexed filter drives; a dense one (forced) walks the table.
    expect(route("label:rare")).toMatchObject({ heavy: false, driver: 0 });
    expect(variants.walk.describeRoute(parseQuery("label:rare"))?.driver).toBeUndefined();
    expect(variants.driven.describeRoute(parseQuery("is:read label:rare"))?.driver).toBe(1);
    expect(variants.driven.describeRoute(parseQuery("alpha is:read"))?.driver).toBeUndefined();
  });
});
