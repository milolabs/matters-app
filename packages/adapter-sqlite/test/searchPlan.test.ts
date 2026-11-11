import { parseQuery } from "@matters/core";
import { makeDocument, makeMessage } from "@matters/testkit";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type Database,
  openDatabase,
  SqliteMessageStore,
  SqliteSearchIndex,
} from "../src/index.ts";
import {
  buildSql,
  chooseRoute,
  countSql,
  DEFAULT_DRIVER_LIMITS,
  type Expand,
  LONG_TERM_MARK,
  MAX_EXPANSION,
  type Param,
  planQuery,
  termEntry,
  toFts,
} from "../src/searchPlan.ts";

const db: Database = openDatabase(":memory:");
afterAll(() => db.close());

async function seed(): Promise<void> {
  const store = new SqliteMessageStore(db);
  const messages = Array.from({ length: 3000 }, (_, i) =>
    makeMessage({
      dateMs: Date.UTC(2024, 0, 1) + i * 60_000,
      providerId: `p${i}`,
      flags: { seen: i % 10 !== 0, flagged: i % 100 === 0, answered: false, draft: i % 500 === 0 },
      labelIds: i % 50 === 0 ? ["inbox", "rare"] : ["inbox"],
      hasAttachments: i % 20 === 0,
    }),
  );
  await store.upsertMessages(messages);
}

const plan = (text: string) => {
  const q = parseQuery(text, { accounts: [{ id: "acc1", address: "a@b.c", displayName: "A" }] });
  if (q.root === null) throw new Error("empty");
  return planQuery(q.root);
};

function explain(sql: string, params: readonly Param[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return rows.map((r) => r.detail).join("\n");
}

describe("plan SQL", () => {
  const fts = (text: string) => {
    const q = parseQuery(text);
    return q.root === null ? null : toFts(q.root);
  };

  it("writes FTS operators itself, parenthesised, with user text quoted", () => {
    expect(fts("alpha")).toBe('("alpha"*)');
    expect(fts("from:jan OR subject:beta")).toBe('((sender : "jan"*) OR (subject : "beta"*))');
    expect(fts('alpha -"x y" -from:z')).toBe('((("alpha"*)) NOT (("x y") OR (sender : "z"*)))');
    expect(fts("a b OR c")).toBe('((("a"*) AND ("b"*)) OR ("c"*))');
    expect(fts("-alpha")).toBeNull();
    expect(fts("alpha OR is:starred")).toBeNull();
    // Operator-looking text stays quoted words.
    expect(fts('NEAR(a b) "x" * ^')).toBe('(("near"*) AND ("a"*) AND ("b"*) AND ("x"))');
    expect(fts("alpha or beta")).toBe('(("alpha"*) AND ("or"*) AND ("beta"*))');
  });

  it("flattens the top-level AND into one MATCH, with top-level NOTs after it", () => {
    expect(plan("alpha (beta is:unread)").match?.params).toEqual(['("alpha"*) AND ("beta"*)']);
    expect(plan('alpha -beta -"c d"').match?.params).toEqual([
      '((("alpha"*)) NOT (("beta"*) OR ("c d")))',
    ]);
    // Only negations: each becomes a heavy NOT IN over FTS hits.
    const only = plan("-alpha -beta");
    expect(only.match).toBeNull();
    expect(only.conjs.map((c) => c.cond.sql)).toEqual([
      "m.key NOT IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ? AND rowid >= :lo AND rowid < :hi)",
      "m.key NOT IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ? AND rowid >= :lo AND rowid < :hi)",
    ]);
    expect(only.nestedFts).toBe(true);
  });

  it("turns top-level dates into key bounds, and nested ones into conditions", () => {
    const p = plan("alpha is:unread after:2024-01-02 before:2024-02-01");
    expect(p.conjs).toHaveLength(1);
    expect(p.lowKey).toBe(new Date(2024, 0, 2).getTime() * 1024);
    expect(p.highKey).toBe(new Date(2024, 1, 1).getTime() * 1024);
    expect(plan("alpha (after:2024-01-02 OR is:unread)").conjs[0]?.cond.sql).toBe(
      "(m.key >= ? OR m.flags & 1 = 0)",
    );
  });

  it("uses the exact text the partial indexes are declared with", () => {
    expect(plan("is:unread").conjs[0]?.cond.sql).toBe("m.flags & 1 = 0");
    expect(plan("is:starred").conjs[0]?.cond.sql).toBe("m.flags & 2 = 2");
    expect(plan("is:draft").conjs[0]?.cond.sql).toBe("m.flags & 8 = 8");
    expect(plan("has:attachment").conjs[0]?.cond.sql).toBe("m.has_attachments = 1");
  });

  it("knows an impossible query without running it", () => {
    const bare = (text: string) => {
      const q = parseQuery(text);
      return q.root === null ? null : planQuery(q.root);
    };
    expect(bare("from:me")?.empty).toBe(true);
    expect(bare("alpha from:me")?.empty).toBe(true);
    expect(bare("alpha after:2025-01-01 before:2024-01-01")?.empty).toBe(true);
    expect(bare("-from:me alpha")?.empty).toBe(false);
    expect(bare("alpha OR from:me")?.empty).toBe(false);
  });
});

describe("plans use the indexes through alias m", () => {
  it("counts every indexed conjunct from its own index", async () => {
    await seed();
    const cases: [string, string][] = [
      ["is:unread", "messages_unread"],
      ["is:starred", "messages_starred"],
      ["is:draft", "messages_draft"],
      ["has:attachment", "messages_attachments"],
      ["label:rare", "message_labels_fold"],
      ["account:a", "messages_account"],
    ];
    for (const [text, index] of cases) {
      const conj = plan(text).conjs[0];
      expect(conj?.keys, text).toBeDefined();
      if (!conj?.keys) continue;
      const detail = explain(countSql(conj.keys), [...conj.keys.params, 10]);
      expect(detail, text).toContain(index);
      expect(detail, text).not.toMatch(/SCAN d\b(?! USING)/);
    }
  });

  it("drives a rare filter through its index in the full query", async () => {
    await seed();
    const pick = (text: string, driver: number | undefined) => {
      const p = plan(text);
      const route = { driver, heavy: false };
      const { sql, params } = buildSql(p, route, { lower: 0, upper: 2 ** 52, limit: 50 });
      return explain(sql, params);
    };
    // Without FTS: m.key IN (index) walks the index, not the table.
    expect(pick("label:rare", 0)).toContain("message_labels_fold");
    expect(pick("label:rare", 0)).not.toMatch(/SCAN m\b(?! USING)/);
    expect(pick("is:starred", 0)).toContain("messages_starred");
    expect(pick("is:unread is:starred", 1)).toContain("messages_starred");
    // The residual of a MATCH walk uses the same indexes.
    expect(pick("alpha label:rare", undefined)).toContain("message_labels_fold");
    // The residual condition of a table walk uses the label index too.
    expect(pick("is:read label:rare", undefined)).toContain("message_labels_fold");
  });

  it("picks the rarest and measures only when there is a choice", async () => {
    await seed();
    const p = plan("is:unread is:starred label:rare");
    const index = new SqliteSearchIndex(db);
    const q = parseQuery("is:unread is:starred label:rare");
    const route = index.describeRoute(q);
    expect(route?.driver).toBe(p.conjs.findIndex((c) => c.cond.sql.includes("flags & 2")));
    // No indexed conjunct: nothing to probe, and a table walk is heavy.
    expect(chooseRoute(plan("is:read"), new Map())).toEqual({ driver: undefined, heavy: true });
    // A MATCH on a native prefix (no expansion here) never has a driver, however rare the filter:
    // rowid IN rebuilds the prefix's doclist per row.
    expect(chooseRoute(plan("alpha label:rare"), new Map([[0, 3]]))).toEqual({
      driver: undefined,
      heavy: true,
    });
    expect(chooseRoute(plan("alpha"), new Map())).toEqual({ driver: undefined, heavy: false });
    const { sql } = buildSql(
      plan("alpha is:starred"),
      { driver: undefined, heavy: true },
      {
        lower: 0,
        upper: 1,
        limit: 5,
      },
    );
    expect(sql).not.toMatch(/rowid IN/);
    // ...and it does not measure anything either.
    const prepared = vi.spyOn(db, "prepare");
    await new SqliteSearchIndex(db).searchChunk(parseQuery("alpha is:starred"), { limit: 5 });
    expect(prepared.mock.calls.map(([sqlText]) => sqlText).join("\n")).not.toContain("COUNT(*)");
    prepared.mockRestore();
    // A dense indexed one stays a plain walk.
    expect(chooseRoute(plan("is:unread"), new Map([[0, 10_001]]))).toEqual({
      driver: undefined,
      heavy: false,
    });
  });
});

describe("prefix expansion", () => {
  const forms: Record<string, readonly string[]> = {
    faktu: ["faktura", "faktury", "fakturze"],
    umow: ["umowa"],
    wide: Array.from({ length: MAX_EXPANSION + 1 }, (_, i) => `wide${i}`),
    exact: Array.from({ length: MAX_EXPANSION }, (_, i) => `exact${i}`),
    dirty: ["ok", 'bad"term', "x*"],
    marked: ["marked1", `marked${LONG_TERM_MARK}`],
    none: [],
  };
  const expand: Expand = (prefix) => forms[prefix] ?? null;
  const fts = (text: string) => {
    const q = parseQuery(text);
    return q.root === null ? null : toFts(q.root, expand);
  };

  it("turns a prefix of 4 to 32 characters into an OR of quoted exact terms", () => {
    expect(fts("faktu")).toBe('(("faktura" OR "faktury" OR "fakturze"))');
    expect(fts("umow")).toBe('("umowa")');
    expect(fts("from:faktu")).toBe('(sender : ("faktura" OR "faktury" OR "fakturze"))');
    expect(fts("subject:faktu")).toBe('(subject : ("faktura" OR "faktury" OR "fakturze"))');
    expect(fts("faktu OR umow")).toBe('((("faktura" OR "faktury" OR "fakturze")) OR ("umowa"))');
    expect(fts("faktu -umow")).toBe('(((("faktura" OR "faktury" OR "fakturze"))) NOT (("umowa")))');
    expect(fts("exact")?.match(/ OR /g)).toHaveLength(MAX_EXPANSION - 1);
  });

  it("keeps the native prefix where expansion does not apply", () => {
    expect(fts("fa")).toBe('("fa"*)');
    expect(fts("fak")).toBe('("fak"*)');
    expect(fts("f")).toBe('("f"*)');
    // Over the cap, unknown, empty, not clean, or meeting the mark of a longer word.
    for (const word of ["wide", "dirty", "marked", "none", "unknown"]) {
      expect(fts(word), word).toBe(`("${word}"*)`);
    }
    // Over 32 characters.
    const long = "a".repeat(33);
    expect(fts(long)).toBe(`("${long}"*)`);
    // A phrase is exact already and a plain prefix check never asks for it.
    expect(fts('"faktu"')).toBe('("faktu")');
    expect(toFts(parseQuery("faktu").root as never)).toBe('("faktu"*)');
  });

  it("applies in nested subqueries and negations too", () => {
    const q = parseQuery("faktu OR is:starred");
    const p = planQuery(q.root as never, expand);
    expect(p.nestedFts).toBe(true);
    expect(p.conjs[0]?.cond.params[0]).toBe('(("faktura" OR "faktury" OR "fakturze"))');
    const only = planQuery(parseQuery("-faktu").root as never, expand);
    expect(only.conjs[0]?.cond.params[0]).toBe('(("faktura" OR "faktury" OR "fakturze"))');
  });

  it("weighs a MATCH by what a row costs", () => {
    const w = (text: string) => planQuery(parseQuery(text).root as never, expand).matchWeight;
    expect(w('"a b"')).toBe(1);
    expect(w("umow")).toBe(1);
    expect(w("faktu")).toBe(3);
    expect(w("fa")).toBe(12);
    expect(w("faktu fa")).toBe(15);
    expect(w("faktu -umow")).toBe(4);
    expect(w("f")).toBe(Number.POSITIVE_INFINITY);
    expect(w("wide")).toBe(Number.POSITIVE_INFINITY);
    expect(w("umow f")).toBe(Number.POSITIVE_INFINITY);
  });

  it("drives a MATCH only while rows times weight fit the budget", () => {
    const route = (text: string, rows: number | undefined) =>
      chooseRoute(
        planQuery(parseQuery(text).root as never, expand),
        rows === undefined ? new Map() : new Map([[0, rows]]),
        DEFAULT_DRIVER_LIMITS,
      );
    // weight 3: 166 rows fit, 167 do not
    expect(route("faktu is:starred", 166)).toEqual({ driver: 0, heavy: false });
    expect(route("faktu is:starred", 167)).toEqual({ driver: undefined, heavy: true });
    // weight 12 (2-char prefix): 41 rows
    expect(route("fa is:starred", 41)).toEqual({ driver: 0, heavy: false });
    expect(route("fa is:starred", 42)).toEqual({ driver: undefined, heavy: true });
    // a native unindexed prefix never drives
    expect(route("f is:starred", undefined)).toEqual({ driver: undefined, heavy: true });
    expect(route("wide is:starred", undefined)).toEqual({ driver: undefined, heavy: true });
    // an unindexed filter has no rows to count: a walk, in windows
    expect(route("faktu is:read", undefined)).toEqual({ driver: undefined, heavy: true });
    // a nested FTS subquery stays heavy even when driven
    expect(route("faktu is:starred (umow OR is:draft)", 5).heavy).toBe(true);
  });

  it("probes only when a driver could be afforded", async () => {
    const real = new SqliteSearchIndex(db);
    await real.indexMessages([makeDocument({ subject: "alpha beta", providerId: "probe-doc" })]);
    const prepared = vi.spyOn(db, "prepare");
    const probes = () =>
      prepared.mock.calls.map(([sql]) => sql as string).filter((sql) => sql.includes("COUNT(*)"));
    await real.searchChunk(parseQuery("f is:starred"), { limit: 5 });
    await real.searchChunk(parseQuery("alpha"), { limit: 5 });
    await real.searchChunk(parseQuery("alpha is:read"), { limit: 5 });
    expect(probes()).toEqual([]);
    await real.searchChunk(parseQuery("alpha is:starred"), { limit: 5 });
    expect(probes()).toHaveLength(1);
    prepared.mockRestore();
  });

  it("builds a driven MATCH on rowid IN, and the filter's index is used", async () => {
    await seed();
    const p = planQuery(parseQuery("faktu label:rare").root as never, expand);
    const route = chooseRoute(p, new Map([[0, 10]]));
    expect(route.driver).toBe(0);
    const { sql, params } = buildSql(p, route, { lower: 0, upper: 2 ** 52, limit: 50 });
    expect(sql).toContain("message_fts.rowid IN (SELECT l.message_key FROM message_labels l");
    expect(explain(sql, params)).toContain("message_labels_fold");
  });

  it("never lets user text out of its quotes, whatever the input", () => {
    const hostileForms: Expand = () => ["fine", 'x" OR "y', "a) OR (b"];
    const clean = /^[\p{L}\p{N} ]+$/u;
    for (const text of [
      '"unbalanced',
      "NEAR(a b, 2) OR NOT x*",
      'from:(a OR b) -subject:"c d" faktu*',
      '-"; DROP TABLE messages;--" abcd',
      'abcd" OR "zzzz',
      "(((abcd))) OR ((efgh",
    ]) {
      const q = parseQuery(text);
      if (q.root === null) continue;
      const p = planQuery(q.root, hostileForms);
      const strings = [
        ...(p.match?.params ?? []),
        ...p.conjs.flatMap((c) => c.cond.params.filter((x) => typeof x === "string")),
      ] as string[];
      for (const match of strings) {
        if (!match.includes('"')) continue;
        // Remove every quoted run; only our own syntax may be left.
        const rest = match.replace(/"[^"]*"\*?/gu, "");
        expect(rest, match).toMatch(
          /^[ ()]*((AND|OR|NOT|sender|recipients|cc|subject|:)[ ()]*)*$/u,
        );
        for (const quoted of match.match(/"[^"]*"/gu) ?? []) {
          expect(quoted.slice(1, -1), match).toMatch(clean);
        }
      }
    }
  });

  it("stores a token as it is up to 32 characters, and a longer one as a marked head", () => {
    expect(termEntry("abc")).toBeNull();
    expect(termEntry("abcd")).toBe("abcd");
    expect(termEntry("a".repeat(32))).toBe("a".repeat(32));
    expect(termEntry("a".repeat(33))).toBe(`${"a".repeat(32)}${LONG_TERM_MARK}`);
    expect(termEntry("b".repeat(80))).toBe(`${"b".repeat(32)}${LONG_TERM_MARK}`);
  });
});
